/**
 * Запуск дочернего процесса с таймаутом, отменой и лимитом вывода
 *
 * Команда и аргументы передаются массивом, shell не участвует — спецсимволы
 * в путях и именах интерпретироваться не могут.
 *
 * Главное отличие от прежнего подхода: таймаут здесь действительно
 * останавливает работу, а не просто перестаёт её ждать. Процесс получает
 * SIGTERM, а если не завершился — SIGKILL.
 */

import { spawn } from 'child_process';

/** Сколько ждать после SIGTERM, прежде чем послать SIGKILL */
const DEFAULT_KILL_GRACE_MS = 5000;
/** Лимит накопленного вывода: 10 МиБ */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ProcessRunOptions {
  /** Исполняемый файл: ssh, scp */
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Данные для stdin; без них stdin закрывается сразу */
  stdin?: string | Buffer;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export interface ProcessRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Сигнал, которым процесс был убит */
  signalCode: NodeJS.Signals | null;
  /** Процесс остановлен нами по истечении таймаута */
  timedOut: boolean;
  /** Процесс остановлен нами по сигналу отмены */
  aborted: boolean;
  /** Вывод превысил лимит и был обрезан */
  truncated: boolean;
  durationMs: number;
  /** Процесс не удалось запустить */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Накопитель вывода с ограничением объёма.
 *
 * Чтение из потока не прекращается после достижения лимита: если перестать
 * читать, процесс заблокируется на записи и никогда не завершится.
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
    // Склеиваем в буфер, а не в строку по частям: многобайтовый символ
    // может оказаться разрезанным на границе чанков
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Запустить процесс и дождаться его завершения.
 *
 * Не бросает исключений: любой исход, включая неудачный запуск,
 * возвращается в описании результата.
 */
export function runProcess(options: ProcessRunOptions): Promise<ProcessRunOutcome> {
  const {
    file,
    args,
    env,
    timeoutMs,
    signal,
    stdin,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
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

    /** Остановить процесс: сначала вежливо, затем принудительно */
    const terminate = (): void => {
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

    if (child.stdin) {
      // Ошибку записи глушим: процесс мог уже завершиться, и это
      // не должно ронять весь запуск
      child.stdin.on('error', () => undefined);
      if (stdin !== undefined) {
        child.stdin.end(stdin);
      } else {
        // Без закрытия stdin команда, читающая ввод, зависла бы до таймаута
        child.stdin.end();
      }
    }
  });
}
