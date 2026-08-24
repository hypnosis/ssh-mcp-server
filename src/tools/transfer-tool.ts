/**
 * Transfer Tool
 * scp-based binary-safe file/directory upload & download
 * with sha256 verification and atomic rename semantics.
 *
 * - ssh_upload   — upload a file or directory; verify via sha256; atomic rename.
 * - ssh_download — download a file or directory via scp (binary-safe).
 *
 * Heredoc / cat>file / base64-chunks are intentionally NOT used here.
 * For sudo writes into protected paths, the file travels to /tmp under the
 * SSH user, is copied next to the target under sudo and takes the target
 * path by rename.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { WRITES_REMOTE } from './annotations.js';
import { PROFILE_PARAM_DESCRIPTION } from './params.js';
import { stat } from 'fs/promises';
import { join, posix as posixPath } from 'path';
import { logger } from '../utils/logger.js';
import { CallerError, toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { sha256OfFile, sha256OfFiles } from '../utils/sha256.js';
import { listTreeFiles } from '../utils/local-tree.js';
import {
  mismatchOf,
  verifyRemoteFiles,
  VerificationMismatchError,
  type VerifyEntry,
} from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { localPathOps } from '../managers/local-path-ops.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath } from '../managers/path-guard.js';
import { buildSudoStagingPath, buildTempPath } from '../utils/tmp-name.js';
import { shellMode, shellOwner, shellQuote } from '../utils/shell-arg.js';
import { requireText } from '../utils/tool-args.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import {
  FILES_OUTPUT_SCHEMA,
  filesSummary,
  mismatchedFile,
  OWNER_NEEDS_SUDO,
  transferredFile,
} from './transfer-output.js';

interface UploadFileResult {
  remote_path: string;
  bytes: number;
  sha256?: string;
  verified: boolean;
  /** Why verification did not happen — when it did not happen */
  verifyNote?: string;
  atomic: boolean;
  sudo: boolean;
  /** What happened after the data was already in place */
  warnings?: string[];
}

interface UploadDirResult extends UploadFileResult {
  files_uploaded: number;
  /** The target's own files were kept: asked for by merge, and there was something to keep */
  merged: boolean;
}

/**
 * Local file stats — or a plain-language refusal.
 *
 * A raw Node exception (`ENOENT: no such file or directory, stat '…'`) reads
 * like a tool failure, though it is an ordinary answer: there is no file at
 * the given path.
 */
async function statLocal(path: string) {
  try {
    return await stat(path);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new CallerError(`local_path does not exist: ${path}`);
    if (error?.code === 'EACCES') throw new Error(`local_path is not readable: ${path}`);
    throw error;
  }
}

/** Names of the files inside the tree, taken from the paths they were compared at */
function namesWithin(paths: string[], root: string): string[] {
  return paths.map((path) => posixPath.relative(root, path)).filter(Boolean);
}

/** The first few names, or nothing at all when a single file leaves no name to give */
function listed(names: string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, 5).join(', ');
  return ` (${shown})`;
}

/**
 * Append to the response whatever happened after a successful replace.
 *
 * These things can be neither reported as an error (the data is in place) nor
 * swallowed: a leftover old copy takes up disk space, and permissions that
 * did not apply change access.
 */
function formatWarnings(warnings: string[]): string {
  return warnings.length > 0 ? `\n  warnings:\n${warnings.map((w) => `    - ${w}`).join('\n')}` : '';
}

/**
 * The largest timeout Node's timer can wait for (~24.8 days).
 * Anything above that fires immediately — no longer "wait longer" but an
 * instant abort, so such values are read as "no limit".
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The transfer's ceiling, named by the caller.
 *
 * Not named — no ceiling. Named garbage — refuse before the first command on
 * the server: the schema's type guarantees nothing, `arguments` arrive as is.
 * A number as a string is accepted: some clients send it that way, and there
 * is no reason to reject a working input shape.
 *
 * Zero is rejected even though internally it means "no ceiling": the
 * neighboring `ssh_exec` reads that same zero as "use the default", and one
 * value carrying two opposite meanings on the same server is a trap. There is
 * exactly one way to say "don't limit it": omit the parameter.
 *
 * Infinity and anything past the timer's limit also mean "don't limit it":
 * such a value fires the timer immediately, so a literal reading would give
 * an instant abort instead of the requested "run longer".
 */
function parseTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || Number.isNaN(parsed) || parsed <= 0) {
    throw new CallerError(
      `timeout must be a positive number of milliseconds, got ${JSON.stringify(value)}. ` +
      'Omit the parameter to run without a limit.'
    );
  }

  if (parsed > MAX_TIMEOUT_MS) return undefined;

  return parsed;
}

/** ssh_upload arguments, matching its inputSchema */
interface UploadArgs {
  profile?: string;
  local_path?: unknown;
  remote_path?: unknown;
  mode?: unknown;
  recursive?: boolean;
  verify?: boolean;
  sudo?: boolean;
  owner?: unknown;
  overwrite?: boolean;
  merge?: boolean;
  timeout?: unknown;
}

/** ssh_download arguments, matching its inputSchema */
interface DownloadArgs {
  profile?: string;
  remote_path?: unknown;
  local_path?: unknown;
  recursive?: boolean;
  verify?: boolean;
  sudo?: boolean;
  timeout?: unknown;
}

/**
 * Wording both directions share.
 *
 * Upload and download answer the same three questions — is the copy checked,
 * how long may it run, what about a directory — and a second copy of the
 * answer drifts from the first.
 */
const VERIFY_PARAM = {
  type: 'boolean',
  description:
    'sha256 on both sides, per file. "unavailable" = no sha256 on the machine = delivered, not broken. ' +
    '"mismatched" fails the call and replaces nothing. Default: true',
  default: true,
} as const;

const RECURSIVE_PARAM = {
  type: 'boolean',
  description: 'Only to force it — a directory is recognised on its own.',
} as const;

const TIMEOUT_PARAM = {
  type: 'number',
  description:
    'Milliseconds. No ceiling by default — a transfer runs as long as it takes.',
} as const;

export class TransferTool {
  private executor: SSHExecutor;

  constructor() {
    this.executor = new SSHExecutor();
  }

