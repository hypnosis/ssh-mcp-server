/**
 * Building arguments for the system ssh/scp
 *
 * Pure functions with no side effects: profile configuration goes in, an
 * argument array comes out. The array is passed to spawn without a shell, so
 * special characters in paths and names can't be interpreted.
 *
 * Secrets (password, passphrase) never appear here: process arguments are
 * visible via `ps` to any user on the system. The secret is delivered through askpass.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/**
 * Profile configuration for the transport.
 *
 * Matches the profile configuration: transport settings (host key checking,
 * opting out of ~/.ssh/config) live alongside host and username — they're
 * part of the profile format, not a separate entity.
 */
export type RunnerConfig = SSHConfig;

/**
 * Environment capabilities that affect the argument set
 */
export interface SshCapabilities {
  /** Whether multiplexing is supported (not on native Windows) */
  multiplexing: boolean;
  /** Directory for control sockets (0700 permissions) */
  controlDir: string;
  /**
   * Whether scp transfers files over SFTP (client 9.0+). This determines the
   * fate of the remote path: in the classic protocol it's parsed by the
   * server's shell, in SFTP mode the destination path is taken literally.
   */
  scpOverSftp: boolean;
}

/**
 * Settings that have sensible defaults
 */
export interface SshArgsOptions {
  /** Connection setup timeout, seconds */
  connectTimeoutSec?: number;
  /** Keepalive probe interval, seconds */
  serverAliveIntervalSec?: number;
  /** How many unanswered probes count as a dropped connection */
  serverAliveCountMax?: number;
}

const DEFAULT_CONTROL_PERSIST_SEC = 600;
const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
/** A control socket's name starts with this — also how it's recognized in the directory */
export const CONTROL_SOCKET_PREFIX = 's-';
const DEFAULT_SERVER_ALIVE_INTERVAL_SEC = 15;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;

/** An unrecognized variable value is warned about once, not on every command */
let unknownPersistReported = false;

/**
 * How long the connection lives after the last command, in seconds.
 *
 * The single source of truth: this value flows both into the ssh command and
 * into tool responses about what's left running on the machine. Zero means "close immediately".
 */
export function resolveControlPersistSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SSH_MCP_CONTROL_PERSIST?.trim();
  if (!raw) return DEFAULT_CONTROL_PERSIST_SEC;

  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;

  if (!unknownPersistReported) {
    unknownPersistReported = true;
    logger.warn(
      `[Runner] Unusable SSH_MCP_CONTROL_PERSIST "${raw}", falling back to ${DEFAULT_CONTROL_PERSIST_SEC}. ` +
      `Expected a whole number of seconds, 0 to close immediately`
    );
  }

  return DEFAULT_CONTROL_PERSIST_SEC;
}

/** Forget that the value was already warned about (used in tests) */
export function resetControlPersistWarning(): void {
  unknownPersistReported = false;
}

/**
 * A value that ssh would take as an option rather than an argument.
 * A host like "-oProxyCommand=..." in a profile is a command substitution, not a host.
 */
function assertNotOptionLike(value: string, fieldName: string): void {
  if (value.startsWith('-')) {
    throw new Error(
      `Invalid ${fieldName} "${value}": value must not start with "-" ` +
      `(it would be interpreted as an ssh option)`
    );
  }
}

/**
 * Whether the profile needs interactive secret input via askpass
 */
export function needsAskpass(config: RunnerConfig): boolean {
  return Boolean(config.password || config.passphrase);
}

/**
 * Credential fingerprint: profiles with different keys don't share a connection.
 */
