/**
 * Транспорт поверх библиотеки ssh2 — совместимость на время перехода
 *
 * Соединения живут в пуле внутри процесса, поэтому переиспользовать их между
 * окнами клиента нельзя: каждое окно — свой процесс MCP-сервера со своим пулом.
 * Адаптер существует ради одного — привести старый транспорт к контракту
 * CommandRunner, чтобы флаг SSH_MCP_BACKEND переключал только способ доставки
 * команды, а не поведение инструментов. Удаляется вместе с пулом на шаге 7.
 */

import { mkdir, readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { posix as posixPath } from 'path';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { ConnectionPool } from '../managers/connection-pool.js';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import {
  SSHAuthError,
  SSHCancelledError,
  SSHHostKeyError,
  SSHRunnerError,
  SSHTimeoutError,
  SSHTransportError,
  isRetryable,
} from './errors.js';
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
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_PING_TIMEOUT_MS = 10000;
/** Пауза перед повтором транспортного сбоя */
const RETRY_DELAY_MS = 1000;

const MULTIPLEXING_DISABLED_REASON =
  'the ssh2 backend pools connections inside this process, so other windows and ' +
  'subagents open their own; switch to SSH_MCP_BACKEND=openssh for shared connections';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Обернуть строку в одинарные кавычки для удалённого shell */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Превратить колбэк SFTP в промис */
function promisifyTransfer(
  start: (done: (err: Error | null | undefined) => void) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    start((err) => (err ? reject(err) : resolve()));
  });
}

/** Относительные пути всех файлов каталога; символические ссылки пропускаются */
async function walkLocalDir(root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? join(root, relative) : root;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };

  await walk('');
  return files;
}