  getTools(): Tool[] {
    return [
      {
        name: 'ssh_upload',
        annotations: { title: 'Upload to a server', ...WRITES_REMOTE },
        description:
          'Copies a local file or directory to a server, checked by sha256 on both sides and never left ' +
          'half-written at the target. A directory replaces the target whole — whatever was there and is ' +
          'not in the source is gone with it; merge: true keeps it instead. For text you can paste, ' +
          'ssh_file_write is cheaper; piping base64 through ssh_exec truncates silently.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: PROFILE_PARAM_DESCRIPTION },
            local_path: {
              type: 'string',
              description: 'A file or a directory on this machine.',
            },
            remote_path: {
              type: 'string',
              description:
                'Where it goes on the server. A sent directory becomes this path itself and replaces ' +
                'it whole, not file by file — with merge: true what the source lacks stays.',
            },
            mode: {
              type: 'string',
              description:
                'Octal, one value for every file sent. Omit to keep local permissions.',
            },
            recursive: RECURSIVE_PARAM,
            verify: VERIFY_PARAM,
            sudo: {
              type: 'boolean',
              description:
                'For /etc, /opt and the like, and for setting an owner. Data stages in /tmp first — the machine needs room for a second copy. Default: false',
              default: false,
            },
            owner: {
              type: 'string',
              description:
                '"root:root", every file and directory sent. Needs sudo; without it the answer says it was not applied.',
            },
            overwrite: {
              type: 'boolean',
              description:
                'false = refuse rather than replace, including when the target cannot be checked. ' +
                'A directory is judged whole, not per file. Default: true',
              default: true,
            },
            merge: {
              type: 'boolean',
              description:
                'Directories only. true = what the target holds and the source does not stays — ' +
                'uploads, .env, logs; same-named files are taken from the source. The tree is still ' +
                'put in place whole, by one rename. mode and owner then cover the kept files too. ' +
                'Default: false',
              default: false,
            },
            timeout: TIMEOUT_PARAM,
          },
          required: ['profile', 'local_path', 'remote_path'],
        },
        outputSchema: FILES_OUTPUT_SCHEMA,
      },
      {
        name: 'ssh_download',
        annotations: { title: 'Download from a server', ...WRITES_REMOTE },
        description:
          'Copies a file or directory from a server to this machine, checked by sha256 on both sides. ' +
          'To read a text file rather than keep it, ssh_file_read skips the disk.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: PROFILE_PARAM_DESCRIPTION },
            remote_path: { type: 'string', description: 'What to fetch from the server.' },
            local_path: { type: 'string', description: 'Where it lands on this machine.' },
            recursive: RECURSIVE_PARAM,
            verify: VERIFY_PARAM,
            sudo: {
              type: 'boolean',
              description:
                'For /root and the like. A root copy stages in /tmp, is fetched and removed — the machine needs room. Default: false',
              default: false,
            },
            timeout: TIMEOUT_PARAM,
          },
          required: ['profile', 'remote_path', 'local_path'],
        },
        outputSchema: FILES_OUTPUT_SCHEMA,
      },
    ];
  }

  async handleCall(request: CallToolRequest): Promise<ToolResult> {
    const toolName = request.params.name;
    try {
      switch (toolName) {
        case 'ssh_upload':
          return await this.handleUpload(request);
        case 'ssh_download':
          return await this.handleDownload(request);
        default:
          throw new Error(`Unknown transfer tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      const mismatch = mismatchOf(error);
      if (mismatch) {
        return toolFailure(
          error,
          filesSummary([
            mismatchedFile(
              mismatch.path,
              `${mismatch.differing} of ${mismatch.total} file(s) differ from the source` +
                listed(mismatch.names)
            ),
          ])
        );
      }
      return toolFailure(error);
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_upload
  // ---------------------------------------------------------------------------

  private async handleUpload(request: CallToolRequest) {
    const args = (request.params.arguments ?? {}) as UploadArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    // Mode and owner are validated before the first touch of the server: both
    // travel into the command as separate words, where quotes would not hold them
    const mode = args.mode ? shellMode(args.mode, 'mode') : undefined;
    const owner = args.owner ? shellOwner(args.owner, 'owner') : undefined;
    const timeoutMs = parseTimeoutMs(args.timeout);

    // The tilde is expanded on our side, before the first command. After that
    // the path travels only in single quotes, where `~` is an ordinary
    // character: the transfer itself expands it (scp hands the path to the
    // shell), but verification, cleanup and directory creation do not. Left
    // unexpanded, the file would land in the home directory, verification
    // would not find it there, the response would falsely report a mismatch,
    // staging would remain on the server, and a directory literally named
    // "~" would appear next to it. Access rules are applied right here — to
    // the expanded path, i.e. to where the write actually goes.
    const remotePath = requireText(args.remote_path, 'remote_path', '"/opt/app"');
    const localPath = requireText(args.local_path, 'local_path', '"./dist"');

    const target = await resolveRemotePath(this.executor, sshConfig, remotePath, {
      sudo: !!args.sudo,
    });

    const localStat = await statLocal(localPath);
    const isDir = args.recursive ?? localStat.isDirectory();

    if (isDir && !localStat.isDirectory()) {
      throw new Error(
        `local_path is not a directory but recursive=true: ${localPath}`
      );
    }

    // Both refusals name a caller's contradiction, and both are answered
    // before the first command: a single file has nothing to merge with, and
    // merging is writing into an occupied target, which overwrite: false forbids
    if (args.merge && !isDir) {
      throw new CallerError(
        `merge applies to directories only, and ${localPath} is a file. ` +
        'Drop merge, or send a directory.'
      );
    }

    if (args.merge && args.overwrite === false) {
      throw new CallerError(
        'merge and overwrite: false ask for opposite things: merging writes into the target ' +
        'that overwrite: false forbids touching. Pass one of them.'
      );
    }

    if (isDir) {
      const result = await this.uploadDirectory(
        sshConfig,
        localPath,
        target.path,
        {
          mode,
          verify: args.verify !== false,
          sudo: !!args.sudo,
          owner,
          overwrite: args.overwrite !== false,
          merge: args.merge === true,
          timeoutMs,
        }
      );
      return {
        content: [
          {
            type: 'text',
            text: this.formatUploadResult(result, true, target.warnings),
          },
        ],
        structuredContent: filesSummary([transferredFile(result.remote_path, result, result.bytes)]),
      };
    }

    const result = await this.uploadFile(
      sshConfig,
      localPath,
      target.path,
      {
        mode,
        verify: args.verify !== false,
        sudo: !!args.sudo,
        owner,
        overwrite: args.overwrite !== false,
        timeoutMs,
      }
    );
    return {
      content: [
        { type: 'text', text: this.formatUploadResult(result, false, target.warnings) },
      ],
      structuredContent: filesSummary([transferredFile(result.remote_path, result, result.bytes)]),
    };
  }

  /**
   * Upload response.
   *
   * The path printed is where the file actually landed: with `~` it differs
   * from what was requested. Warnings go into the same place — both the ones
   * the installer collected (an uncleaned old copy) and the ones that came up
   * while expanding the path; without this they would simply vanish.
   */
  private formatUploadResult(
    r: UploadFileResult | UploadDirResult,
    isDir: boolean,
    pathWarnings: string[] = []
  ): string {
    const lines: string[] = [];
    lines.push(`✓ Upload OK: ${r.remote_path}`);
    if (isDir) {
      lines.push(`  files: ${(r as UploadDirResult).files_uploaded}`);
    }
    lines.push(`  bytes: ${r.bytes}`);
    if (!r.verified) {
      lines.push(r.verifyNote ? `  sha256: skipped — ${r.verifyNote}` : `  sha256: skipped`);
    } else if (r.sha256) {
      lines.push(`  sha256: ${r.sha256} (verified)`);
    } else {
      // A directory has no single hash — all files matched together
      lines.push(`  sha256: verified (${(r as UploadDirResult).files_uploaded} files)`);
    }
    lines.push(`  atomic: ${r.atomic}`);
    // Said only when it happened: on an empty target merge has nothing to keep,
    // and a line about kept files would describe something that never took place
    if (isDir && (r as UploadDirResult).merged) {
      lines.push('  merged: true — files the source does not have were kept');
    }
    lines.push(`  sudo: ${r.sudo}`);
    return lines.join('\n') + formatWarnings([...pathWarnings, ...(r.warnings ?? [])]);
  }

  /**
   * Upload a single file.
   *
   * Both paths, plain and under sudo, go through the installer: data lands on
   * a staging path next to the target and takes its place by rename. The only
   * difference is how that staging path gets filled — a direct transfer, or a
   * copy from /tmp, because the transfer itself does not run as root.
   */
  private async uploadFile(
    sshConfig: any,
    localPath: string,
    remotePath: string,
    opts: {
      mode?: string;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      /** Transfer ceiling; without it the transfer runs as long as it takes */
      timeoutMs?: number;
    }
  ): Promise<UploadFileResult> {
    const localStats = await statLocal(localPath);
    const localHashPromise = opts.verify ? sha256OfFile(localPath) : null;

    if (!opts.overwrite) {
      const exists = await this.remoteExists(sshConfig, remotePath);
      if (exists === 'yes') {
        throw new Error(`remote_path already exists and overwrite=false: ${remotePath}`);
      }
      if (exists === 'unknown') {
        throw new Error(
          `cannot tell whether ${remotePath} already exists, and overwrite=false ` +
            'forbids writing over an unknown target. Retry, or pass overwrite: true.'
        );
      }
    }

    // One installer serves both paths; under sudo, only whose privileges the
    // commands run with and how the staging path gets filled differ
    const ops = remotePathOps({
      executor: this.executor,
      config: sshConfig,
      sudo: opts.sudo,
    });
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    const outcome = await install(ops, {
      finalPath: remotePath,
      kind: 'file',
      stage: async (staging) => {
        if (opts.sudo) {
          await this.stageUnderSudo(sshConfig, localPath, staging, opts.timeoutMs, !opts.mode);
          return;
        }
        await this.putFile(sshConfig, localPath, staging, opts.timeoutMs, !opts.mode);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          [{ path: staging, hash: await localHashPromise! }],
          'upload',
          remotePath,
          // under sudo the copy next to the target is no longer ours — there is no other way to read it
          { sudo: opts.sudo, timeoutMs: opts.timeoutMs, relativeTo: staging }
        );
        return null;
      },
      finalize: (staging) => this.applyOwnership(sshConfig, staging, opts),
    });

    return {
      remote_path: remotePath,
      bytes: localStats.size,
      sha256: opts.verify ? await localHashPromise! : undefined,
      ...verdict,
      atomic: true,
      sudo: opts.sudo,
      warnings: outcome.warnings,
    };
  }

  /**
   * Put a single file on the server.
   *
   * The parent directory is not created here: the staging path always sits
   * next to the target, and the installer has already created its directory
   * before the transfer starts. On the sudo path it is `/tmp` outright. An
   * extra command here would cost one round trip to the server per upload.
   */
  private async putFile(
    sshConfig: any,
    localPath: string,
    remotePath: string,
    timeoutMs?: number,
    preserveMode = false
  ): Promise<void> {
    const runner = await getRunner(sshConfig);
    await runner.upload(localPath, remotePath, { timeoutMs, preserveMode });
  }

  /**
   * Fill the staging path next to the target when only root can write there.
   *
   * The transfer runs as the connecting user into /tmp, and the file appears
   * next to the target as a sudo copy: the transport itself has no root
   * privileges. The intermediate file is removed either way.
   */
  private async stageUnderSudo(
    sshConfig: any,
    localPath: string,
    staging: string,
    timeoutMs?: number,
    preserveMode = false
  ): Promise<void> {
    const handoff = buildSudoStagingPath();
    await this.putFile(sshConfig, localPath, handoff, timeoutMs, preserveMode);

    try {
      // The named ceiling reaches this far too: copying the whole file scales
      // with its size
      await this.executor.executeChecked(
        sshConfig,
        `cp -p -- ${shellQuote(handoff)} ${shellQuote(staging)}`,
        { sudo: true, timeout: timeoutMs }
      );
    } finally {
      await this.executor
        .execute(sshConfig, `rm -f -- ${shellQuote(handoff)}`, {})
        .catch(() => undefined);
    }
  }

  /**
   * Fill the staging path with a whole tree the connecting user cannot write.
   *
   * The transport never runs as root, so the tree lands in /tmp first and is
   * copied next to the target from there. The handoff copy goes away whatever
   * happens: it is a full second copy of the data on a shared path.
   */
  private async stageTreeUnderSudo(
    sshConfig: SSHConfig,
    localDir: string,
    staging: string,
    timeoutMs?: number,
    preserveMode = false
  ): Promise<void> {
    const handoff = buildSudoStagingPath();
    const runner = await getRunner(sshConfig);
    await runner.upload(localDir, handoff, { recursive: true, preserveMode, timeoutMs });

    try {
      await this.executor.executeChecked(
        sshConfig,
        `cp -rp -- ${shellQuote(handoff)} ${shellQuote(staging)}`,
        { sudo: true, timeout: timeoutMs }
      );
    } finally {
      await this.executor
        .execute(sshConfig, `rm -rf -- ${shellQuote(handoff)}`, {})
        .catch(() => undefined);
    }
  }

  /**
   * Mode and owner on the staging path — before it becomes the target.
   *
   * Otherwise a window opens on the live path where the data is already
   * visible but access to it is still wrong. Owner applies only under sudo:
   * under a regular user `chown` refuses on a name that isn't its own.
   */
  private async applyOwnership(
    sshConfig: any,
    staging: string,
    opts: { mode?: string; owner?: string; sudo: boolean; recursive?: boolean; timeoutMs?: number }
  ): Promise<string[]> {
    // A tree is walked entirely: mode and owner named for a directory upload
    // speak about what lands in it, not about the folder alone
    const deep = opts.recursive ? '-R ' : '';

    if (opts.mode) {
      await this.executor.executeChecked(
        sshConfig,
        `chmod ${deep}${opts.mode} -- ${shellQuote(staging)}`,
        { sudo: opts.sudo, timeout: opts.timeoutMs }
      );
    }

    if (!opts.owner) return [];

    if (!opts.sudo) {
      // A named owner cannot be silently dropped: the file stays with whoever
      // wrote it, and the only way to notice is `ls -l` on the server
      return [OWNER_NEEDS_SUDO];
    }

    await this.executor.executeChecked(
      sshConfig,
      `chown ${deep}${opts.owner} -- ${shellQuote(staging)}`,
      { sudo: opts.sudo, timeout: opts.timeoutMs }
    );
    return [];
  }

  /**
   * Whether the path exists on the server. "Failed to check" is a separate
   * outcome: a failed check answering "no file" would let the
   * `overwrite: false` guard write over something it never managed to see.
   */
  private async remoteExists(
    sshConfig: any,
    remotePath: string
  ): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const r = await this.executor.execute(
        sshConfig,
        `test -e ${shellQuote(remotePath)} && echo YES || echo NO`,
        { idempotent: true }
      );
      const answer = r.stdout.trim();
      if (answer === 'YES') return 'yes';
      if (answer === 'NO') return 'no';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Verify the transferred data against the source.
   *
   * The three outcomes differ in kind: a mismatch is a transfer failure (we
   * throw), "nothing to verify with" is a success with a note. Mixing them up
   * means a server without sha256sum gets the same reaction as a corrupted
   * file, and the error handler goes on to delete what was just written.
   */
  private async verify(
    sshConfig: any,
    entries: VerifyEntry[],
    label: string,
    reportPath: string,
    opts: { sudo?: boolean; timeoutMs?: number; relativeTo: string }
  ): Promise<{ verified: boolean; verifyNote?: string }> {
    const { sudo = false, timeoutMs, relativeTo } = opts;
    // The ceiling applies to the whole operation, not one part of it:
    // otherwise a gigabyte-sized tree would run into the commands' shared
    // 30-second limit right here
    const outcome = await verifyRemoteFiles(this.executor, sshConfig, entries, {
      sudo,
      timeoutMs: timeoutMs ?? 0,
    });

    if (outcome.status === 'matched') return { verified: true };

    if (outcome.status === 'mismatched') {
      // Names inside the tree, not the staging paths they were compared at:
      // the temporary name is ours, and it tells the reader nothing
      const named = namesWithin(outcome.paths, relativeTo);
      throw new VerificationMismatchError(
        `sha256 mismatch after ${label} of ${reportPath}: ${outcome.paths.length} of ` +
          `${entries.length} file(s) differ${listed(named)} — nothing was replaced, and ` +
          `${reportPath} still holds what it held before`,
        reportPath,
        outcome.paths.length,
        entries.length,
        named
      );
    }

    logger.warn(`[Transfer] verification skipped: ${outcome.reason}`);
    return { verified: false, verifyNote: outcome.reason };
  }

  // ---------------------------------------------------------------------------
  // Directory upload
  // ---------------------------------------------------------------------------

  private async uploadDirectory(
    sshConfig: any,
    localDir: string,
    remoteDir: string,
    opts: {
      mode?: string;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      /** Keep what the target holds and the source does not */
      merge: boolean;
      /** Transfer ceiling; without it the transfer runs as long as it takes */
      timeoutMs?: number;
    }
  ): Promise<UploadDirResult> {
    const finalDir = remoteDir;

    if (!opts.overwrite) {
      const exists = await this.remoteExists(sshConfig, finalDir);
      if (exists === 'yes') {
        throw new Error(
          `remote directory already exists and overwrite=false: ${finalDir}`
        );
      }
      if (exists === 'unknown') {
        throw new Error(
          `cannot tell whether ${finalDir} already exists, and overwrite=false ` +
            'forbids writing over an unknown target. Retry, or pass overwrite: true.'
        );
      }
    }

    // The tree is counted the same way the transport sees it: it follows
    // symlinks, and stops on a broken one or a cycle — better to find out
    // here, before part of the files have already left for the server
    const files = await listTreeFiles(localDir);
    if (files.length === 0) {
      throw new Error(`local directory is empty: ${localDir}`);
    }

    let totalBytes = 0;
    for (const rel of files) {
      totalBytes += (await stat(join(localDir, rel))).size;
    }

    const ops = remotePathOps({ executor: this.executor, config: sshConfig, sudo: opts.sudo });
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };
    let merged = false;

    // The directory is replaced only as a whole and only through the
    // installer. A separate `rm -rf` on the live path followed by a `mv`
    // would leave nothing on the server if interrupted in between, and the
    // error handler would finish off what remained. Instead, the old
    // directory is set aside and removed only after the new one has taken
    // its place.
    const outcome = await install(ops, {
      finalPath: finalDir,
      kind: 'directory',
      stage: async (staging, existing) => {
        // The whole tree travels at once: the transport creates subdirectories
        const deliver = async (destination: string) => {
          if (opts.sudo) {
            await this.stageTreeUnderSudo(
              sshConfig,
              localDir,
              destination,
              opts.timeoutMs,
              !opts.mode
            );
            return;
          }
          const runner = await getRunner(sshConfig);
          await runner.upload(localDir, destination, {
            recursive: true,
            preserveMode: !opts.mode,
            timeoutMs: opts.timeoutMs,
          });
        };

        // Nothing at the target means nothing to keep: merge asked for on an
        // empty spot is an ordinary install, not a failure
        if (!opts.merge || existing !== 'directory') {
          await deliver(staging);
          return;
        }

        await this.stageMerged(sshConfig, finalDir, staging, deliver, opts);
        merged = true;
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          (await sha256OfFiles(files.map((rel) => join(localDir, rel)))).map((hash, i) => ({
            hash,
            path: posixPath.join(staging, files[i]),
          })),
          'upload',
          finalDir,
          // under sudo the staged tree belongs to root — there is no other way to read it
          { sudo: opts.sudo, timeoutMs: opts.timeoutMs, relativeTo: staging }
        );
        return null;
      },
      // Mode and owner are applied before the replace: otherwise the tree
      // would live on the live path with the wrong access for a while.
      // Walking the tree scales with its size, so the ceiling here is the
      // same as for the transfer
      finalize: (staging) =>
        this.applyOwnership(sshConfig, staging, {
          ...opts,
          recursive: true,
          timeoutMs: opts.timeoutMs ?? 0,
        }),
    });

    return {
      remote_path: finalDir,
      bytes: totalBytes,
      ...verdict,
      atomic: true,
      sudo: opts.sudo,
      files_uploaded: files.length,
      merged,
      warnings: outcome.warnings,
    };
  }

  /**
   * Build the staging tree out of the target's own content with the new tree
   * on top.
   *
   * The order is the whole point. The new tree crosses the network first, into
   * a temporary path of its own next to the target; only then is the target
   * copied, and only then does the new tree land on top of that copy. Copying
   * the target first would widen the window in which writes into the live
   * directory — a log line, an upload — are missed by the copy that replaces it.
   *
   * The composition is two plain `cp -a`: the same two on BusyBox and on
   * coreutils. `cp -a -n` reads better and would do it in one command, but on
   * BusyBox it skips the whole tree and still exits 0 — merge would quietly
   * become a full replacement, which is the loss the flag exists to prevent.
   */
  private async stageMerged(
    sshConfig: SSHConfig,
    finalDir: string,
    staging: string,
    deliver: (destination: string) => Promise<void>,
    opts: { sudo: boolean; timeoutMs?: number }
  ): Promise<void> {
    const incoming = buildTempPath(finalDir);
    await deliver(incoming);

    try {
      await this.executor.executeChecked(
        sshConfig,
        `cp -a -- ${shellQuote(finalDir)} ${shellQuote(staging)}`,
        { sudo: opts.sudo, timeout: opts.timeoutMs }
      );
      await this.executor.executeChecked(
        sshConfig,
        `cp -a -- ${shellQuote(`${incoming}/.`)} ${shellQuote(`${staging}/`)}`,
        { sudo: opts.sudo, timeout: opts.timeoutMs }
      );
    } finally {
      // A second whole copy of the data: it goes away whatever happens. Under
      // sudo it was written next to the target as root, so the cleanup needs
      // the same privileges — the connecting user cannot remove it, and the
      // copy would stay next to the target as a leftover nobody asked for
      await this.executor
        .execute(sshConfig, `rm -rf -- ${shellQuote(incoming)}`, { sudo: opts.sudo })
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_download
  // ---------------------------------------------------------------------------

  private async handleDownload(request: CallToolRequest) {
    const args = (request.params.arguments ?? {}) as DownloadArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const timeoutMs = parseTimeoutMs(args.timeout);

    // The tilde is expanded before the first command. Without this the
    // transfer would expand it (the file would arrive), but verification
    // would look for a file named "~" and not find it — the mismatch would
    // discard what was already downloaded, leaving the user with nothing.
    // Access rules are checked against the expanded path — the one the file
    // will actually be read from.
    const remotePath = requireText(args.remote_path, 'remote_path', '"/opt/app/app.conf"');
    const localPath = requireText(args.local_path, 'local_path', '"./app.conf"');

    const sudo = args.sudo === true;

    const source = await resolveRemotePath(this.executor, sshConfig, remotePath, { sudo });

    const isDir =
      args.recursive ?? (await this.isRemoteDir(sshConfig, source.path, sudo));

    if (isDir) {
      const result = await this.downloadDirectory(
        sshConfig,
        source.path,
        localPath,
        { verify: args.verify !== false, sudo, timeoutMs }
      );
      const verdict = result.verified
        ? `verified (${result.files} files)`
        : result.verifyNote
          ? `skipped — ${result.verifyNote}`
          : 'skipped';
      return {
        content: [
          {
            type: 'text',
            text:
              `✓ Downloaded directory: ${source.path} -> ${localPath}\n` +
              `  files: ${result.files}\n  sha256: ${verdict}` +
              formatWarnings([...source.warnings, ...result.warnings]),
          },
        ],
        structuredContent: filesSummary([transferredFile(source.path, result, null)]),
      };
    }

    const file = await this.downloadFile(
      sshConfig,
      source.path,
      localPath,
      { verify: args.verify !== false, sudo, timeoutMs }
    );
    const fileVerdict = file.verified
      ? 'verified'
      : file.verifyNote
        ? `skipped — ${file.verifyNote}`
        : 'skipped';
    return {
      content: [
        {
          type: 'text',
          text:
            `✓ Downloaded file: ${source.path} -> ${localPath}\n` +
            `  bytes: ${file.bytes}\n  sha256: ${fileVerdict}` +
            formatWarnings([...source.warnings, ...file.warnings]),
        },
      ],
      structuredContent: filesSummary([transferredFile(source.path, file, file.bytes)]),
    };
  }

  private async isRemoteDir(
    sshConfig: any,
    remotePath: string,
    sudo = false
  ): Promise<boolean> {
    const r = await this.executor.execute(
      sshConfig,
      `test -d ${shellQuote(remotePath)} && echo YES || echo NO`,
      { sudo }
    );
    return r.stdout.trim() === 'YES';
  }

  /**
   * Bring a source the connecting user cannot read within its reach.
   *
   * The transport never runs as root, so the data is copied under root into
   * /tmp, handed over to the connecting user and fetched from there. The copy
   * goes away whatever happens next — it is a second copy of someone else's
   * data sitting on a shared path, not something to leave behind. The
   * original is only ever read, so no failure here can cost anything.
   */
  private async fetchUnderSudo(
    sshConfig: SSHConfig,
    remotePath: string,
    staging: string,
    recursive: boolean,
    timeoutMs?: number
  ): Promise<void> {
    const handoff = buildSudoStagingPath();

    // Ownership moves to the connecting user rather than opening the copy to
    // everyone: on a shared machine `chmod a+r` would show the file to every
    // account on it for as long as the transfer runs
    await this.executor.executeChecked(
      sshConfig,
      `cp ${recursive ? '-r ' : ''}-- ${shellQuote(remotePath)} ${shellQuote(handoff)}`,
      { sudo: true, timeout: timeoutMs }
    );

    try {
      await this.executor.executeChecked(
        sshConfig,
        `chown -R -- ${shellQuote(sshConfig.username)} ${shellQuote(handoff)}`,
        { sudo: true, timeout: timeoutMs }
      );

      const runner = await getRunner(sshConfig);
      await runner.download(handoff, staging, { recursive, timeoutMs });
    } finally {
      await this.executor
        .execute(sshConfig, `rm -rf -- ${shellQuote(handoff)}`, { sudo: true })
        .catch(() => undefined);
    }
  }

  private async downloadFile(
    sshConfig: any,
    remotePath: string,
    localPath: string,
    opts: { verify: boolean; sudo?: boolean; timeoutMs?: number }
  ): Promise<{ bytes: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig);
    let bytes = 0;
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    // The user's file is replaced only as a whole: writing straight to the
    // final path would leave a mangled remnant of the old file if interrupted
    const outcome = await install(localPathOps, {
      finalPath: localPath,
      kind: 'file',
      stage: async (staging) => {
        if (opts.sudo) {
          await this.fetchUnderSudo(sshConfig, remotePath, staging, false, opts.timeoutMs);
        } else {
          await runner.download(remotePath, staging, { timeoutMs: opts.timeoutMs });
        }
        bytes = (await stat(staging)).size;
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          [{ path: remotePath, hash: await sha256OfFile(staging) }],
          'download',
          localPath,
          // the source is read under root here too — otherwise hashing it is
          // exactly as impossible as reading it was
          { sudo: opts.sudo, timeoutMs: opts.timeoutMs, relativeTo: remotePath }
        );
        return null;
      },
    });

    return { bytes, ...verdict, warnings: outcome.warnings };
  }

  /**
   * Download a directory as a whole.
   *
   * Walking the remote tree is the transport's job, so what remains here is
   * just recounting what arrived and, if asked, verifying hashes — without
   * this, `verify` for a directory would silently do nothing.
   */
  private async downloadDirectory(
    sshConfig: any,
    remoteDir: string,
    localDir: string,
    opts: { verify: boolean; sudo?: boolean; timeoutMs?: number }
  ): Promise<{ files: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig);
    let files: string[] = [];
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    const outcome = await install(localPathOps, {
      finalPath: localDir,
      kind: 'directory',
      stage: async (staging) => {
        if (opts.sudo) {
          await this.fetchUnderSudo(sshConfig, remoteDir, staging, true, opts.timeoutMs);
        } else {
          await runner.download(remoteDir, staging, { recursive: true, timeoutMs: opts.timeoutMs });
        }
        files = await listTreeFiles(staging);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          (await sha256OfFiles(files.map((rel) => join(staging, rel)))).map((hash, i) => ({
            hash,
            path: posixPath.join(remoteDir, files[i]),
          })),
          'download',
          localDir,
          { sudo: opts.sudo, timeoutMs: opts.timeoutMs, relativeTo: remoteDir }
        );
        return null;
      },
    });

    return { files: files.length, ...verdict, warnings: outcome.warnings };
  }
}
