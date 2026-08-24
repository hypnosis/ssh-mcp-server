/**
 * Verify transferred files by hash.
 *
 * One approach for every case: file names go in as arguments, the server
 * prints hashes, the comparison happens on our side. This works on both
 * coreutils and BusyBox — long options (`--quiet`) and taking a manifest on
 * stdin (`sha256sum -c -`) aren't available everywhere, and embedded systems
 * have neither at all.
 *
 * There are exactly three outcomes, and they never mix: matched, mismatched,
 * nothing to verify with. "Nothing to verify with" arrives as exit code 127
 * with text on stderr, not on stdout — mistaking that for a mismatch would
 * make a transfer to a server without sha256sum look corrupted.
 */

import { invalidatePassport, passportKey, type Sha256Tool } from '../runner/passport.js';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/shell-arg.js';
import type { SSHExecuteResult, SSHExecutor } from './ssh-executor.js';

/** How many names go into a single command */
const MAX_PATHS_PER_COMMAND = 100;
/**
 * Command length limit in bytes — this counts what actually goes over the
 * wire to the server, not the path length in characters. The Linux kernel
 * rejects a line longer than 128 KiB, embedded systems cut off sooner, so
 * we stay at a quarter of the ceiling.
 */
const MAX_COMMAND_LENGTH = 32 * 1024;
/** The `sudo <shell> -c '…'` wrapper the executor wraps the command in */
const SUDO_WRAPPER_BYTES = 15;
/** Shell exit code when the program is not found */
const COMMAND_NOT_FOUND = 127;
/**
 * The timeout guard killed the command, and the answer is incomplete.
 *
 * coreutils returns 124, BusyBox returns 143 (that's 128 + SIGTERM), and
 * both mean the job was actually killed. Without this check, hashes that
 * never came back read as a mismatch, and a mismatch makes the installer
 * tear down a tree that already made it to the server.
 */
const GUARD_KILLED_EXIT_CODES = [124, 143];
/**
 * Names that line-based parsing cannot recover.
 *
 * BusyBox prints the name verbatim, so a newline inside a name splits the
 * output line in two and the path is lost — a tree containing such a file
 * would be declared corrupted and torn down. Such files are asked about one
 * at a time — then there's no need to parse the name, we already know it.
 */
const NAME_BREAKS_LINES = /[\n\r]/;

export interface VerifyEntry {
  path: string;
  hash: string;
}

export interface VerifyOptions {
  sudo?: boolean;
  /**
   * Ceiling on hashing, in milliseconds. Zero means no ceiling, and that's
   * the default here: verification time is set by the data volume, not the
   * network. A blanket 30 seconds for commands would cut off a tree of
   * several gigabytes — after the transfer had already succeeded.
   */
  timeoutMs?: number;
}

export type VerifyOutcome =
  | { status: 'matched' }
  | { status: 'mismatched'; paths: string[] }
  | { status: 'unavailable'; reason: string };

/**
 * An answer that cannot be judged: part of the hashes were never received.
 *
 * All three outcomes mean "nothing to verify with" and never "mismatched":
 * a mismatch makes the installer tear down a tree that already made it to
 * the server.
 */
type IncompleteAnswer = 'truncated' | 'guard-killed' | 'deadline' | 'silent';

function isIncomplete(answer: unknown): answer is IncompleteAnswer {
  return (
    answer === 'truncated' ||
    answer === 'guard-killed' ||
    answer === 'deadline' ||
    answer === 'silent'
  );
}

/**
 * How much time is left for the whole verification.
 *
 * The deadline belongs to the operation as a whole: the same ceiling on
 * every command would mean the promised deadline gets multiplied by the
 * number of commands, and that number is set by the list length. Zero on
 * input means "no ceiling", and then we don't start a clock at all — that's
 * how verification of multi-gigabyte trees is invoked.
 */
function startDeadline(timeoutMs: number | undefined): (() => number) | null {
  if (!timeoutMs) return null;
  const expiresAt = Date.now() + timeoutMs;
  return () => expiresAt - Date.now();
}

/**
 * Verify files on the server against locally computed hashes.
 *
 * Does not throw on a failed check: a mismatch is an answer the caller
 * decides what to do with (one caller needs to roll back the install,
 * another just needs a warning).
 */
