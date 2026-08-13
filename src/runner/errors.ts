/**
 * Ошибки SSH-транспорта
 *
 * Бросаются только когда упал сам транспорт. Ненулевой код возврата
 * удалённой команды ошибкой не является — он приходит в ExecResult.
 */

/**
 * Базовая ошибка транспорта
 */
export class SSHRunnerError extends Error {
  /** Код возврата ssh, если процесс успел завершиться */
  public readonly exitCode?: number;
  /** Диагностический вывод ssh */
  public readonly stderr?: string;

  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message);
    this.name = 'SSHRunnerError';
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
  }
}

/**
 * Сетевая или транспортная ошибка — единственный класс, безопасный для повтора
 * (и то лишь для идемпотентных операций)
 */
export class SSHTransportError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHTransportError';
  }
}

/**
 * Канал закрылся, не дав команде ничего напечатать. Соединение при этом живо,
 * поэтому повтор идёт сразу — паузу здесь ждать нечего и некого.
 */
export class SSHChannelClosedError extends SSHTransportError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHChannelClosedError';
  }
}

/**
 * Ошибка аутентификации — повторять бессмысленно и вредно:
 * каждая попытка засчитывается сервером как неудачный вход
 */
export class SSHAuthError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHAuthError';
  }
}

/**
 * Ключ хоста не совпал или неизвестен
 */
export class SSHHostKeyError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHHostKeyError';
  }
}

/**
 * Операция прервана по таймауту.
 *
 * Не повторяется никогда: команда уже стартовала на сервере, и повтор
 * может выполнить мутацию дважды.
 */
export class SSHTimeoutError extends SSHRunnerError {
  /** Частичный вывод, накопленный до срабатывания таймаута */
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
 * Операция отменена вызывающей стороной.
 *
 * От таймаута отличается тем, что это ожидаемый исход, а не сбой:
 * агент передумал или пользователь прервал вызов.
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
 * Системный ssh не найден в PATH
 */
export class SSHBinaryMissingError extends SSHRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'SSHBinaryMissingError';
  }
}

/**
 * Конфигурация профиля несовместима с окружением
 * (например, парольный профиль на OpenSSH старше 8.4)
 */
export class SSHUnsupportedConfigError extends SSHRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'SSHUnsupportedConfigError';
  }
}

/**
 * Достигнут лимит одновременных сессий на сервере (MaxSessions), и открыть
 * отдельное соединение вместо сессии клиенту тоже не удалось: сам по себе
 * отказ в сессии он лечит без нашего участия.
 */
export class SSHMuxLimitError extends SSHRunnerError {
  constructor(message: string, details: { exitCode?: number; stderr?: string } = {}) {
    super(message, details);
    this.name = 'SSHMuxLimitError';
  }
}

/**
 * Можно ли безопасно повторить операцию при этой ошибке.
 *
 * Повторяем только транспортные сбои — и только если вызывающий явно
 * пометил операцию идемпотентной.
 */
export function isRetryable(error: unknown, idempotent: boolean): boolean {
  if (!idempotent) return false;
  return error instanceof SSHTransportError;
}
