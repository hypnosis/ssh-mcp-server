/**
 * Транспорт поверх системного OpenSSH
 *
 * Соединения переиспользуются механизмом ControlMaster: первая команда
 * поднимает управляющее соединение, все последующие идут по нему — из этого
 * процесса, из соседнего окна клиента, из любого другого процесса на машине.
 * Сервер видит один вход вместо одного входа на команду.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { buildRunnerEnv, ensureAskpassScript, redactSecret, selectSecret } from './askpass.js';
import { classifySpawnOutcome } from './error-classifier.js';
import {
  SSHCancelledError,
  SSHMuxLimitError,
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
  needsAskpass,
  type RunnerConfig,
  type SshCapabilities,
} from './ssh-args.js';
import type {
  CommandRunner,
  ExecOptions,
  ExecResult,
  PingResult,
  RunnerStats,
  TransferOptions,
} from './types.js';

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 300000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
/** Запас поверх локального таймаута для удалённого сторожа */
const REMOTE_TIMEOUT_MARGIN_SEC = 5;
/** Сколько ждём ответа на пробу паспорта */
const PASSPORT_PROBE_TIMEOUT_MS = 15000;
/** Пауза перед повтором транспортного сбоя */
const RETRY_DELAY_MS = 1000;

/** Обернуть строку в одинарные кавычки для удалённого shell */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Транспорт для одного назначения (пользователь + хост + порт)
 */
export class OpenSshRunner implements CommandRunner {
  private commandCount = 0;
  private transferCount = 0;
  private lastError?: string;
  /** Первая команда поднимает master; остальные ждут её, чтобы не входить дважды */
  private firstCommandGate?: Promise<void>;
  private askpassScriptPath?: string;
  /** Последний прочитанный паспорт — для сообщений, где ждать его нельзя */
  private knownPassport?: ServerPassport;

  constructor(
    private readonly config: RunnerConfig,
    private readonly runtime: SshRuntime
  ) {}

  /** Куда ходит этот транспорт — для логов и ключа кэша */
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

        // Сессия не открылась — команда точно не выполнялась, поэтому
        // повтор безопасен даже для мутирующих операций
        if (error instanceof SSHMuxLimitError) {
          logger.warn(`[Runner] ${this.destination}: server refused a multiplexed session, retrying without it`);
          return await this.execGuarded(command, options, { disableMux: true });
        }

        if (isRetryable(error, idempotent) && attempt < maxAttempts) {
          logger.warn(
            `[Runner] ${this.destination}: attempt ${attempt}/${maxAttempts} failed ` +
            `(${(error as Error).message}), retrying`
          );
          await sleep(RETRY_DELAY_MS);
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

  async closeMaster(): Promise<void> {
    if (!this.runtime.multiplexing) return;

    const outcome = await runProcess({
      file: 'ssh',
      args: buildControlArgs(this.config, this.capabilities(), 'exit'),
      env: this.buildEnv(),
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });

    if (outcome.exitCode === 0) {
      logger.info(`[Runner] ${this.destination}: master connection closed`);
    } else {
      // Отсутствие master — норма, а не ошибка: он мог уже истечь по ControlPersist
      logger.debug(`[Runner] ${this.destination}: no master connection to close`);
    }
  }

  /** Живо ли управляющее соединение */
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
   * Выполнить команду, пропустив первую через шлюз.
   *
   * Без шлюза две параллельные команды на холодном профиле открыли бы
   * два соединения и дали бы два входа вместо одного.
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
      await this.firstCommandGate;
      return this.execOnce(command, options, context);
    }

    let openGate!: () => void;
    this.firstCommandGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    try {
      return await this.execOnce(command, options, context);
    } finally {
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

    const secret = selectSecret(this.config);
    const stdout = redactSecret(outcome.stdout, secret);
    const stderr = redactSecret(outcome.stderr, secret);

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
      { spawnError: outcome.spawnError, exitCode: outcome.exitCode, stderr },
      { host: this.config.host, port: this.config.port ?? 22 }
    );

    if (transportError) {
      this.lastError = transportError.message;
      throw transportError;
    }