export function configFingerprint(config: RunnerConfig): string {
  const material = [
    config.privateKeyPath ?? '',
    config.password ?? '',
    config.passphrase ?? '',
    config.strictHostKeyChecking ?? '',
    config.ignoreUserConfig ? '1' : '0',
  ].join('\u0000');

  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Path to the control socket.
 *
 * The name is a hash of the destination and the credentials. The
 * destination makes the socket shared across every client process: separate
 * windows land on the same connection, which is the whole point of
 * multiplexing. The credentials in the name are mandatory: without them a
 * profile with no key would ride on a connection brought up by someone
 * else's key — the socket doesn't check access, it already grants it.
 *
 * Computed ourselves rather than via the client's `%C`: that only knows
 * host, port and username. Path length matters — the unix socket address
 * limit on macOS is 104 bytes.
 */
export function buildControlPath(controlDir: string, config: RunnerConfig): string {
  const material = [
    config.host,
    String(config.port ?? 22),
    config.username,
    configFingerprint(config),
  ].join('\u0000');

  const fingerprint = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `${controlDir}/${CONTROL_SOCKET_PREFIX}${fingerprint}`;
}

/**
 * Options shared by ssh and scp
 */
export function buildCommonOptions(
  config: RunnerConfig,
  caps: SshCapabilities,
  options: SshArgsOptions = {}
): string[] {
  assertNotOptionLike(config.host, 'host');
  assertNotOptionLike(config.username, 'username');
  if (config.privateKeyPath) {
    assertNotOptionLike(config.privateKeyPath, 'privateKeyPath');
  }

  const {
    connectTimeoutSec = DEFAULT_CONNECT_TIMEOUT_SEC,
    serverAliveIntervalSec = DEFAULT_SERVER_ALIVE_INTERVAL_SEC,
    serverAliveCountMax = DEFAULT_SERVER_ALIVE_COUNT_MAX,
  } = options;

  const args: string[] = [];

  // The user's ~/.ssh/config is read by default: it gives ProxyJump,
  // ssh-agent and algorithm policies for free. Our -o flags always override it.
  if (config.ignoreUserConfig) {
    args.push('-F', process.platform === 'win32' ? 'NUL' : '/dev/null');
  }

  // Multiplexing is what this is all for: one authentication per
  // ControlPersist window instead of one per command.
  if (caps.multiplexing) {
    args.push('-o', 'ControlMaster=auto');
    args.push('-o', `ControlPath=${buildControlPath(caps.controlDir, config)}`);
    args.push('-o', `ControlPersist=${resolveControlPersistSec()}`);
  }

  // Built-in keepalive instead of homemade pings via a command
  args.push('-o', `ServerAliveInterval=${serverAliveIntervalSec}`);
  args.push('-o', `ServerAliveCountMax=${serverAliveCountMax}`);
  args.push('-o', `ConnectTimeout=${connectTimeoutSec}`);

  args.push('-o', `StrictHostKeyChecking=${config.strictHostKeyChecking ?? 'accept-new'}`);

  // Without this, warnings like "Permanently added ..." land in stderr
  // and break error classification
  args.push('-o', 'LogLevel=ERROR');

  args.push('-o', `User=${config.username}`);

  if (config.privateKeyPath) {
    args.push('-o', `IdentityFile=${config.privateKeyPath}`);
    // Without IdentitiesOnly the client offers every agent key in turn, and
    // the server counts each rejected one as a failed login attempt
    args.push('-o', 'IdentitiesOnly=yes');
  } else if (config.password) {
    args.push('-o', 'PubkeyAuthentication=no');
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
    args.push('-o', 'NumberOfPasswordPrompts=1');
  }

  // BatchMode blocks any input prompt, askpass included. It can't be set for
  // profiles with a password or passphrase — there'd be nowhere to feed the secret.
  if (!needsAskpass(config)) {
    args.push('-o', 'BatchMode=yes');
  }

  return args;
}

/**
 * Arguments for running a command: ssh [options] <host> <command>
 */
export function buildSshArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  command: string,
  options: SshArgsOptions & { requestTty?: boolean } = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);

  args.push('-p', String(config.port ?? 22));

  if (options.requestTty) {
    // -tt forces a pseudo-terminal even without a local tty. Needed by
    // programs that read /dev/tty directly. Side effect — stderr merges into stdout.
    args.push('-tt');
  }

  args.push(config.host);
  args.push(command);

  return args;
}

/**
 * Arguments for a control command: ssh -O check|exit <host>
 */
export function buildControlArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  controlCommand: 'check' | 'exit' | 'stop',
  options: SshArgsOptions = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);
  args.push('-p', String(config.port ?? 22));
  args.push('-O', controlCommand);
  args.push(config.host);
  return args;
}

/**
 * What happens to the remote path on its way to the server.
 *
 * - `literal` — the upload destination in SFTP mode. The path travels as-is,
 *   and a backslash would become part of the name: the file would land under
 *   the name `a\ b.txt`, breaking verification, renaming and cleanup right
 *   after — they look for the path without it.
 * - `glob` — the download source. Patterns are expanded by the client, so
 *   `star*name.txt` pulls in three unrelated files; a backslash escape avoids that.
 * - `shell` — the classic protocol (clients before 9.0). The path is parsed
 *   by the server's shell: a space splits it into two arguments, and `$(id)` gets executed.
 */
