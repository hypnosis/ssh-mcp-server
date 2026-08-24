/**
 * Single install point for placing a file or directory at its destination.
 *
 * Every appearance of data on a live path goes through it — both on the
 * server and locally on download. It rests on one invariant:
 *
 *   A whole copy exists at every point in time. Nothing is deleted until
 *   the replacement has succeeded. The error handler never touches the
 *   last remaining copy.
 *
 * Hence the order of work: data is always written next to the target under
 * a temporary name, verified there, and moved into place with a single
 * rename. Anything that fails before that rename cleans up only the
 * temporary path. Anything that fails after it is already a warning, not
 * a failure: the replacement has taken effect.
 *
 * The protocol itself does not know where the data lives. File operations
 * come from outside: transport commands on the server, plain fs locally.
 */

import { logger } from '../utils/logger.js';
import { buildBackupPath, buildTempPath, isArtifactOf } from '../utils/tmp-name.js';

export type PathKind = 'file' | 'directory' | 'symlink' | 'missing';

/**
 * Outcome of a mount-point check. `unknown` means the server did not answer
 * with device numbers: there was nothing to check with, which is not the
 * same as a checked "not a mount point".
 */
export type MountCheck = 'separate' | 'same' | 'unknown';

/** File operations the protocol is built from */
export interface PathOps {
  /**
   * What currently sits at the path. A symlink is a distinct kind: a broken
   * link is invisible to both `test -e` and `test -d`, and without this
   * distinction the replacement would fail with a baffling "path does not
   * exist".
   */
  inspect(path: string): Promise<PathKind>;
  /** Create the parent directory if it does not exist */
  ensureParent(path: string): Promise<void>;
  /**
   * Rename. Must behave like `mv -T`: never nest into an occupied target,
   * refuse instead. Plain `mv` of a directory onto a directory nests it
   * inside and reports success, on both BusyBox and coreutils.
   */
  rename(from: string, to: string): Promise<void>;
  /** Remove the path entirely */
  removeTree(path: string): Promise<void>;
  /** Whether the path sits on a separate filesystem (a mount point) */
  isSeparateFilesystem?(path: string): Promise<MountCheck>;
  /**
   * Paths in the directory that resemble our temporary names.
   *
   * Needed only to report them to a human: they cannot be cleaned up
   * automatically, because the name alone cannot tell a stray leftover
   * apart from another call's temporary path that is filling in right now.
   */
  listArtifacts?(directory: string): Promise<ArtifactScan>;
}

/** What was found next to the target, and whether the list is complete */
export interface ArtifactScan {
  paths: string[];
  /** The server's response was cut off at the limit: there may be more leftovers */
  truncated?: boolean;
}

export interface InstallPlan {
  /** The path the caller asked for */
  finalPath: string;
  kind: 'file' | 'directory';
  /**
   * Write the data to a temporary path.
   *
   * `existing` is what the survey found at the target: staging that keeps
   * part of the target has to know whether there is anything to keep.
   */
  stage: (stagingPath: string, existing: PathKind) => Promise<void>;
  /** Verify the temporary path before the replacement: a rejection reason, or null */
  verify?: (stagingPath: string) => Promise<string | null>;
  /**
   * Permissions and ownership after the replacement; a failure here does not
   * undo it. What could not be applied comes back as warnings rather than
   * through a variable the caller keeps outside: a value written from inside
   * a callback is read as an answer even when the callback never ran.
   */
  finalize?: (finalPath: string) => Promise<string[] | void>;
}

export interface InstallOutcome {
  path: string;
  /** What went wrong after the replacement had already taken effect */
  warnings: string[];
}

export class InstallError extends Error {
  /**
   * What a human must read alongside the failure: where their data ended
   * up. Without this field, a warning like "the live path is empty, the
   * copy sits next to it at X" would be lost in exactly the case it was
   * written for.
   */
  readonly warnings: string[];

  constructor(message: string, warnings: string[] = [], cause?: unknown) {
    super(warnings.length > 0 ? `${message} — ${warnings.join('; ')}` : message, { cause });
    this.name = 'InstallError';
    this.warnings = warnings;
  }
}

/**
 * Put data in place.
 *
 * Returns warnings instead of swallowing them: "the file was replaced but
 * permissions did not apply" is a different answer than "everything
 * succeeded", and different again from "the operation failed".
 */