    return {
      stdout,
      stderr,
      exitCode: outcome.exitCode ?? -1,
      timedOut: false,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
    };
  }

  /**
   * Обернуть команду удалённым сторожем.
   *
   * Убийство локального ssh закрывает канал, но не обязательно завершает
   * процесс на сервере. Утилита `timeout` доводит дело до конца.
   *
   * Язык команд объявлен: bash при его наличии, иначе sh. Раньше здесь всегда
   * стоял `sh`, а на Debian и Ubuntu это dash — команды с конструкциями bash,
   * годами работавшие в login-shell, ломались бы после переключения бэкенда,
   * причём только на части серверов.
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
   * Паспорт сервера: одна проба за сессию на назначение.
   *
   * Сама проба идёт без сторожа — иначе получилась бы курица и яйцо, ведь
   * язык команд как раз ею и выясняется.
   */
  private async passport(): Promise<ServerPassport> {
    const passport = await getServerPassport(passportKey(this.config), async () => {
      const result = await this.execOnce(
        PASSPORT_PROBE_COMMAND,
        { timeoutMs: PASSPORT_PROBE_TIMEOUT_MS, remoteTimeout: false },
        { disableMux: false }
      );
      return result.stdout;
    });

    // Запоминаем и у себя: тексту ошибки таймаута паспорт нужен синхронно,
    // а ждать его там нельзя — сбой мог произойти как раз внутри самой пробы
    this.knownPassport = passport;
    return passport;
  }

  private async transfer(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    options: TransferOptions
  ): Promise<void> {
    assertProfileSupported(this.config, this.runtime);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    const outcome = await runProcess({
      file: 'scp',
      args: buildScpArgs(this.config, this.capabilities(), direction, localPath, remotePath, {
        recursive: options.recursive,
      }),
      env: this.buildEnv(),
      timeoutMs,
      signal: options.signal,
    });

    this.transferCount++;

    const secret = selectSecret(this.config);
    const stderr = redactSecret(outcome.stderr, secret);

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
      throw transportError;
    }

    // У scp ненулевой код всегда означает неудачу передачи —
    // в отличие от произвольной команды, где это может быть нормальный ответ
    if (outcome.exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${outcome.exitCode}`;
      this.lastError = detail;
      throw new SSHRunnerError(
        `Failed to ${direction} ${direction === 'upload' ? localPath : remotePath}: ${detail}`,
        { exitCode: outcome.exitCode ?? undefined, stderr }
      );
    }
  }
}

/**
 * Ключ кэша: одно назначение — один транспорт.
 *
 * Именно здесь чинится давняя проблема, из-за которой профиль "production"
 * и опущенный профиль (тот же сервер по умолчанию) держали два отдельных
 * соединения к одному хосту.
 */
export function runnerKey(config: RunnerConfig): string {
  return `${config.username}@${config.host}:${config.port ?? 22}`;
}

/**
 * Отпечаток учётных данных: при их смене переиспользовать соединение нельзя
 */
export function configFingerprint(config: RunnerConfig): string {
  const material = [
    config.privateKeyPath ?? '',
    config.password ?? '',
    config.passphrase ?? '',
    config.strictHostKeyChecking ?? '',
    config.ignoreUserConfig ? '1' : '0',
  ].join(' ');

  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

interface CachedRunner {
  runner: OpenSshRunner;
  fingerprint: string;
}

const runnerCache = new Map<string, CachedRunner>();

/**
 * Получить транспорт для профиля.
 *
 * Транспорты кэшируются по назначению, а не по имени профиля: два профиля,
 * смотрящие на один сервер под одним пользователем, должны делить соединение.
 */
export async function getOpenSshRunner(config: RunnerConfig): Promise<OpenSshRunner> {
  const runtime = await detectRuntime();
  const key = runnerKey(config);
  const fingerprint = configFingerprint(config);
  const cached = runnerCache.get(key);

  if (cached) {
    if (cached.fingerprint === fingerprint) {
      return cached.runner;
    }
    // Учётные данные изменились — иначе старый master продолжил бы
    // ходить на сервер под прежним ключом
    logger.info(`[Runner] ${key}: credentials changed, closing the existing master connection`);
    await cached.runner.closeMaster().catch(() => undefined);
    runnerCache.delete(key);
  }

  const runner = new OpenSshRunner(config, runtime);
  runnerCache.set(key, { runner, fingerprint });
  return runner;
}

/** Закрыть все управляющие соединения (используется в тестах) */
export async function closeAllRunners(): Promise<void> {
  const runners = [...runnerCache.values()];
  runnerCache.clear();
  await Promise.all(runners.map(({ runner }) => runner.closeMaster().catch(() => undefined)));
}

/** Сбросить кэш транспортов, не трогая соединения */
export function resetRunnerCache(): void {
  runnerCache.clear();
}
