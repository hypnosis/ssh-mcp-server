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
import { buildRunnerEnv, ensureAskpassScript } from './askpass.js';
import { classifySpawnOutcome, stripMuxNotices } from './error-classifier.js';
import {
  SSHCancelledError,
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

/** Общий срок команды: его же обещает схема `ssh_exec` через `ssh-executor.ts` */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
/** Запас поверх локального таймаута для удалённого сторожа */
const REMOTE_TIMEOUT_MARGIN_SEC = 5;
/** Сколько ждём ответа на пробу паспорта */
const PASSPORT_PROBE_TIMEOUT_MS = 15000;
/** Пауза перед повтором транспортного сбоя */
const RETRY_DELAY_MS = 1000;

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
  /** Когда команда в последний раз доказала, что master поднят */
  private masterSeenAt = 0;
  private askpassScriptPath?: string;
  /** Последний прочитанный паспорт — для сообщений, где ждать его нельзя */
  private knownPassport?: ServerPassport;
  /** Отвечает ли назначение только классическим протоколом scp */
  private legacyScp = false;

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

  async closeMaster(): Promise<MasterCloseOutcome> {
    if (!this.runtime.multiplexing) return 'multiplexing-off';

    // Профиль снова холодный, каким бы ни был исход закрытия: следующая волна
    // команд обязана идти через шлюз, иначе войдёт каждая по отдельности
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

    // Отсутствие master — норма, а не ошибка: он мог уже истечь по ControlPersist
    logger.debug(`[Runner] ${this.destination}: no master connection to close`);
    return 'nothing-to-close';
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
   * Поднят ли master прямо сейчас.
   *
   * Судим по часам, а не вопросом `ssh -O check`: проба — это лишний процесс
   * на каждую команду. Master держится ControlPersist секунд после последней
   * команды и раньше срока сам не уходит, поэтому в пределах срока ответ
   * «поднят» верен, а за его пределами ворота просто закрываются снова.
   */
  private masterLikelyUp(): boolean {
    const persistSec = resolveControlPersistSec();
    if (persistSec <= 0) return false;
    return Date.now() - this.masterSeenAt < persistSec * 1000;
  }

  /**
   * Выполнить команду, пропустив первую через шлюз.
   *
   * Без шлюза команды холодного профиля открыли бы каждая своё соединение и
   * дали бы залп входов вместо одного. Шлюз закрывается перед каждым холодным
   * стартом, а не однажды за жизнь транспорта: соединение закрывают и по
   * команде, и по сроку простоя, и после этого профиль снова холодный.
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
      // Возвращаемся к началу, а не идём выполнять: если ждали напрасно и
      // master так и не поднялся, первой станет одна команда, а не все сразу
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

    // Ответ сервера отдаём как есть. Раньше из него вырезался секрет профиля,
    // и пароль вида `root` превращал `/etc/passwd` в `***:x:0:0:***:/***`.
    // Скрывать там нечего: секрет на сервер не уезжает (замерено — в окружении
    // удалённой сессии его нет), так что совпадение всегда случайное, а порча
    // молчаливая: прочитанный так конфиг легко записать обратно уже сломанным.
    const stdout = outcome.stdout;
    // Классификатору нужен нетронутый вывод: жалоба на мультиплексирование
    // вместе с разрывом соединения — часть картины сбоя
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
      { spawnError: outcome.spawnError, exitCode: outcome.exitCode, stderr: rawStderr },
      { host: this.config.host, port: this.config.port ?? 22 }
    );

    if (transportError) {
      this.lastError = transportError.message;
      throw transportError;
    }

    // Команда дошла до сервера общим соединением — значит master поднят, и
    // следующим ждать нечего. Команда мимо мультиплексирования этого не
    // доказывает: она ходила своим соединением
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

  /**
   * Передача с откатом на классический протокол.
   *
   * На серверах без подсистемы sftp (роутеры, встраиваемые системы) современный
   * scp обрывается, а классический протокол работает. Отличить такой сервер
   * заранее нечем, поэтому пробуем один раз и запоминаем ответ назначения.
   */
  private async transfer(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    options: TransferOptions
  ): Promise<void> {
    // Счёт ведётся по запрошенным передачам: отказ и повтор другим протоколом —
    // это одна передача, а не две, иначе статистика назвала бы лишнюю
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
   * Одна попытка передачи.
   *
   * Неудачу самой передачи возвращает, а не бросает: вызывающий решает,
   * повторять ли её другим протоколом. Отмена и исчерпание срока — не тот
   * случай, они уходят наверх сразу.
   */
  private async transferOnce(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    options: TransferOptions,
    legacyProtocol: boolean
  ): Promise<Error | undefined> {
    assertProfileSupported(this.config, this.runtime);

    // Своего потолка у передачи нет: не назвали таймаут — она идёт столько,
    // сколько нужно. Прежний общий потолок в 300 секунд обрывал большое
    // дерево и медленный канал, а от зависания не защищал: молчащий канал
    // рвёт сам ssh за минуту силами ServerAliveInterval (замерено).
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

    // У scp ненулевой код всегда означает неудачу передачи —
    // в отличие от произвольной команды, где это может быть нормальный ответ
    if (outcome.exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${outcome.exitCode}`;
      this.lastError = detail;
      return new SSHRunnerError(
        `Failed to ${direction} ${direction === 'upload' ? localPath : remotePath}: ${detail}`,
        { exitCode: outcome.exitCode ?? undefined, stderr }
      );
    }

    return undefined;
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
  ].join('\u0000');

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