/** То же для удалённого каталога — через SFTP-листинг */
async function walkRemoteDir(sftp: SFTPWrapper, root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? posixPath.join(root, relative) : root;
    const entries = await new Promise<Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean } }>>(
      (resolve, reject) => {
        sftp.readdir(absolute, (err, list) => (err ? reject(err) : resolve(list as never)));
      }
    );

    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.filename}` : entry.filename;
      if (entry.attrs.isDirectory()) await walk(child);
      else if (entry.attrs.isFile()) files.push(child);
    }
  };

  await walk('');
  return files;
}

/**
 * Отличить отказ в доступе от сетевого сбоя.
 *
 * Разница не косметическая: транспортный сбой безопасно повторить, а повтор
 * неудачной аутентификации — это ещё один неудачный вход в журнале сервера.
 */
function classifyConnectionError(error: unknown, destination: string): SSHRunnerError {
  const message = error instanceof Error ? error.message : String(error);

  if (/authentication|SSH key|private key|privateKey|passphrase/i.test(message)) {
    return new SSHAuthError(`Authentication failed for ${destination}: ${message}`);
  }

  if (/host key|known.?hosts/i.test(message)) {
    return new SSHHostKeyError(`Host key problem for ${destination}: ${message}`);
  }

  return new SSHTransportError(`Failed to connect to ${destination}: ${message}`);
}

/**
 * Транспорт для одного профиля поверх пула соединений ssh2
 */
export class Ssh2Runner implements CommandRunner {
  private commandCount = 0;
  private transferCount = 0;
  private lastError?: string;

  constructor(
    private readonly config: SSHConfig,
    private readonly profileName: string
  ) {}

  get destination(): string {
    return `${this.config.username}@${this.config.host}:${this.config.port ?? 22}`;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const idempotent = options.idempotent ?? false;
    const maxAttempts = idempotent ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.execOnce(command, options);
      } catch (error) {
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

    // Недостижимо: цикл либо возвращает результат, либо бросает
    throw new SSHRunnerError(`Command was not executed on ${this.destination}`);
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    if (options.recursive) {
      await this.uploadDirectory(localPath, remotePath, options);
      return;
    }

    await this.withSftp(
      (sftp) => promisifyTransfer((done) => sftp.fastPut(localPath, remotePath, {}, done)),
      `upload ${localPath}`,
      options
    );
  }

  async download(
    remotePath: string,
    localPath: string,
    options: TransferOptions = {}
  ): Promise<void> {
    if (options.recursive) {
      await this.downloadDirectory(remotePath, localPath, options);
      return;
    }

    await this.withSftp(
      (sftp) => promisifyTransfer((done) => sftp.fastGet(remotePath, localPath, {}, done)),
      `download ${remotePath}`,
      options
    );
  }

  async ping(options: { timeoutMs?: number } = {}): Promise<PingResult> {
    const masterWasActive = this.isPooled();
    const startedAt = Date.now();

    try {
      const result = await this.exec('true', {
        timeoutMs: options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
        idempotent: true,
      });
      return { ok: result.exitCode === 0, masterWasActive, latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, masterWasActive, latencyMs: Date.now() - startedAt };
    }
  }

  async stats(): Promise<RunnerStats> {
    return {
      backend: 'ssh2',
      multiplexing: false,
      multiplexingDisabledReason: MULTIPLEXING_DISABLED_REASON,
      masterActive: this.isPooled(),
      commandsThisSession: this.commandCount,
      transfersThisSession: this.transferCount,
      lastError: this.lastError,
    };
  }

  async closeMaster(): Promise<void> {
    await ConnectionPool.getInstance().closeClient(this.profileName);
  }

  /** Есть ли живое соединение профиля в пуле */
  private isPooled(): boolean {
    return ConnectionPool.getInstance().isConnected(this.profileName);
  }

  /**
   * Загрузить каталог: SFTP умеет только файлы, обход делаем сами.
   *
   * Каталоги создаются одной командой заранее — `fastPut` их не создаёт,
   * а по команде на каталог это лишние обращения к серверу.
   */
  private async uploadDirectory(
    localDir: string,
    remoteDir: string,
    options: TransferOptions
  ): Promise<void> {
    const files = await walkLocalDir(localDir);
    if (files.length === 0) return;

    const directories = new Set<string>([remoteDir]);
    for (const relative of files) {
      const parent = posixPath.dirname(relative);
      if (parent && parent !== '.') directories.add(posixPath.join(remoteDir, parent));
    }

    const quoted = [...directories].map(shellQuote).join(' ');
    const created = await this.exec(`mkdir -p ${quoted}`, { timeoutMs: options.timeoutMs });
    // Без этой проверки передача упала бы дальше — на «No such file» от fastPut,
    // где уже не видно, что настоящая причина в правах на каталог
    if (created.exitCode !== 0) {
      const detail = created.stderr.trim() || `exit code ${created.exitCode}`;
      throw new SSHRunnerError(`Failed to create remote directories under ${remoteDir}: ${detail}`);
    }

    await this.withSftp(
      async (sftp) => {
        for (const relative of files) {
          const local = join(localDir, relative);
          const remote = posixPath.join(remoteDir, relative);
          await promisifyTransfer((done) => sftp.fastPut(local, remote, {}, done));
        }
      },
      `upload ${localDir}`,
      options
    );
  }

  /**
   * Скачать каталог: удалённое дерево обходится через SFTP, локальные
   * каталоги создаются по мере надобности.
   */
  private async downloadDirectory(
    remoteDir: string,
    localDir: string,
    options: TransferOptions
  ): Promise<void> {
    await this.withSftp(
      async (sftp) => {
        const files = await walkRemoteDir(sftp, remoteDir);

        await mkdir(localDir, { recursive: true });
        for (const relative of files) {
          const local = join(localDir, relative);
          await mkdir(dirname(local), { recursive: true });
          await promisifyTransfer((done) =>
            sftp.fastGet(posixPath.join(remoteDir, relative), local, {}, done)
          );
        }
      },
      `download ${remoteDir}`,
      options
    );
  }

  private async execOnce(command: string, options: ExecOptions): Promise<ExecResult> {
    const startedAt = Date.now();
    const pool = ConnectionPool.getInstance();

    let client: Client;
    try {
      client = (await pool.getClient(this.profileName, this.config)) as Client;
    } catch (error) {
      const classified = classifyConnectionError(error, this.destination);
      this.lastError = classified.message;
      throw classified;
    }

    try {
      const result = await this.runOnClient(client, command, options, startedAt);
      this.commandCount++;
      return result;
    } finally {
      pool.releaseClient(this.profileName);
    }
  }

  /**
   * Выполнить команду на открытом канале.
   *
   * Ключевое отличие от SSHManager.executeOnClient: ненулевой код возврата
   * здесь не исключение, а поле результата, и stderr не склеивается с stdout.
   */
  private runOnClient(
    client: Client,
    command: string,
    options: ExecOptions,
    startedAt: number
  ): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      let channel: ClientChannel | undefined;

      const timer = setTimeout(() => {
        this.lastError = `timeout after ${timeoutMs}ms`;
        finish(() =>
          reject(
            new SSHTimeoutError(
              `Command timed out after ${timeoutMs}ms on ${this.destination}`,
              { partialStdout: stdout, partialStderr: stderr }
            )
          )
        );
      }, timeoutMs);

      const onAbort = () => {
        finish(() =>
          reject(
            new SSHCancelledError(`Command cancelled on ${this.destination}`, {
              partialStdout: stdout,
              partialStderr: stderr,
            })
          )
        );
      };

      /** Снять таймер и подписки один раз, затем отдать исход */
      function finish(settle: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        // Канал закрывается явно: без этого удалённая команда продолжит
        // писать в него после того, как мы уже ответили вызывающему
        channel?.close();
        settle();
      }

      /** Накопить вывод, не выходя за лимит буфера */
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        const current = target === 'stdout' ? stdout : stderr;
        const room = maxOutputBytes - current.length;

        if (room <= 0) {
          truncated = true;
          return;
        }

        const text = chunk.toString('utf8');
        const piece = text.length > room ? text.slice(0, room) : text;
        if (piece.length < text.length) truncated = true;

        if (target === 'stdout') stdout += piece;
        else stderr += piece;
      };

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      client.exec(command, (err, stream) => {
        if (err) {
          this.lastError = err.message;
          finish(() =>
            reject(
              new SSHTransportError(
                `Failed to open a command channel on ${this.destination}: ${err.message}`
              )
            )
          );
          return;
        }

        channel = stream;

        stream.on('data', (chunk: Buffer) => append('stdout', chunk));
        stream.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

        stream.on('close', (code: number | null) => {
          finish(() =>
            resolve({
              stdout,
              stderr,
              exitCode: code ?? -1,
              timedOut: false,
              truncated,
              durationMs: Date.now() - startedAt,
            })
          );
        });

        if (options.stdin !== undefined) {
          stream.write(options.stdin);
          stream.end();
        }
      });
    });
  }

  /**
   * Общая обвязка передачи: канал SFTP, таймаут, возврат канала пулу.
   *
   * Канал один на всю операцию — при передаче каталога открывать его на
   * каждый файл было бы расточительно. Таймаут здесь появляется впервые:
   * у прежних прямых вызовов fastPut/fastGet его не было вообще, и оборванная
   * передача висела бесконечно.
   */
  private async withSftp(
    operation: (sftp: SFTPWrapper) => Promise<void>,
    label: string,
    options: TransferOptions
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    const pool = ConnectionPool.getInstance();

    let sftp: SFTPWrapper;
    try {
      sftp = await pool.getSftp(this.profileName, this.config);
    } catch (error) {
      const classified = classifyConnectionError(error, this.destination);
      this.lastError = classified.message;
      throw classified;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          settle();
        };

        const timer = setTimeout(() => {
          this.lastError = `transfer timeout after ${timeoutMs}ms`;
          finish(() =>
            reject(
              new SSHTimeoutError(
                `Failed to ${label}: timed out after ${timeoutMs}ms on ${this.destination}`
              )
            )
          );
        }, timeoutMs);

        const onAbort = () => {
          finish(() => reject(new SSHCancelledError(`Transfer cancelled on ${this.destination}`)));
        };

        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });

        operation(sftp).then(
          () => finish(resolve),
          (error: Error) => {
            this.lastError = error.message;
            finish(() => reject(new SSHRunnerError(`Failed to ${label}: ${error.message}`)));
          }
        );
      });

      this.transferCount++;
    } finally {
      sftp.end();
      pool.releaseClient(this.profileName);
    }
  }
}
