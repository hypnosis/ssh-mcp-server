/**
 * Running a child process with a timeout, cancellation, and an output cap
 *
 * The command and arguments are passed as an array, with no shell involved —
 * special characters in paths and names can't be interpreted.
 *
 * The timeout actually stops the work rather than just giving up on waiting
 * for it: the process gets SIGTERM, and SIGKILL if it hasn't exited.
 */

import { spawn } from 'child_process';
import { OUTPUT_LIMIT_BYTES } from '../utils/output-notes.js';

/** How long to wait after SIGTERM before sending SIGKILL */
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * How long to wait for the output tail after a killed process has exited.
 *
 * From this point on the result is returned without waiting for `close`: the
 * streams of a killed ssh client are kept open by the shared master process
 * that inherited the same descriptors, and it only closes them together with
 * the remote command. Because of this, the stated deadline used to stretch
 * out until the server-side guard fired — 3s turned into 8.
 */
const OUTPUT_FLUSH_MS = 200;

export interface ProcessRunOptions {
  /** Executable: ssh, scp */
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Data for stdin; without it stdin is closed right away */
  stdin?: string | Buffer;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export interface ProcessRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Signal the process was killed with */
  signalCode: NodeJS.Signals | null;
  /** We stopped the process ourselves after the timeout expired */
  timedOut: boolean;
  /** We stopped the process ourselves via the cancellation signal */
  aborted: boolean;
  /** Output exceeded the limit and was truncated */
  truncated: boolean;
  durationMs: number;
  /** The process failed to start */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Output accumulator with a size cap.
 *
 * Reading from the stream doesn't stop once the limit is reached: if reading
 * stopped, the process would block on writing and never finish.
 */
class OutputCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.overflowed = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
      this.overflowed = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  get truncated(): boolean {
    return this.overflowed;
  }

  toString(): string {
    // Joined as a buffer, not string-by-string: a multi-byte character
    // could end up split across a chunk boundary
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Run a process and wait for it to finish.
 *
 * Never throws: every outcome, including a failed spawn, is returned in the
 * result descriptor.
 */
export function runProcess(options: ProcessRunOptions): Promise<ProcessRunOutcome> {
  const {
    file,
    args,
    env,
    timeoutMs,
    signal,
    stdin,
    maxOutputBytes = OUTPUT_LIMIT_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = options;

  return new Promise<ProcessRunOutcome>((resolve) => {
    const startedAt = Date.now();
    const stdout = new OutputCollector(maxOutputBytes);
    const stderr = new OutputCollector(maxOutputBytes);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let terminated = false;

    if (signal?.aborted) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signalCode: null,
        timedOut: false,
        aborted: true,
        truncated: false,
        durationMs: 0,
      });
      return;
    }

    const child = spawn(file, args, { env, shell: false });

    /** Stop the process: politely first, then forcibly */
    const terminate = (): void => {
      terminated = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, killGraceMs);
      killTimer.unref?.();
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      terminate();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (flushTimer) clearTimeout(flushTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (outcome: Omit<ProcessRunOutcome, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...outcome, durationMs: Date.now() - startedAt });
    };

    if (timeoutMs && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: null,
        signalCode: null,
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
        spawnError: error,
      });
    });

    child.on('close', (code, signalCode) => {
      finish({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code,
        signalCode,
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    // A process we stopped ourselves can't be waited for via `close`: its
    // streams are kept open by someone else's master process. We wait for
    // its own exit and pick up the output tail with a short grace period.
    child.on('exit', (code, signalCode) => {
      if (!terminated || settled) return;
      flushTimer = setTimeout(() => {
        finish({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: code,
          signalCode,
          timedOut,
          aborted,
          truncated: stdout.truncated || stderr.truncated,
        });
      }, OUTPUT_FLUSH_MS);
    });

    if (child.stdin) {
      // Write errors are swallowed: the process may have already exited,
      // and that shouldn't bring down the whole run
      child.stdin.on('error', () => undefined);
      if (stdin !== undefined) {
        child.stdin.end(stdin);
      } else {
        // Without closing stdin, a command reading input would hang until the timeout
        child.stdin.end();
      }
    }
  });
}
