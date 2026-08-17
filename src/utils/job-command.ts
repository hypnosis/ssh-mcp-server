/**
 * Background job protocol: commands sent to the server and parsing their replies.
 *
 * A job's state lives entirely on the remote disk, so the MCP server
 * remembers nothing between calls and survives its own restart.
 *
 * The command forms follow real platform differences rather than general
 * rules: BusyBox's `kill` rejects `--`, `$!` from a background launch names
 * the wrapper rather than the job itself, and `ps -o` isn't available
 * everywhere. Building and parsing live side by side because they change together.
 */

import { randomBytes } from 'crypto';
import { shellQuote } from './shell-arg.js';

/** Jobs directory relative to the user's home */
const JOBS_ROOT = '.ssh-mcp/jobs';

/** Marker used to find the answer among the banner and the motd */
const MARKER = 'SSH_MCP_JOB';
const CMD_MARKER = 'SSH_MCP_JOB_CMD';
const REMOVED_MARKER = 'SSH_MCP_JOB_REMOVED';

/** How long a finished job's directory lives, in seconds */
export const JOB_TTL_SEC = 7 * 24 * 60 * 60;

/** How many attempts a launch waits for the job to write its pid */
const PID_WAIT_ATTEMPTS = 20;

/**
 * The three outcomes are never conflated: `lost` means "nothing to check",
 * not a failure. A job killed by a signal leaves no exit code, so reporting
 * it as succeeded or failed would be dishonest.
 */
export type JobState = 'running' | 'finished' | 'lost' | 'missing';

export interface JobStatus {
  state: JobState;
  pid?: number;
  exitCode?: number;
  /** Start time, seconds since the epoch */
  startedAt?: number;
  /** Size of the accumulated output in bytes — also the cursor for reading */
  outputSize?: number;
  /** The command as it was given */
  command?: string;
}

export interface JobSummary {
  id: string;
  state: JobState;
  exitCode?: number;
  startedAt?: number;
  outputSize?: number;
}

export interface JobListing {
  jobs: JobSummary[];
  /** Jobs whose directories were removed once their TTL expired */
  removed: string[];
}

export interface JobOutput {
  /** Total output size on the server: the next read starts from here */
  size: number;
  text: string;
  /** The job's directory doesn't exist: this is not "output is empty" but "nothing to ask" */
  missing: boolean;
}

/**
 * Job id: start time plus a random tail.
 *
 * Time up front keeps the list readable in order, and the random tail rules
 * out a collision between two jobs launched in the same millisecond.
 */
export function createJobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * The id ends up in a path on the server, so a foreign one is checked before it's sent.
 *
 * Only letters, digits and dashes are allowed: that's enough for our own ids,
 * and `..`, a path separator, whitespace and a substitution are all rejected
 * by one rule.
 */
export function assertJobId(id: unknown): string {
  const text = typeof id === 'string' ? id : '';

  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(text)) {
    throw new Error(
      `Invalid job id ${JSON.stringify(String(id))}: expected letters, digits and dashes`
    );
  }

  return text;
}

/** The jobs root on the server. An empty home is a refusal: the write path cannot be guessed. */
export function jobsRoot(home: string): string {
  if (!home.startsWith('/')) {
    throw new Error(
      'Cannot locate the jobs directory: the server did not report a home directory'
    );
  }

  return `${home.replace(/\/$/, '')}/${JOBS_ROOT}`;
}

/** Paths for one job: its directory sits inside the shared root */
export function jobPaths(home: string, id: string): { root: string; dir: string } {
  const root = jobsRoot(home);
  return { root, dir: `${root}/${assertJobId(id)}` };
}

/**
 * The background part is wrapped in braces, otherwise `&` would apply to the
 * whole preparation pipeline: dash leaves a subshell on it, which holds the
 * ssh channel open until the job finishes, so the launch stops being
 * instant. BusyBox does not behave that way — the defect only shows up on
 * some servers.
 *
 * The directory and the command travel as the `$0` and `$1` parameters
 * instead of being substituted into the text: that way quoting is applied
 * once, and a command containing a space, an apostrophe or `$(…)` arrives whole.
 *
 * The job writes its own pid: `$!` from a background launch names the
 * wrapper, not the process that actually runs the command. The job also
 * becomes the leader of its own process group and session — that's what
 * makes it possible to kill it as a whole.
 */
