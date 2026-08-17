/**
 * Classifying ssh failures
 *
 * The only place that parses OpenSSH's message text. The job is to tell a
 * transport failure (safe to retry) apart from an authentication failure
 * (retrying is harmful: every attempt counts against the server as a failed
 * login) and from an honest non-zero exit code from the remote command
 * (not a failure at all).
 */

import {
  SSHAuthError,
  SSHBinaryMissingError,
  SSHHostKeyError,
  SSHMuxLimitError,
  SSHRunnerError,
  SSHChannelClosedError,
  SSHTransportError,
} from './errors.js';

/** Return code by which ssh reports its own failure */
export const SSH_FAILURE_EXIT_CODE = 255;

/**
 * Observed outcome of running ssh
 */
export interface SpawnOutcome {
  /** Process spawn error (ssh not found, etc.) */
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  stderr: string;
  /** Needed to tell a broken channel apart from a command that itself returned 255 */
  stdout?: string;
}

const AUTH_PATTERNS = [
  /permission denied/i,
  /too many authentication failures/i,
  /no supported authentication methods/i,
  /authentication failed/i,
];

const HOST_KEY_PATTERNS = [
  /host key verification failed/i,
  /remote host identification has changed/i,
  /host key for .* has changed/i,
];

const TRANSPORT_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection reset by peer/i,
  /connection closed by/i,
  /broken pipe/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
];

const MUX_LIMIT_PATTERNS = [
  /mux_client_request_session/i,
  /open failed: administratively prohibited/i,
];

/**
 * Housekeeping chatter between the client and its own control connection.
 *
 * The client handles a session refusal on its own — it opens a separate
 * connection and returns exit code 0. But it still prints a complaint, and
 * that lands in the command's stderr: anyone judging success by non-empty
 * stderr will see an error where there wasn't one.
 */
const MUX_NOTICE_PATTERNS = [
  /^mux_client_\w+: /,
  /^ControlSocket .+ already exists, disabling multiplexing$/,
];

/** Strip multiplexing housekeeping lines from the command output */
export function stripMuxNotices(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !matchesAny(line.replace(/\r$/, ''), MUX_NOTICE_PATTERNS))
    .join('\n');
}

/**
 * A sign that the server dropped an already-established connection.
 * The most common cause is a protective mechanism like fail2ban, and without
 * a hint such an error is easily mistaken for a network glitch.
 */
const SERVER_DROPPED_PATTERNS = [/connection closed by/i, /connection reset by peer/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Whether the output looks like a message from ssh itself, not the remote command
 */
function looksLikeSshDiagnostic(stderr: string): boolean {
  return /^(ssh|scp|ssh_|mux_|kex_|Warning: |Permission denied|Host key)/im.test(stderr);
}

/**
 * Parse the outcome of a run.
 *
 * @returns A transport error, or null if there was no transport failure and
 *          the result should be treated as a plain ExecResult.
 */
export function classifySpawnOutcome(
  outcome: SpawnOutcome,
  context: { host: string; port: number; idempotent?: boolean }
): SSHRunnerError | null {
  const { spawnError, exitCode, stderr } = outcome;

  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      return new SSHBinaryMissingError(
        'OpenSSH client not found in PATH. Install it (macOS: preinstalled; ' +
        'Debian/Ubuntu: apt install openssh-client; Windows: optional feature ' +
        '"OpenSSH Client"), or pin @hypnosis/ssh-mcp-server@1.x to use the ' +
        'bundled SSH implementation.'
      );
    }
    return new SSHTransportError(`Failed to start ssh: ${spawnError.message}`);
  }

  // A non-zero code from the remote command is not a transport failure
  if (exitCode !== SSH_FAILURE_EXIT_CODE) {
    return null;
  }

  const target = `${context.host}:${context.port}`;
  const detail = stderr.trim() || 'no diagnostic output';

  if (matchesAny(stderr, HOST_KEY_PATTERNS)) {
    return new SSHHostKeyError(
      `Host key verification failed for ${target}. If the server was legitimately ` +
      `rebuilt, remove the stale entry with: ssh-keygen -R ${context.host}. ` +
      `Otherwise this may be a man-in-the-middle attempt. Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  if (matchesAny(stderr, AUTH_PATTERNS)) {
    return new SSHAuthError(
      `Authentication failed for ${target}. Check username, key path and key ` +
      `permissions (600). Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  if (matchesAny(stderr, TRANSPORT_PATTERNS)) {
    const hint = matchesAny(stderr, SERVER_DROPPED_PATTERNS)
      ? ' The server accepted the TCP connection and then dropped it — ' +
        'a rate limiter or ban list (fail2ban, sshd MaxStartups) is a likely cause.'
      : '';
    return new SSHTransportError(
      `Cannot reach ${target}. Details: ${detail}${hint}`,
      { exitCode, stderr }
    );
  }

  // Deliberately placed below the transport checks: code 255 is reached only
  // when the separate connection also failed for the client, and the reason
  // there isn't the session limit. Placed higher, this check would misdiagnose it.
  if (matchesAny(stderr, MUX_LIMIT_PATTERNS)) {
    return new SSHMuxLimitError(
      `Server refused an additional multiplexed session on ${target} ` +
      `(MaxSessions reached). Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  // Code 255 with no recognizable message: either ssh reported something new,
  // or the remote command itself returned 255. Told apart by the shape of the output.
  if (looksLikeSshDiagnostic(stderr)) {
    return new SSHTransportError(
      `ssh failed for ${target}. Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  // Code 255 with no output whatsoever — a broken channel: the command never
  // got to print anything because it never ran. This is how dropbear responds
  // to a burst of short commands over a shared connection. The signal isn't
  // strict, so it's only trusted where a retry is declared safe: a command
  // that itself returns 255 remains a plain result for every other call.
  if (context.idempotent && !stderr.trim() && !(outcome.stdout ?? '').trim()) {
    return new SSHChannelClosedError(
      `The channel to ${target} closed before the command produced output.`,
      { exitCode, stderr }
    );
  }

  return null;
}
