/**
 * Transport on top of the system OpenSSH
 *
 * Connections are reused through the ControlMaster mechanism: the first
 * command brings up the control connection, and every later one rides it —
 * from this process, from a sibling client window, from any other process on
 * the machine. The server sees one login instead of one login per command.
 */

import { logger } from '../utils/logger.js';
import { buildRunnerEnv, ensureAskpassScript } from './askpass.js';
import { classifySpawnOutcome, stripMuxNotices } from './error-classifier.js';
import {
  SSHCancelledError,
  SSHChannelClosedError,
  SSHRunnerError,
  SSHTimeoutError,
  isRetryable,
} from './errors.js';
import {
  getServerPassport,
  passportKey,
  PASSPORT_PROBE_COMMAND,
  type ServerPassport,
} from './passport.js';
import { runProcess } from './process.js';
import { shellQuote } from '../utils/shell-arg.js';
import { hideArtifactNames } from '../utils/tmp-name.js';
import {
  assertProfileSupported,
  detectRuntime,
  toCapabilities,
  type SshRuntime,
} from './runtime-check.js';
import {
  buildControlArgs,
  buildScpArgs,
  buildSshArgs,
  configFingerprint,
  needsAskpass,
  resolveControlPersistSec,
  type RunnerConfig,
  type SshCapabilities,
} from './ssh-args.js';
import type {
  CommandRunner,
  ExecOptions,
  ExecResult,
  MasterCloseOutcome,
  PingResult,
  RunnerStats,
  TransferOptions,
} from './types.js';

/** The default command deadline: also what the `ssh_exec` schema promises via `ssh-executor.ts` */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
/** Margin added on top of the local timeout for the remote guard */
const REMOTE_TIMEOUT_MARGIN_SEC = 5;
/** How long to wait for a response to the passport probe */
const PASSPORT_PROBE_TIMEOUT_MS = 15000;
/** Pause before retrying a transport failure */
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transport for a single destination (user + host + port)
 */