export async function verifyRemoteFiles(
  executor: SSHExecutor,
  config: SSHConfig,
  entries: VerifyEntry[],
  options: VerifyOptions
): Promise<VerifyOutcome> {
  if (entries.length === 0) {
    // An empty list is not "everything matched": the files most likely weren't found
    return { status: 'unavailable', reason: 'there were no files to verify' };
  }

  // The clock starts before the passport probe: it also goes to the server
  // and also eats into the time promised to the user
  const remaining = startDeadline(options.timeoutMs);

  const passport = await executor.passport(config);
  if (passport.sha256 === 'none') {
    return {
      status: 'unavailable',
      reason: passport.known
        ? 'neither sha256sum nor openssl is available on the server'
        : 'the server did not answer which hashing tool it has',
    };
  }

  const remoteHashes = await collectRemoteHashes(
    executor,
    config,
    entries,
    passport.sha256,
    options,
    remaining
  );

  if (isIncomplete(remoteHashes)) {
    return { status: 'unavailable', reason: incompleteReason(remoteHashes) };
  }

  if (remoteHashes === 'tool-missing') {
    // The passport promised a tool that isn't there: the server changed
    // under us. Forget the cached entry and ask again — openssl may still be there.
    invalidatePassport(passportKey(config));
    const refreshed = await executor.passport(config);

    if (refreshed.sha256 === 'none' || refreshed.sha256 === passport.sha256) {
      return { status: 'unavailable', reason: `${passport.sha256} is not available on the server` };
    }

    const retried = await collectRemoteHashes(
      executor,
      config,
      entries,
      refreshed.sha256,
      options,
      remaining
    );
    if (retried === 'tool-missing') {
      return { status: 'unavailable', reason: `${refreshed.sha256} is not available on the server` };
    }
    if (isIncomplete(retried)) {
      return { status: 'unavailable', reason: incompleteReason(retried) };
    }
    return compare(entries, retried);
  }

  return compare(entries, remoteHashes);
}

/**
 * Why the server's answer is incomplete.
 *
 * An incomplete answer must read as "nothing to verify with": otherwise
 * missing hashes look like corrupted files, and the installer tears down
 * data that is intact.
 */
function incompleteReason(outcome: IncompleteAnswer): string {
  if (outcome === 'truncated') return 'the hashing output did not fit the transport buffer';
  if (outcome === 'guard-killed') return 'hashing was killed by the timeout guard on the server';
  if (outcome === 'silent') return 'the hashing ran without complaint and named no hash at all';
  return 'the time allowed for verification ran out before all hashes were read';
}

