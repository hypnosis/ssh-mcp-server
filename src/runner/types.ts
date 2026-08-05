/**
 * Command Runner — граница между инструментами и SSH-транспортом
 *
 * Инструменты строят строку shell-команды и получают честный результат.
 * Как именно команда доставлена на сервер (системный ssh, библиотека) —
 * их не касается.
 */

/**
 * Опции выполнения команды
 */
export interface ExecOptions {
  /** Таймаут операции в миллисекундах (по умолчанию 30000) */
  timeoutMs?: number;
  /** Сигнал отмены — прерывает операцию немедленно */
  signal?: AbortSignal;
  /**
   * Безопасно ли повторять операцию при транспортной ошибке.
   * По умолчанию false: повтор мутирующей команды опаснее её отказа.
   */
  idempotent?: boolean;
  /** Данные для stdin команды */
  stdin?: string | Buffer;
  /** Лимит буфера вывода в байтах (по умолчанию 10 МиБ) */
  maxOutputBytes?: number;
  /**
   * Оборачивать ли команду в удалённый `timeout` — чтобы процесс на сервере
   * не пережил убийство локального ssh (по умолчанию true при заданном timeoutMs)
   */
  remoteTimeout?: boolean;
}

/**
 * Результат выполнения команды.
 *
 * Ненулевой exitCode — это результат, а не ошибка: `grep` без совпадений
 * возвращает 1, и это нормальный ответ, а не сбой.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Операция прервана по таймауту (вывод при этом частичный) */
  timedOut: boolean;
  /** Вывод обрезан по maxOutputBytes */
  truncated: boolean;
  durationMs: number;
}

/**
 * Опции передачи файлов
 */
export interface TransferOptions {
  /**
   * Таймаут передачи в миллисекундах. Без него потолка нет: передача идёт
   * столько, сколько нужно, а зависший канал рвёт keepalive транспорта.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Рекурсивная передача каталога */
  recursive?: boolean;
}

/**
 * Результат проверки доступности сервера
 */
export interface PingResult {
  ok: boolean;
  /** Было ли master-соединение живо до проверки */
  masterWasActive: boolean;
  latencyMs: number;
}

/**
 * Состояние транспорта для диагностики (ssh_monitor stats)
 */
export interface RunnerStats {
  /** Способ доставки команд. Транспорт один, поле остаётся частью ответа ssh_monitor */
  backend: 'openssh';
  /** Работает ли мультиплексирование соединений */
  multiplexing: boolean;
  /** Причина, по которой мультиплексирование выключено */
  multiplexingDisabledReason?: string;
  /** Версия системного ssh, если применимо */
  sshVersion?: string;
  /** Живо ли master-соединение прямо сейчас */
  masterActive: boolean;
  masterPid?: number;
  controlPath?: string;
  commandsThisSession: number;
  transfersThisSession: number;
  lastError?: string;
}

/**
 * Чем кончилась попытка закрыть общее соединение.
 *
 * `nothing-to-close` — не отказ: соединение уже ушло по сроку простоя.
 * `multiplexing-off` — закрывать нечего в принципе, соединение не переживает команду.
 */
export type MasterCloseOutcome = 'closed' | 'nothing-to-close' | 'multiplexing-off';

/**
 * Транспорт для выполнения команд и передачи файлов на одном профиле
 */
export interface CommandRunner {
  /** Выполнить команду. Не бросает исключение при ненулевом exitCode. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Загрузить файл или каталог на сервер */
  upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>;

  /** Скачать файл или каталог с сервера */
  download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>;

  /** Проверить доступность сервера */
  ping(options?: { timeoutMs?: number }): Promise<PingResult>;

  /** Состояние транспорта для диагностики */
  stats(): Promise<RunnerStats>;

  /** Закрыть переиспользуемое соединение */
  closeMaster(): Promise<MasterCloseOutcome>;
}
