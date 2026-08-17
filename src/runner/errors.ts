/**
 * SSH transport errors
 *
 * Thrown only when the transport itself fails. A non-zero return code from
 * the remote command is not an error — it arrives in ExecResult.
 */

/**
 * Base transport error
 */
export class SSHRunnerError extends Error {
  /** ssh's return code, if the process managed to exit */
  public readonly exitCode?: number;
  /** ssh's diagnostic output */
  public readonly stderr?: string;

  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message);
    this.name = 'SSHRunnerError';
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
  }
}

/**
 * Network or transport error — the only class that's safe to retry
 * (and even then, only for idempotent operations)
 */
export class SSHTransportError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHTransportError';
  }
}

/**
 * The channel closed without letting the command print anything. The
 * connection itself is still alive, so the retry happens right away —
 * there's no one and nothing to wait for here.
 */
export class SSHChannelClosedError extends SSHTransportError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHChannelClosedError';
  }
}

/**
 * Authentication error — retrying is pointless and harmful:
 * every attempt counts against the server as a failed login
 */
export class SSHAuthError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHAuthError';
  }
}

/**
 * Host key mismatch or unknown host key
 */
export class SSHHostKeyError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHHostKeyError';
  }
}

/**
 * Operation aborted by timeout.
 *
 * Never retried: the command already started on the server, and a retry
 * could run the mutation twice.
 */
export class SSHTimeoutError extends SSHRunnerError {
  /** Partial output accumulated before the timeout fired */
  public readonly partialStdout: string;
  public readonly partialStderr: string;

  constructor(
    message: string,
    details: { partialStdout?: string; partialStderr?: string } = {}
  ) {
    super(message);
    this.name = 'SSHTimeoutError';
    this.partialStdout = details.partialStdout ?? '';
    this.partialStderr = details.partialStderr ?? '';
  }
}

/**
 * Operation cancelled by the caller.
 *
 * Differs from a timeout in that it's an expected outcome, not a failure:
 * the agent changed its mind, or the user interrupted the call.
 */
export class SSHCancelledError extends SSHRunnerError {
  public readonly partialStdout: string;
  public readonly partialStderr: string;

  constructor(
    message: string,
    details: { partialStdout?: string; partialStderr?: string } = {}
  ) {
    super(message);
    this.name = 'SSHCancelledError';
    this.partialStdout = details.partialStdout ?? '';
    this.partialStderr = details.partialStderr ?? '';
  }
}

/**
 * The system ssh was not found in PATH
 */
export class SSHBinaryMissingError extends SSHRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'SSHBinaryMissingError';
  }
}

/**
 * The profile configuration is incompatible with the environment
 * (e.g. a password-based profile on OpenSSH older than 8.4)
 */
export class SSHUnsupportedConfigError extends SSHRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'SSHUnsupportedConfigError';
  }
}

/**
 * The server's concurrent session limit was reached (MaxSessions), and the
 * client also failed to open a separate connection in place of a session:
 * a plain session refusal it handles on its own, without our involvement.
 */
export class SSHMuxLimitError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHMuxLimitError';
  }
}

/**
 * Whether it's safe to retry the operation for this error.
 *
 * Only transport failures are retried — and only when the caller explicitly
 * marked the operation idempotent.
 */
export function isRetryable(error: unknown, idempotent: boolean): boolean {
  if (!idempotent) return false;
  return error instanceof SSHTransportError;
}