export async function install(ops: PathOps, plan: InstallPlan): Promise<InstallOutcome> {
  const warnings: string[] = [];

  // prepare: survey the target. Anything wrong here is a rejection before
  // a single change hits disk
  const existing = await ops.inspect(plan.finalPath);

  // Leftovers from past operations: name them and leave them untouched
  const leftovers = await findLeftovers(ops, plan.finalPath);
  if (leftovers.paths.length > 0) {
    warnings.push(describeLeftovers(leftovers.paths, plan.finalPath, existing));
  }
  if (leftovers.truncated) warnings.push(TRUNCATED_SCAN_NOTE);

  if (existing === 'symlink') {
    throw new InstallError(
      `the target is a symbolic link: ${plan.finalPath}. ` +
      'Point the path at the file or directory it leads to, or remove the link first.',
      warnings
    );
  }

  // The target's kind must match what we're installing: otherwise the
  // rename would silently nest one inside the other and report success
  if (existing !== 'missing' && existing !== plan.kind) {
    throw new InstallError(
      `cannot install ${plan.kind} over an existing ${existing}: ${plan.finalPath}`,
      warnings
    );
  }

  // A mount point cannot be replaced by rename: the old path would first
  // have to be wiped, which is exactly the `rm -rf` we are avoiding
  if (existing !== 'missing' && ops.isSeparateFilesystem) {
    const mount = await ops.isSeparateFilesystem(plan.finalPath);
    if (mount === 'separate') {
      throw new InstallError(
        `the target is a mount point: ${plan.finalPath}. ` +
        'Replacing it by rename is not possible; write into a directory inside the volume instead.',
        warnings
      );
    }
    if (mount === 'unknown') warnings.push(uncheckedMountNote(plan.finalPath));
  }

  await ops.ensureParent(plan.finalPath);
  const staging = buildTempPath(plan.finalPath.replace(/\/+$/, ''));

  // stage, verify, and permissions: anything that fails here takes only
  // staging down with it. Permissions are set before the replacement —
  // otherwise the live path would have a window where the data already
  // lives there but access to it is still wrong
  try {
    await plan.stage(staging, existing);

    if (plan.verify) {
      const reason = await plan.verify(staging);
      if (reason) throw new InstallError(`verification failed for ${plan.finalPath}: ${reason}`);
    }

    if (plan.finalize) {
      const notes = await plan.finalize(staging);
      if (notes) warnings.push(...notes);
    }
  } catch (error) {
    await discard(ops, staging);
    throw warnings.length > 0
      ? new InstallError(message(error), warnings, error)
      : error;
  }

  // commit: the operation has taken effect from the first successful rename onward
  const committed = await commit(ops, plan, existing, staging, warnings);
  if (!committed.ok) {
    // staging may be discarded only while the live path is still intact. If
    // the rollback failed, staging is one of the two remaining copies and
    // must not be touched
    if (committed.lastCopyAtRisk) {
      throw new InstallError(committed.error.message, warnings);
    }

    await discard(ops, staging);
    throw warnings.length > 0
      ? new InstallError(committed.error.message, warnings)
      : committed.error;
  }

  return { path: plan.finalPath, warnings };
}

type CommitResult =
  | { ok: true }
  /** lastCopyAtRisk — the rollback failed: the live path is empty, cleanup is forbidden */
  | { ok: false; error: Error; lastCopyAtRisk?: boolean };

/**
 * Put staging in place of the target.
 *
 * A file over a file, or an install onto an empty spot, is a single atomic
 * rename. A directory over a directory cannot be replaced by rename, so the
 * old one is first moved aside under a unique name and removed only after
 * the replacement has succeeded.
 */
