/**
 * Environment check: is the system ssh present and what does it support
 *
 * The result is computed once per process: the client version doesn't
 * change on the fly, and spawning a process for every command would be wasteful.
 */

import { execFile } from 'child_process';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { SSHUnsupportedConfigError } from './errors.js';
import { needsAskpass, type RunnerConfig, type SshCapabilities } from './ssh-args.js';

/** Parsed OpenSSH version */
export interface SshVersion {
  major: number;
  minor: number;
  /** Original string, as printed by ssh -V */
  raw: string;
}

/** What the detected client supports */
export interface SshRuntime {
  /** Whether the binary was found */
  available: boolean;
  version?: SshVersion;
  /** Whether connection multiplexing is supported */
  multiplexing: boolean;
  /** Why multiplexing is unavailable */
  multiplexingDisabledReason?: string;
  /** Whether SSH_ASKPASS_REQUIRE=force is supported — without it a password can't be supplied */
  askpassForce: boolean;
  /**
   * Whether file transfers run over SFTP rather than the classic scp protocol.
   * This determines the fate of the remote path: in the classic protocol
   * it's parsed by the server's shell, in SFTP mode the destination path is
   * taken literally.
   */
  scpOverSftp: boolean;
  /** Directory for control sockets and the askpass script */
  controlDir: string;
}

/** ControlPersist first appeared in OpenSSH 5.6 */
const MIN_MULTIPLEXING_VERSION = { major: 5, minor: 6 };
/** SSH_ASKPASS_REQUIRE first appeared in OpenSSH 8.4 */
const MIN_ASKPASS_FORCE_VERSION = { major: 8, minor: 4 };
/** Since OpenSSH 9.0 scp runs file transfers over SFTP by default */
const MIN_SFTP_TRANSFER_VERSION = { major: 9, minor: 0 };

/**
 * The call itself is cached, not its result: there's a wait between checking
 * the cache and running `ssh -V`, and a wave of parallel commands could slip
 * through the check entirely — each running its own detection.
 */
let cachedRuntime: Promise<SshRuntime> | undefined;

/**
 * Parse the output of `ssh -V`
 *
 * Examples: "OpenSSH_10.2p1, LibreSSL 3.3.6",
 *           "OpenSSH_8.9p1 Ubuntu-3ubuntu0.4, OpenSSL 3.0.2",
 *           "OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3"
 */
export function parseSshVersion(output: string): SshVersion | undefined {
  // A build name, as in the Windows port, can sit between OpenSSH_ and the number
  const match = /OpenSSH_(?:[A-Za-z][A-Za-z_]*_)?(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    raw: output.trim().split('\n')[0],
  };
}

/** Whether the version is at least the given minimum */
function isAtLeast(version: SshVersion, minimum: { major: number; minor: number }): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  return version.minor >= minimum.minor;
}

/**
 * Compute capabilities from version and platform — a pure function
 */
export function computeRuntime(input: {
  platform: NodeJS.Platform;
  version?: SshVersion;
  controlDir: string;
}): SshRuntime {
  const { platform, version, controlDir } = input;

  if (!version) {
    return {
      available: false,
      multiplexing: false,
      multiplexingDisabledReason: 'ssh not found',
      askpassForce: false,
      scpOverSftp: false,
      controlDir,
    };
  }

  if (platform === 'win32') {
    // Multiplexing relies on passing descriptors over unix sockets, which
    // Windows doesn't have. Everything else works, but every command will
    // open its own connection.
    return {
      available: true,
      version,
      multiplexing: false,
      multiplexingDisabledReason: 'connection multiplexing is not supported by OpenSSH on Windows',
      askpassForce: false,
      scpOverSftp: isAtLeast(version, MIN_SFTP_TRANSFER_VERSION),
      controlDir,
    };
  }

  const multiplexing = isAtLeast(version, MIN_MULTIPLEXING_VERSION);

  return {
    available: true,
    version,
    multiplexing,
    multiplexingDisabledReason: multiplexing
      ? undefined
      : `ControlPersist requires OpenSSH 5.6+, found ${version.raw}`,
    askpassForce: isAtLeast(version, MIN_ASKPASS_FORCE_VERSION),
    scpOverSftp: isAtLeast(version, MIN_SFTP_TRANSFER_VERSION),
    controlDir,
  };
}