/** Ask the server for the hashes of all files, splitting the list into commands it can handle */
async function collectRemoteHashes(
  executor: SSHExecutor,
  config: SSHConfig,
  entries: VerifyEntry[],
  tool: Exclude<Sha256Tool, 'none'>,
  options: VerifyOptions,
  remaining: (() => number) | null
): Promise<Map<string, string> | 'tool-missing' | IncompleteAnswer> {
  const hashes = new Map<string, string>();
  const paths = entries.map((entry) => entry.path);

  const ask = (chunk: string[], timeout: number) =>
    executor.execute(config, buildHashCommand(tool, chunk), {
      sudo: options.sudo,
      idempotent: true,
      timeout,
    });

  /**
   * How much time the next command is allowed to take. `null` means the
   * deadline has passed and there's nothing left to ask; zero means "no
   * ceiling" and is passed to the executor as is.
   */
  const budget = (): number | null => {
    if (!remaining) return 0;
    const left = remaining();
    return left > 0 ? left : null;
  };

  /**
   * Ask for hashes without exceeding the overall deadline.
   *
   * `'deadline'` is returned in two cases: no time was left even before the
   * command ran, and the command was killed by our own guard — near the end
   * of the deadline it gets only the last few milliseconds. Both mean
   * "nothing to verify with": propagating the error would read as a failed
   * transfer, and a failed transfer makes the installer tear down a tree
   * that already made it to the server.
   */
  const askWithin = async (chunk: string[]): Promise<SSHExecuteResult | 'deadline'> => {
    const left = budget();
    if (left === null) return 'deadline';

    try {
      return await ask(chunk, left);
    } catch (error) {
      if (budget() === null) return 'deadline';
      throw error;
    }
  };

  /** Whether the server said anything at all: a run that spoke has judged the files */
  let spoke = false;

  /** A non-zero exit code is normal: an unreadable file doesn't cancel the rest of the hashes */
  const note = (result: SSHExecuteResult) => {
    if (result.stdout.length > 0 || result.exitCode !== 0) spoke = true;
    if (result.exitCode !== 0) {
      logger.debug(`[Verify] hashing reported exit ${result.exitCode}: ${result.stderr.trim()}`);
    }
  };

  const listed = splitIntoCommands(
    paths.filter((path) => !NAME_BREAKS_LINES.test(path)),
    tool,
    options.sudo === true
  );

  for (const chunk of listed) {
    const result = await askWithin(chunk);
    if (result === 'deadline') return 'deadline';

    if (result.exitCode === COMMAND_NOT_FOUND) return 'tool-missing';
    if (GUARD_KILLED_EXIT_CODES.includes(result.exitCode)) return 'guard-killed';
    // The transport buffer cuts off the tail of the output: missing hashes
    // would look like a mismatch, and a mismatch makes the installer tear
    // down a tree that already made it to the server
    if (result.truncated) return 'truncated';
    note(result);

    for (const [path, hash] of parseHashOutput(result.stdout)) hashes.set(path, hash);
  }

  for (const path of paths.filter((entry) => NAME_BREAKS_LINES.test(entry))) {
    const result = await askWithin([path]);
    if (result === 'deadline') return 'deadline';

    if (result.exitCode === COMMAND_NOT_FOUND) return 'tool-missing';
    if (GUARD_KILLED_EXIT_CODES.includes(result.exitCode)) return 'guard-killed';
    if (result.truncated) return 'truncated';
    note(result);

    const hash = hashOfSingleOutput(result.stdout, tool);
    if (hash) hashes.set(path, hash);
  }

  // A run that printed nothing and complained about nothing has not judged the
  // files at all: their names are missing an answer, not missing on disk
  if (!spoke) return 'silent';

  return hashes;
}

/**
 * The start of the command, up to the first name.
 *
 * `--` guards against a name starting with a dash; openssl has no such separator.
 */
function commandPrefix(tool: Exclude<Sha256Tool, 'none'>): string {
  return tool === 'sha256sum' ? 'sha256sum -- ' : 'openssl dgst -sha256 ';
}

/** The command that prints the hashes of a list of files */
function buildHashCommand(tool: Exclude<Sha256Tool, 'none'>, paths: string[]): string {
  return commandPrefix(tool) + paths.map(shellQuote).join(' ');
}

/**
 * Parse the output of either of the two tools.
 *
 * sha256sum prints `<hex>␣␣<path>`, openssl prints `SHA2-256(<path>)= <hex>`
 * (before version 3, `SHA256(...)`). Lines that match neither form are
 * ignored: they may be a banner or a complaint about an unreadable file.
 */
function parseHashOutput(stdout: string): Map<string, string> {
  const hashes = new Map<string, string>();

  for (const line of stdout.split('\n')) {
    const plain = /^(\\?)([0-9a-fA-F]{64})[ \t][ *](.*)$/.exec(line);
    if (plain) {
      hashes.set(plain[1] ? unescapeName(plain[3]) : plain[3], plain[2].toLowerCase());
      continue;
    }

    const openssl = /^[A-Za-z0-9-]+\((.*)\)= ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (openssl) hashes.set(openssl[1], openssl[2].toLowerCase());
  }

  return hashes;
}

/**
 * Restore a name to its original form.
 *
 * When coreutils meets a backslash, newline, or carriage return in a name,
 * it puts `\` before the hash and escapes exactly those three characters
 * inside the name (the rest — quote, apostrophe, tab, asterisk — pass
 * through as is). Without reversing this, a file like `a\b.txt` would not
 * be found in the server's answer, verification would report a mismatch,
 * and the installer would tear down a tree that already made it to the server.
 *
 * Only the backslash shows up here: names with a newline or carriage return
 * never reach the common parsing path — they're asked about one at a time.
 */