export function buildStartCommand(dir: string, command: string, useSetsid: boolean): string {
  const dirQ = shellQuote(dir);
  const commandQ = shellQuote(command);
  const detach = useSetsid ? 'setsid' : 'nohup';

  const body =
    `echo $$ > "$0/pid"; ` +
    `sh -c "$1"; ` +
    `echo $? > "$0/exit_code"`;

  return (
    `mkdir -p ${dirQ} && ` +
    `printf '%s' ${commandQ} > ${dirQ}/cmd && ` +
    `date +%s > ${dirQ}/started && ` +
    `: > ${dirQ}/output.log && ` +
    `{ ${detach} sh -c ${shellQuote(body)} ${dirQ} ${commandQ} ` +
    `</dev/null >> ${dirQ}/output.log 2>&1 & } ; ` +
    // Wait for the job to announce itself: without a pid, the very next
    // status call would consider it lost
    `i=0; while [ ! -s ${dirQ}/pid ] && [ $i -lt ${PID_WAIT_ATTEMPTS} ]; do ` +
    `i=$((i+1)); sleep 0.1 2>/dev/null || sleep 1; done; ` +
    `printf '${MARKER} pid=%s\\n' "$(cat ${dirQ}/pid 2>/dev/null)"`
  );
}

/** Status command: fields on one line, the job's command trailing after the marker */
export function buildStatusCommand(dir: string): string {
  const dirQ = shellQuote(dir);

  return (
    `d=${dirQ}; ` +
    `if [ ! -d "$d" ]; then printf '${MARKER} state=missing\\n'; exit 0; fi; ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `code=$(cat "$d/exit_code" 2>/dev/null); ` +
    `started=$(cat "$d/started" 2>/dev/null); ` +
    `size=$(wc -c < "$d/output.log" 2>/dev/null); ` +
    `alive=0; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; ` +
    `printf '${MARKER} alive=%s pid=%s code=%s started=%s size=%s\\n' ` +
    `"$alive" "$pid" "$code" "$started" "$size"; ` +
    `printf '${CMD_MARKER}\\n'; cat "$d/cmd" 2>/dev/null`
  );
}

/**
 * Command to read output from a position.
 *
 * `tail -c +N` counts from one, so the position is shifted by one: zero reads
 * the whole file. The size is printed first — it's also the cursor for the next read.
 */
export function buildOutputCommand(dir: string, offset: number): string {
  const dirQ = shellQuote(dir);
  const from = Math.max(0, Math.floor(offset)) + 1;

  return (
    `d=${dirQ}; ` +
    `if [ ! -d "$d" ]; then printf '${MARKER} state=missing\\n'; exit 0; fi; ` +
    `if [ ! -f "$d/output.log" ]; then printf '${MARKER} size=0\\n'; exit 0; fi; ` +
    `printf '${MARKER} size=%s\\n' "$(wc -c < "$d/output.log" 2>/dev/null)"; ` +
    `tail -c +${from} "$d/output.log" 2>/dev/null`
  );
}

/**
 * A minus sign before the number targets the whole process group — it kills
 * the job together with its children. `--` is never used: BusyBox responds
 * to it with `invalid number` and does nothing. Killing the single process
 * remains a fallback for a job launched without its own session.
 */
export function buildKillCommand(dir: string, signal: 'TERM' | 'KILL' = 'TERM'): string {
  const dirQ = shellQuote(dir);

  return (
    `d=${dirQ}; ` +
    `if [ ! -d "$d" ]; then printf '${MARKER} killed=0 reason=missing\\n'; exit 0; fi; ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `if [ -z "$pid" ]; then printf '${MARKER} killed=0 reason=nopid\\n'; exit 0; fi; ` +
    `if ! kill -0 "$pid" 2>/dev/null; then printf '${MARKER} killed=0 reason=gone\\n'; exit 0; fi; ` +
    `kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ` +
    `printf '${MARKER} killed=1\\n'`
  );
}

/**
 * Listing command with cleanup along the way.
 *
 * Age is computed from the start time we recorded, not `find -mtime`: `find`
 * dialects differ, but a number of seconds is the same everywhere. Only
 * directories inside our own root are removed, and only for jobs that are no
 * longer running.
 */