/**
 * Directory for control sockets.
 *
 * Not the system temp directory: a predictable name in a world-readable
 * location is an opportunity to plant a socket of one's own. 0700
 * permissions leave access to the owner only.
 */
export function resolveControlDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SSH_MCP_CONTROL_DIR || join(homedir(), '.ssh', 'ssh-mcp');
}

/** Create the directory with 0700 permissions if it doesn't exist yet */
function ensureControlDir(controlDir: string): void {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
}

/** Run `ssh -V` and return its output */
function readSshVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // ssh -V prints the version to stderr
    execFile('ssh', ['-V'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(undefined);
        return;
      }
      resolve(`${stderr}${stdout}`.trim() || undefined);
    });
  });
}

/**
 * Detect the system ssh and its capabilities (result is cached)
 */
export async function detectRuntime(options: { force?: boolean } = {}): Promise<SshRuntime> {
  if (cachedRuntime && !options.force) {
    return cachedRuntime;
  }

  // Written before the first await: concurrent callers find it already in
  // place and wait on the same call instead of each starting their own
  const pending = readRuntime().catch((error: Error) => {
    cachedRuntime = undefined;
    throw error;
  });

  cachedRuntime = pending;
  return pending;
}

/** Ask the system about the ssh client and prepare the socket directory */
async function readRuntime(): Promise<SshRuntime> {
  const controlDir = resolveControlDir();
  const output = await readSshVersion();
  const version = output ? parseSshVersion(output) : undefined;
  const runtime = computeRuntime({ platform: process.platform, version, controlDir });

  if (!runtime.available) {
    logger.warn('[Runner] OpenSSH client not found in PATH — SSH tools will fail until it is installed');
  } else {
    logger.info(
      `[Runner] ${runtime.version?.raw}, multiplexing: ${runtime.multiplexing ? 'on' : 'off'}` +
      (runtime.multiplexingDisabledReason ? ` (${runtime.multiplexingDisabledReason})` : '')
    );
    if (runtime.multiplexing) {
      ensureControlDir(controlDir);
    }
  }

  return runtime;
}

/** Reset the cache — used in tests */
export function resetRuntimeCache(): void {
  cachedRuntime = undefined;
}

/** Capabilities in the shape expected by argument building */
export function toCapabilities(runtime: SshRuntime): SshCapabilities {
  return {
    multiplexing: runtime.multiplexing,
    controlDir: runtime.controlDir,
    scpOverSftp: runtime.scpOverSftp,
  };
}

/**
 * Check that the environment can handle this profile.
 *
 * @throws SSHUnsupportedConfigError if the profile needs secret input
 *         and the client can't do that
 */
export function assertProfileSupported(config: RunnerConfig, runtime: SshRuntime): void {
  if (!needsAskpass(config)) return;

  if (process.platform === 'win32') {
    throw new SSHUnsupportedConfigError(
      'Password and passphrase authentication is not supported on Windows with the ' +
      'OpenSSH backend. Use a passphrase-less key (privateKeyPath), or pin ' +
      '@hypnosis/ssh-mcp-server@1.x.'
    );
  }

  if (!runtime.askpassForce) {
    throw new SSHUnsupportedConfigError(
      `Password and passphrase authentication requires OpenSSH 8.4+ ` +
      `(SSH_ASKPASS_REQUIRE), found ${runtime.version?.raw ?? 'unknown version'}. ` +
      `Upgrade OpenSSH, or use a passphrase-less key (privateKeyPath).`
    );
  }
}