async function commit(
  ops: PathOps,
  plan: InstallPlan,
  existing: PathKind,
  staging: string,
  warnings: string[]
): Promise<CommitResult> {
  if (!(existing === 'directory' && plan.kind === 'directory')) {
    try {
      await ops.rename(staging, plan.finalPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  }

  const backup = buildBackupPath(plan.finalPath);

  try {
    await ops.rename(plan.finalPath, backup);
  } catch (error) {
    return { ok: false, error: await explainRace(ops, plan.finalPath, 'gone', error) };
  }

  // The live path is empty between these two renames — there is no room
  // here for cancellation or checks: stopping now would leave that emptiness in place
  try {
    await ops.rename(staging, plan.finalPath);
  } catch (error) {
    const restored = await restore(ops, backup, plan.finalPath, warnings);
    return {
      ok: false,
      error: await explainRace(ops, plan.finalPath, 'taken', error),
      lastCopyAtRisk: !restored,
    };
  }

  // Past the point of no return: an unremoved old copy is now a warning, not a failure
  try {
    await ops.removeTree(backup);
  } catch (error) {
    warnings.push(`the previous copy is still on the server at ${backup}: ${message(error)}`);
  }

  return { ok: true };
}

/**
 * Describe a failed replacement in the caller's own words, not the utility's output.
 *
 * A target that vanished or got taken between the survey and the replacement
 * means one thing: something else was writing to the same path. We ask the
 * server rather than parse the error text: the toolset and message language
 * differ across servers.
 */
async function explainRace(
  ops: PathOps,
  finalPath: string,
  expected: 'gone' | 'taken',
  error: unknown
): Promise<Error> {
  const now = await ops.inspect(finalPath).catch(() => undefined);
  if (now === undefined) return toError(error);

  const raced = expected === 'gone' ? now === 'missing' : now !== 'missing';
  if (!raced) return toError(error);

  return new Error(
    expected === 'gone'
      ? `${finalPath} was moved away by another install into the same path while this one was ` +
        `replacing it. Nothing was changed by this install. Details: ${message(error)}`
      : `${finalPath} was taken by another install into the same path while this one was ` +
        `replacing it. The prepared copy was not put in place. Details: ${message(error)}`
  );
}

/** Move the set-aside copy back into place if the replacement failed */
async function restore(
  ops: PathOps,
  backup: string,
  finalPath: string,
  warnings: string[]
): Promise<boolean> {
  try {
    await ops.rename(backup, finalPath);
    return true;
  } catch (error) {
    // The worst outcome: the live path is empty and the copy sits next to
    // it. Silence is not an option — this is the only thing that lets a
    // human move the data back by hand
    warnings.push(
      `${finalPath} is empty; the previous copy is intact at ${backup} and must be moved back manually: ${message(error)}`
    );
    return false;
  }
}

/** There was nothing to check the mount point with: don't pass an unchecked result off as checked */
function uncheckedMountNote(path: string): string {
  return (
    `whether ${path} is a mount point could not be checked: the server did not answer with ` +
    'device numbers. If it is one, the rename will refuse the replacement and nothing will be changed.'
  );
}

/** The leftover listing came back incomplete: staying silent about that would pass off a fragment as the whole */
const TRUNCATED_SCAN_NOTE =
  'the directory listing was cut off at the output limit, so this search for leftovers ' +
  'is incomplete: there may be more of them next to the target.';

/**
 * Find our temporary paths from past operations next to the target.
 *
 * Read-only. If the listing fails, treat it as nothing found: a note about
 * leftovers is not worth letting it fail the install itself.
 */
async function findLeftovers(ops: PathOps, finalPath: string): Promise<ArtifactScan> {
  if (!ops.listArtifacts) return { paths: [] };

  const trimmed = finalPath.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const directory = lastSlash > 0 ? trimmed.slice(0, lastSlash) : lastSlash === 0 ? '/' : '.';
  const base = trimmed.slice(lastSlash + 1);

  try {
    const found = await ops.listArtifacts(directory);
    return {
      paths: found.paths.filter((path) =>
        isArtifactOf(path.slice(path.lastIndexOf('/') + 1), base)
      ),
      truncated: found.truncated,
    };
  } catch {
    return { paths: [] };
  }
}

/**
 * Report a find in a way that lets a human decide for themselves.
 *
 * We don't touch them: the name alone cannot tell a stray leftover apart
 * from another call's temporary path that is writing data there right now.
 * So the response carries the addresses and a ready-made command, and the
 * decision stays with the human.
 */
function describeLeftovers(leftovers: string[], finalPath: string, existing: PathKind): string {
  const paths = leftovers.map((path) => `'${path}'`).join(' ');

  // An empty target next to a set-aside copy is the trace of a process
  // killed between the two renames. In that case what's next to it is the
  // last whole copy of the data, and that's a different conversation than
  // "clean up your junk"
  if (existing === 'missing') {
    return (
      `${finalPath} did not exist before this install, but leftovers from an interrupted ` +
      `operation are next to it: ${paths}. They were not touched. If those are your data, ` +
      `put them back yourself: mv -T ${leftovers.map((path) => `'${path}'`).join(' ')} '${finalPath}'`
    );
  }

  return (
    `leftovers from an interrupted operation are next to the target and were left untouched: ` +
    `${paths}. Remove them yourself once you are sure no other transfer is using them: rm -rf ${paths}`
  );
}

/**
 * Remove the temporary path; a failed cleanup does not change the operation's outcome.
 *
 * We still leave a trace in the log: without it the error would vanish
 * silently, and a path we declared removed could remain on the server.
 */
async function discard(ops: PathOps, staging: string): Promise<void> {
  await ops.removeTree(staging).catch((error: unknown) => {
    logger.warn(`[Installer] could not remove the temporary path ${staging}: ${message(error)}`);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