function unescapeName(name: string): string {
  return name.replace(/\\\\/g, '\\');
}

/**
 * The hash from the answer to a command about a single file.
 *
 * The name isn't parsed here at all — the caller already knows it, and in
 * the output it may be split by a newline. What matters instead is which
 * tool produced the output: a file name can imitate the other tool's
 * format. Parsing "try sha256sum, then openssl" against a file named
 * `x⏎<64 chars>␣␣y.txt` on a server with only openssl would report a match
 * using a hash taken from the file's own name.
 *
 * For sha256sum the hash opens the output, for openssl it closes the line,
 * so we take the first and last occurrence respectively.
 */
function hashOfSingleOutput(stdout: string, tool: Exclude<Sha256Tool, 'none'>): string | null {
  if (tool === 'openssl') {
    const openssl = /\)= ([0-9a-fA-F]{64})\s*$/.exec(stdout);
    return openssl ? openssl[1].toLowerCase() : null;
  }

  // There's exactly one file, so the hash opens the output. Without the
  // anchor, any similar-looking line further down would pass as a match —
  // for instance a fragment of the file's own name
  const sum = /^\\?([0-9a-fA-F]{64})[ \t][ *]/.exec(stdout);
  return sum ? sum[1].toLowerCase() : null;
}

/** Compare expected against received; the server staying silent about a file also counts as a mismatch */
function compare(entries: VerifyEntry[], remote: Map<string, string>): VerifyOutcome {
  const mismatched = entries
    .filter((entry) => remote.get(entry.path) !== entry.hash.toLowerCase())
    .map((entry) => entry.path);

  return mismatched.length === 0 ? { status: 'matched' } : { status: 'mismatched', paths: mismatched };
}

/**
 * What a name costs in the command line: quoting, escaping inside it, and
 * the space before the next one. Under sudo the whole command goes inside
 * `sudo sh -c '…'`, so every name gets quoted a second time and its
 * apostrophes quadruple.
 */
function pathCost(path: string, sudo: boolean): number {
  const quoted = shellQuote(path);
  return Buffer.byteLength(sudo ? shellQuote(quoted) : quoted) + 1;
}

/**
 * Split the path list so that each command stays within the limit.
 *
 * What's counted are the bytes of the transmitted string: a non-ASCII name
 * in UTF-8 weighs twice its length in characters, a name full of
 * apostrophes weighs four times as much, and under sudo a second round of
 * quoting adds on top of that.
 */
function splitIntoCommands(
  paths: string[],
  tool: Exclude<Sha256Tool, 'none'>,
  sudo: boolean
): string[][] {
  const overhead = Buffer.byteLength(commandPrefix(tool)) + (sudo ? SUDO_WRAPPER_BYTES : 0);
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = overhead;

  for (const path of paths) {
    const cost = pathCost(path, sudo);
    if (current.length > 0 && (current.length >= MAX_PATHS_PER_COMMAND || length + cost > MAX_COMMAND_LENGTH)) {
      chunks.push(current);
      current = [];
      length = overhead;
    }
    current.push(path);
    length += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The copy on the far side differed from the source.
 *
 * Carries the path the caller named, not the temporary one the comparison ran
 * at: a name the caller never chose explains nothing to whoever reads the
 * failure.
 */
export class VerificationMismatchError extends Error {
  /** The diagnosis is already complete: there is nothing here to route around */
  readonly noExecHint = true as const;

  readonly path: string;
  readonly differing: number;
  readonly total: number;
  /** Names inside the tree, at most the first few; empty for a single file */
  readonly names: string[];

  constructor(
    message: string,
    path: string,
    differing: number,
    total: number,
    names: string[] = []
  ) {
    super(message);
    this.name = 'VerificationMismatchError';
    this.path = path;
    this.differing = differing;
    this.total = total;
    this.names = names;
  }
}

/**
 * The mismatch behind a failure, however it was wrapped on the way up: the
 * installer wraps whatever verification threw whenever it has warnings of its
 * own to report.
 */
export function mismatchOf(error: unknown): VerificationMismatchError | null {
  if (error instanceof VerificationMismatchError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof VerificationMismatchError ? cause : null;
}