export type RemotePathUse = 'literal' | 'glob' | 'shell';

/**
 * Prepare a remote path for transfer.
 *
 * Backslash-escaping is the only thing that works: single quotes become part
 * of the name in SFTP mode, and produce a `protocol error` in the classic one.
 *
 * The path separator, safe ASCII letters and digits, the tilde, and anything
 * outside ASCII are left untouched. The tilde, because the server expands
 * it, and `\~/app.conf` would land in a nonexistent directory named `~`.
 * Cyrillic, because it works fine without escaping.
 *
 * Newline and carriage return are not escaped: a `\` right before a newline
 * means line continuation, the character disappears, and the name becomes
 * different. In SFTP mode such a path works as-is, while in the classic
 * protocol the rest of the line runs on the server as a command — so it's
 * rejected there instead.
 */
export function prepareRemotePath(remotePath: string, use: RemotePathUse): string {
  if (use === 'literal') return remotePath;

  if (use === 'shell' && /[\n\r]/.test(remotePath)) {
    throw new Error(
      `Invalid remote path ${JSON.stringify(remotePath)}: a newline cannot be passed safely ` +
        'to the classic scp protocol (OpenSSH before 9.0) — the rest of the line would run ' +
        'on the server as a command'
    );
  }

  return escapeRemotePath(remotePath);
}

/** Escape everything the remote side would read as syntax rather than as part of the name */
export function escapeRemotePath(remotePath: string): string {
  return remotePath.replace(/[^A-Za-z0-9._/~\n\r\u0080-\uFFFF-]/g, (char) => `\\${char}`);
}

/**
 * Remote path in scp format.
 *
 * An IPv6 address is wrapped in brackets, otherwise the colons inside it
 * would be read as the host/path separator.
 */
export function buildRemoteSpec(host: string, remotePath: string): string {
  const isIPv6 = host.includes(':');
  const hostPart = isIPv6 ? `[${host}]` : host;
  return `${hostPart}:${remotePath}`;
}

/**
 * Local path for scp.
 *
 * A path containing a colon before its first slash would be taken by scp as
 * remote, and a path starting with a dash as an option. The "./" prefix
 * clears up both ambiguities.
 */
export function normalizeLocalSpec(localPath: string): string {
  const firstSlash = localPath.indexOf('/');
  const firstColon = localPath.indexOf(':');
  const colonLooksRemote = firstColon !== -1 && (firstSlash === -1 || firstColon < firstSlash);
  const looksLikeOption = localPath.startsWith('-');

  if ((colonLooksRemote || looksLikeOption) && !localPath.startsWith('/') && !localPath.startsWith('./')) {
    return `./${localPath}`;
  }
  return localPath;
}

/**
 * Arguments for a file transfer: scp [options] <src> <dst>
 *
 * scp reuses the same master connection as ssh, because it gets the same
 * ControlPath/ControlMaster — a file transfer doesn't create a new login.
 */
export function buildScpArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  direction: 'upload' | 'download',
  localPath: string,
  remotePath: string,
  options: SshArgsOptions & { recursive?: boolean; legacyProtocol?: boolean } = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);

  // scp takes the port as capital -P, unlike ssh
  args.push('-P', String(config.port ?? 22));
  args.push('-q');

  // The classic protocol instead of SFTP: on clients before 9.0 it's the
  // only one anyway, so the flag is only needed on newer ones
  const classicProtocol = options.legacyProtocol || !caps.scpOverSftp;
  if (options.legacyProtocol && caps.scpOverSftp) {
    args.push('-O');
  }

  if (options.recursive) {
    args.push('-r');
  }

  const localSpec = normalizeLocalSpec(localPath);
  // The upload destination in SFTP mode is the one path that travels
  // literally: escaping it would turn the backslash into part of the name
  const use: RemotePathUse = classicProtocol ? 'shell' : direction === 'upload' ? 'literal' : 'glob';
  const remoteSpec = buildRemoteSpec(config.host, prepareRemotePath(remotePath, use));

  if (direction === 'upload') {
    args.push(localSpec, remoteSpec);
  } else {
    args.push(remoteSpec, localSpec);
  }

  return args;
}