export function buildListCommand(root: string, ttlSec: number = JOB_TTL_SEC): string {
  const rootQ = shellQuote(root);

  return (
    `root=${rootQ}; ` +
    `[ -d "$root" ] || exit 0; ` +
    `now=$(date +%s); ` +
    `for d in "$root"/*; do ` +
    `[ -d "$d" ] || continue; ` +
    `id=$(basename "$d"); ` +
    `pid=$(cat "$d/pid" 2>/dev/null); ` +
    `code=$(cat "$d/exit_code" 2>/dev/null); ` +
    `started=$(cat "$d/started" 2>/dev/null); ` +
    `size=$(wc -c < "$d/output.log" 2>/dev/null); ` +
    `alive=0; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; ` +
    `if [ "$alive" = 0 ] && [ -n "$started" ] && [ $((now - started)) -gt ${ttlSec} ]; then ` +
    `rm -rf "$d"; printf '${REMOVED_MARKER} id=%s\\n' "$id"; continue; fi; ` +
    `printf '${MARKER} id=%s alive=%s code=%s started=%s size=%s\\n' ` +
    `"$id" "$alive" "$code" "$started" "$size"; ` +
    `done`
  );
}

/** Key-value fields from a line carrying the marker */
function fieldsOf(line: string, marker: string): Map<string, string> {
  const body = line.slice(line.indexOf(marker) + marker.length).trim();
  const fields = new Map<string, string>();

  for (const token of body.split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
  }

  return fields;
}

/** A number, or undefined: an empty field means "the server didn't say" */
function numberOf(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/**
 * A job's outcome from what the server returned.
 *
 * The exit code outranks aliveness: a job can finish between the file read
 * and the process check, and by then "there's a code" is already the answer.
 */
function stateOf(alive: boolean, exitCode: number | undefined): JobState {
  if (exitCode !== undefined) return 'finished';
  return alive ? 'running' : 'lost';
}

/** Parse the answer of the status command */
export function parseJobStatus(stdout: string): JobStatus {
  const lines = stdout.split('\n');
  const head = lines.find((line) => line.includes(MARKER));
  if (!head) return { state: 'missing' };

  const fields = fieldsOf(head, MARKER);
  if (fields.get('state') === 'missing') return { state: 'missing' };

  const cmdAt = lines.findIndex((line) => line.includes(CMD_MARKER));
  const command = cmdAt >= 0 ? lines.slice(cmdAt + 1).join('\n') : undefined;
  const exitCode = numberOf(fields.get('code'));

  return {
    state: stateOf(fields.get('alive') === '1', exitCode),
    pid: numberOf(fields.get('pid')),
    exitCode,
    startedAt: numberOf(fields.get('started')),
    outputSize: numberOf(fields.get('size')),
    command,
  };
}

/** Parse the answer of the list command */
export function parseJobList(stdout: string): JobListing {
  const jobs: JobSummary[] = [];
  const removed: string[] = [];

  for (const line of stdout.split('\n')) {
    if (line.includes(REMOVED_MARKER)) {
      const id = fieldsOf(line, REMOVED_MARKER).get('id');
      if (id) removed.push(id);
      continue;
    }

    if (!line.includes(MARKER)) continue;

    const fields = fieldsOf(line, MARKER);
    const id = fields.get('id');
    if (!id) continue;

    const exitCode = numberOf(fields.get('code'));
    jobs.push({
      id,
      state: stateOf(fields.get('alive') === '1', exitCode),
      exitCode,
      startedAt: numberOf(fields.get('started')),
      outputSize: numberOf(fields.get('size')),
    });
  }

  return { jobs, removed };
}

/**
 * Parse the answer of the output-read command.
 *
 * The size arrives as the first line and is cut out of the text: it is
 * bookkeeping, and passing it off as part of the job's output would misreport it.
 */
export function parseJobOutput(stdout: string): JobOutput {
  const newline = stdout.indexOf('\n');
  const head = newline >= 0 ? stdout.slice(0, newline) : stdout;

  if (!head.includes(MARKER)) return { size: 0, text: stdout, missing: false };

  const fields = fieldsOf(head, MARKER);
  if (fields.get('state') === 'missing') return { size: 0, text: '', missing: true };

  return {
    size: numberOf(fields.get('size')) ?? 0,
    text: newline >= 0 ? stdout.slice(newline + 1) : '',
    missing: false,
  };
}

/** Parse the answer of the kill command: whether the job was killed and why not */
export function parseJobKill(stdout: string): { killed: boolean; reason?: string } {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  if (!line) return { killed: false, reason: 'no answer' };

  const fields = fieldsOf(line, MARKER);
  return { killed: fields.get('killed') === '1', reason: fields.get('reason') };
}

/** The pid announced by the launched job */
export function parseJobStart(stdout: string): number | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  return line ? numberOf(fieldsOf(line, MARKER).get('pid')) : undefined;
}