export class OpenSshRunner implements CommandRunner {
  private commandCount = 0;
  private transferCount = 0;
  private lastError?: string;
  /** The first command brings up the master; the rest wait on it to avoid logging in twice */
  private firstCommandGate?: Promise<void>;
  /** When a command last proved the master is up */
  private masterSeenAt = 0;
  private askpassScriptPath?: string;
  /** The last passport read — for messages where waiting for it isn't an option */
  private knownPassport?: ServerPassport;
  /** Whether the destination only speaks the classic scp protocol */
  private legacyScp = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly runtime: SshRuntime
  ) {}

  /** Where this transport connects to — for logs and the cache key */
  get destination(): string {
    return `${this.config.username}@${this.config.host}:${this.config.port ?? 22}`;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    assertProfileSupported(this.config, this.runtime);

    const idempotent = options.idempotent ?? false;
    const maxAttempts = idempotent ? 2 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.execGuarded(command, options, { disableMux: false });
      } catch (error) {
        lastError = error;

        if (isRetryable(error, idempotent) && attempt < maxAttempts) {
          logger.warn(
            `[Runner] ${this.destination}: attempt ${attempt}/${maxAttempts} failed ` +
            `(${(error as Error).message}), retrying`
          );
          await sleep(error instanceof SSHChannelClosedError ? 0 : RETRY_DELAY_MS);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    await this.transfer('upload', localPath, remotePath, options);
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    await this.transfer('download', localPath, remotePath, options);
  }

  async ping(options: { timeoutMs?: number } = {}): Promise<PingResult> {
    const masterWasActive = (await this.checkMaster()).active;
    const startedAt = Date.now();

    try {
      const result = await this.exec('true', {
        timeoutMs: options.timeoutMs ?? 10000,
        idempotent: true,
        remoteTimeout: false,
      });
      return { ok: result.exitCode === 0, masterWasActive, latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, masterWasActive, latencyMs: Date.now() - startedAt };
    }
  }

  async stats(): Promise<RunnerStats> {
    const master = this.runtime.multiplexing
      ? await this.checkMaster()
      : { active: false, pid: undefined };

    return {
      backend: 'openssh',
      multiplexing: this.runtime.multiplexing,
      multiplexingDisabledReason: this.runtime.multiplexingDisabledReason,
      sshVersion: this.runtime.version?.raw,
      masterActive: master.active,
      masterPid: master.pid,
      controlPath: this.runtime.multiplexing ? this.runtime.controlDir : undefined,
      commandsThisSession: this.commandCount,
      transfersThisSession: this.transferCount,
      lastError: this.lastError,
    };
  }

  async closeMaster(): Promise<MasterCloseOutcome> {
    if (!this.runtime.multiplexing) return 'multiplexing-off';

    // The profile goes cold again no matter how the close turns out: the
    // next wave of commands must go through the gate, or each one will log in separately
    this.masterSeenAt = 0;

    const outcome = await runProcess({
      file: 'ssh',
      args: buildControlArgs(this.config, this.capabilities(), 'exit'),
      env: this.buildEnv(),
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });

    if (outcome.exitCode === 0) {
      logger.info(`[Runner] ${this.destination}: master connection closed`);
      return 'closed';
    }

    // No master is normal, not an error: it may have already expired via ControlPersist
    logger.debug(`[Runner] ${this.destination}: no master connection to close`);
    return 'nothing-to-close';
  }

  /** Whether the control connection is alive */
  private async checkMaster(): Promise<{ active: boolean; pid?: number }> {
    if (!this.runtime.multiplexing) return { active: false };

    const outcome = await runProcess({
      file: 'ssh',
      args: buildControlArgs(this.config, this.capabilities(), 'check'),
      env: this.buildEnv(),
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });

    if (outcome.exitCode !== 0) return { active: false };

    const pidMatch = /pid=(\d+)/.exec(outcome.stderr + outcome.stdout);
    return { active: true, pid: pidMatch ? Number(pidMatch[1]) : undefined };
  }

  private capabilities(disableMux = false): SshCapabilities {
    const caps = toCapabilities(this.runtime);
    return disableMux ? { ...caps, multiplexing: false } : caps;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (needsAskpass(this.config) && !this.askpassScriptPath) {
      this.askpassScriptPath = ensureAskpassScript(this.runtime.controlDir);
    }
    return buildRunnerEnv({
      config: this.config,
      askpassScriptPath: this.askpassScriptPath,
    });
  }

  /**
   * Whether the master is up right now.
   *
   * Judged by the clock rather than by asking `ssh -O check`: a probe is an
   * extra process on every command. The master stays up for ControlPersist
   * seconds after the last command and doesn't leave early on its own, so
   * within that window "up" is a correct answer, and past it the gate simply closes again.
   */
  private masterLikelyUp(): boolean {
    const persistSec = resolveControlPersistSec();
    if (persistSec <= 0) return false;
    return Date.now() - this.masterSeenAt < persistSec * 1000;
  }

  /**
   * Run a command, routing the first one through the gate.
   *
   * Without the gate, commands on a cold profile would each open their own
   * connection and fire a burst of logins instead of one. The gate is closed
   * before every cold start, not just once for the transport's lifetime: the
   * connection closes both on command and after the idle deadline, and after
   * that the profile is cold again.
   */
  private async execGuarded(
    command: string,
    options: ExecOptions,
    context: { disableMux: boolean }
  ): Promise<ExecResult> {
    if (!this.runtime.multiplexing || context.disableMux) {
      return this.execOnce(command, options, context);
    }

    if (this.firstCommandGate) {
      // Loop back to the start rather than proceed to execution: if the wait
      // was in vain and the master never came up, only one command becomes
      // first, not all of them at once
      await this.firstCommandGate;
      return this.execGuarded(command, options, context);
    }

    if (this.masterLikelyUp()) {
      return this.execOnce(command, options, context);
    }

    let openGate!: () => void;
    this.firstCommandGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    try {
      return await this.execOnce(command, options, context);
    } finally {
      this.firstCommandGate = undefined;
      openGate();
    }
  }

  private async execOnce(
    command: string,
    options: ExecOptions,
    context: { disableMux: boolean }
  ): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const finalCommand = await this.applyRemoteTimeout(command, options, timeoutMs);

    const outcome = await runProcess({
      file: 'ssh',
      args: buildSshArgs(this.config, this.capabilities(context.disableMux), finalCommand),
      env: this.buildEnv(),
      timeoutMs,
      signal: options.signal,
      stdin: options.stdin,
      maxOutputBytes: options.maxOutputBytes,
    });

    this.commandCount++;

    // The server's response is returned as-is. Redacting the profile secret
    // from it by content match is unsafe: a password like `root` would turn
    // `/etc/passwd` into `***:x:0:0:***:/***`. There's nothing to hide in the
    // first place — the secret never reaches the server, so a match is
    // always coincidental, and the corruption would be silent: a config read
    // this way is easy to write back already broken.
    const stdout = outcome.stdout;
    // The classifier needs untouched output: a multiplexing complaint
    // together with a dropped connection is part of the failure picture
    const rawStderr = outcome.stderr;
    const stderr = stripMuxNotices(rawStderr);

    if (outcome.aborted) {
      throw new SSHCancelledError(`Command cancelled on ${this.destination}`, {
        partialStdout: stdout,
        partialStderr: stderr,
      });
    }

    if (outcome.timedOut) {
      const remoteNote = this.knownPassport?.remoteTimeout
        ? ''
        : ' The remote process may still be running: the server has no `timeout` utility ' +
          'to stop it, and closing the channel does not always terminate the command.';
      this.lastError = `timeout after ${timeoutMs}ms`;
      throw new SSHTimeoutError(
        `Command timed out after ${timeoutMs}ms on ${this.destination}.${remoteNote}`,
        { partialStdout: stdout, partialStderr: stderr }
      );
    }

    const transportError = classifySpawnOutcome(
      { spawnError: outcome.spawnError, exitCode: outcome.exitCode, stderr: rawStderr, stdout },
      {
        host: this.config.host,
        port: this.config.port ?? 22,
        idempotent: options.idempotent ?? false,
      }
    );

    if (transportError) {
      this.lastError = transportError.message;
      throw transportError;
    }

    // The command reached the server over the shared connection — so the
    // master is up, and the next one has nothing to wait for. A command that
    // bypassed multiplexing doesn't prove this: it traveled on its own connection
    if (this.runtime.multiplexing && !context.disableMux) {
      this.masterSeenAt = Date.now();
    }

    return {
      stdout,
      stderr,
      exitCode: outcome.exitCode ?? -1,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
    };
  }

  /**
   * Wrap the command in a remote guard.
   *
   * Killing the local ssh closes the channel, but doesn't necessarily end
   * the process on the server. The `timeout` utility finishes the job.
   *
   * The command language is declared explicitly: bash when it's available,
   * otherwise sh. This matters because on Debian and Ubuntu sh is dash —
   * bash-specific constructs that work fine in a login shell would break
   * under it, and only on some servers.
   */
  private async applyRemoteTimeout(
    command: string,
    options: ExecOptions,
    timeoutMs: number
  ): Promise<string> {
    if (options.remoteTimeout === false || !timeoutMs) return command;

    const passport = await this.passport();
    if (!passport.remoteTimeout) return command;

    const seconds = Math.ceil(timeoutMs / 1000) + REMOTE_TIMEOUT_MARGIN_SEC;
    const shell = passport.bash ? 'bash' : 'sh';
    return `timeout ${seconds} ${shell} -c ${shellQuote(command)}`;
  }

  /**
   * Server passport: one probe per session for a destination.
   *
   * The probe bypasses the first-command gate and the remote guard —
   * otherwise it would be a chicken and egg problem: it's the one finding
   * out the command language, while commands sitting in the gate are
   * themselves waiting on the passport.
   */
  async passport(): Promise<ServerPassport> {
    const passport = await getServerPassport(passportKey(this.config), async () => {
      const result = await this.execOnce(
        PASSPORT_PROBE_COMMAND,
        { timeoutMs: PASSPORT_PROBE_TIMEOUT_MS, remoteTimeout: false },
        { disableMux: false }
      );
      return result.stdout;
    });

    // Also kept locally: the timeout error message needs the passport
    // synchronously, and it can't wait for it there — the failure may have
    // happened inside the probe itself
    this.knownPassport = passport;
    return passport;
  }

  /**
   * Transfer with a fallback to the classic protocol.
   *
   * On servers without an sftp subsystem (routers, embedded systems) modern
   * scp fails, while the classic protocol works. There's no way to tell such
   * a server apart in advance, so it's tried once and the destination's answer is remembered.
   */
  private async transfer(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    options: TransferOptions
  ): Promise<void> {
    // Counted by requested transfers: a failure followed by a retry on
    // another protocol is one transfer, not two, or the stats would overcount
    this.transferCount++;

    const failure = await this.transferOnce(direction, localPath, remotePath, options, this.legacyScp);
    if (!failure) return;

    if (this.legacyScp || !this.runtime.scpOverSftp) throw failure;

    const legacyFailure = await this.transferOnce(direction, localPath, remotePath, options, true);
    if (legacyFailure) throw failure;

    logger.info(`[Runner] ${this.destination}: no sftp subsystem, switching to the classic scp protocol`);
    this.legacyScp = true;
  }

  /**
   * A single transfer attempt.
   *
   * Returns a failed transfer rather than throwing it: the caller decides
   * whether to retry it on another protocol. Cancellation and timeout are a
   * different case — they propagate up right away.
   */
  private async transferOnce(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    options: TransferOptions,
    legacyProtocol: boolean
  ): Promise<Error | undefined> {
    assertProfileSupported(this.config, this.runtime);

    // The transfer has no cap of its own: without a timeout specified, it
    // runs for as long as it needs to. A channel that's gone silent is
    // caught by ssh's own ServerAliveInterval — it closes it within about a minute.
    const timeoutMs = options.timeoutMs;
    const outcome = await runProcess({
      file: 'scp',
      args: buildScpArgs(this.config, this.capabilities(), direction, localPath, remotePath, {
        recursive: options.recursive,
        legacyProtocol,
      }),
      env: this.buildEnv(),
      timeoutMs,
      signal: options.signal,
    });

    const stderr = outcome.stderr;

    if (outcome.aborted) {
      throw new SSHCancelledError(`Transfer cancelled on ${this.destination}`);
    }

    if (outcome.timedOut) {
      this.lastError = `transfer timeout after ${timeoutMs}ms`;
      throw new SSHTimeoutError(
        `Transfer timed out after ${timeoutMs}ms on ${this.destination}`
      );
    }

    const transportError = classifySpawnOutcome(
      { spawnError: outcome.spawnError, exitCode: outcome.exitCode, stderr },
      { host: this.config.host, port: this.config.port ?? 22 }
    );

    if (transportError) {
      this.lastError = transportError.message;
      return transportError;
    }

    // For scp a non-zero code always means the transfer failed —
    // unlike an arbitrary command, where it can be a normal result
    if (outcome.exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${outcome.exitCode}`;
      this.lastError = detail;
      return new SSHRunnerError(
        hideArtifactNames(
          `Failed to ${direction} ${direction === 'upload' ? localPath : remotePath}: ${detail}`
        ),
        { exitCode: outcome.exitCode ?? undefined, stderr }
      );
    }

    return undefined;
  }
}

/**
 * Destination key: the profile name is deliberately left out of it, so a
 * named profile (e.g. "production") and the default profile pointing at the
 * same server share one connection instead of holding two separate ones to the same host.
 */
export function runnerKey(config: RunnerConfig): string {
  return `${config.username}@${config.host}:${config.port ?? 22}`;
}

const runnerCache = new Map<string, OpenSshRunner>();

/**
 * Get the transport for a profile.
 *
 * The key is the destination together with the credential fingerprint, the
 * same one used in the shared socket's name. Two profiles with the same key
 * for one server share a connection; a profile with different credentials
 * gets its own, rather than reusing someone else's or evicting it.
 */
export async function getOpenSshRunner(config: RunnerConfig): Promise<OpenSshRunner> {
  const runtime = await detectRuntime();
  const key = `${runnerKey(config)}#${configFingerprint(config)}`;

  const cached = runnerCache.get(key);
  if (cached) return cached;

  const runner = new OpenSshRunner(config, runtime);
  runnerCache.set(key, runner);
  return runner;
}

/** Close every control connection (used in tests) */
export async function closeAllRunners(): Promise<void> {
  const runners = [...runnerCache.values()];
  runnerCache.clear();
  await Promise.all(runners.map((runner) => runner.closeMaster().catch(() => undefined)));
}

/** Reset the transport cache without touching the connections */
export function resetRunnerCache(): void {
  runnerCache.clear();
}
