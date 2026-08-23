/**
 * Command Runner — the boundary between tools and the SSH transport
 *
 * Tools build a shell command string and get back an honest result. How the
 * command actually reaches the server (system ssh, a library) is not their
 * concern.
 */

import type { ServerPassport } from './passport.js';

/**
 * Command execution options
 */
export interface ExecOptions {
  /** Operation timeout in milliseconds (default — `DEFAULT_EXEC_TIMEOUT_MS`) */
  timeoutMs?: number;
  /** Cancellation signal — aborts the operation immediately */
  signal?: AbortSignal;
  /**
   * Whether it's safe to retry the operation on a transport error.
   * Defaults to false: retrying a mutating command is riskier than letting it fail.
   */
  idempotent?: boolean;
  /** Data for the command's stdin */
  stdin?: string | Buffer;
  /** Output buffer limit in bytes (default — `OUTPUT_LIMIT_BYTES`) */
  maxOutputBytes?: number;
  /**
   * Whether to wrap the command in a remote `timeout` — so the process on the
   * server doesn't outlive the killed local ssh (defaults to true when timeoutMs is set)
   */
  remoteTimeout?: boolean;
  /**
   * The command runs with elevated rights: stopping it after a cancellation
   * has to reach processes owned by root, and a signal from the login user
   * never gets to those.
   */
  elevated?: boolean;
}

/**
 * Command execution result.
 *
 * A non-zero exitCode is a result, not an error: `grep` with no matches
 * returns 1, and that's a normal answer, not a failure.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Output was truncated by maxOutputBytes */
  truncated: boolean;
  durationMs: number;
}

/**
 * File transfer options
 */
export interface TransferOptions {
  /**
   * Transfer timeout in milliseconds. Without it there is no cap: the transfer
   * runs as long as it needs to, and a stalled channel is caught by the
   * transport's keepalive.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Recursive directory transfer */
  recursive?: boolean;
  /**
   * Carry the local permission bits over instead of letting the server's
   * umask decide them.
   *
   * Without this a build directory arrives with every file the same: an
   * executable that lost its bit is a broken deploy, and nothing in the
   * answer says so.
   */
  preserveMode?: boolean;
}

/**
 * Server reachability check result
 */
/**
 * What a profile can be used for right now.
 *
 * Named states rather than a boolean, because each one calls for a different next move and
 * a boolean forced three different worlds into two values — which is how "answered with a
 * non-zero code" came to be reported as "did not answer".
 *
 * - `ready`     logged in, commands run — work
 * - `limited`   logged in, commands run, but the shell is not POSIX — work, and expect no
 *               POSIX utilities (tools built on them do not apply)
 * - `no-route`  never got there: port, network, timeout — fix connectivity, do not send commands
 * - `rejected`  got there, was not let in: credentials or a server-side limit — fix access,
 *               connectivity is fine
 */
export type PingState = 'ready' | 'limited' | 'no-route' | 'rejected';

export interface PingResult {
  state: PingState;
  /** Whether the master connection was already alive before the check */
  masterWasActive: boolean;
  latencyMs: number;
  /** What the server or the client said. Absent when there was nothing to say */
  detail?: string;
  /** Exit code of the probe command — carried only by `limited` */
  exitCode?: number;
}

/**
 * Transport state for diagnostics (ssh_monitor stats)
 */
export interface RunnerStats {
  /** Command delivery method. There is one transport; the field stays part of the ssh_monitor response */
  backend: 'openssh';
  /** Whether connection multiplexing is working */
  multiplexing: boolean;
  /** Why multiplexing is disabled */
  multiplexingDisabledReason?: string;
  /** Version of the system ssh, if applicable */
  sshVersion?: string;
  /** Whether the master connection is alive right now */
  masterActive: boolean;
  masterPid?: number;
  controlPath?: string;
  commandsThisSession: number;
  transfersThisSession: number;
  lastError?: string;
}

/**
 * How an attempt to close the shared connection ended.
 *
 * `nothing-to-close` isn't a failure: the connection already timed out from
 * idling. `multiplexing-off` means there's nothing to close in principle —
 * the connection doesn't outlive a single command.
 */
export type MasterCloseOutcome = 'closed' | 'nothing-to-close' | 'multiplexing-off';

/**
 * Transport for running commands and transferring files on a single profile
 */
export interface CommandRunner {
  /** Run a command. Does not throw on a non-zero exitCode. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Server passport: what utilities are available on it.
   *
   * Only asked for here. The probe must bypass the first-command gate: gated
   * commands themselves wait for the passport, and a probe going through
   * `exec` would close the loop on itself.
   */
  passport(): Promise<ServerPassport>;

  /** Upload a file or directory to the server */
  upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>;

  /** Download a file or directory from the server */
  download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>;

  /** Check server reachability */
  ping(options?: { timeoutMs?: number }): Promise<PingResult>;

  /** Transport state for diagnostics */
  stats(): Promise<RunnerStats>;

  /** Close the reusable connection */
  closeMaster(): Promise<MasterCloseOutcome>;
}
