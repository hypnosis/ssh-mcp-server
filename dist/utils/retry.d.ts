/**
 * Retry & Timeout Utility
 * Утилита для повторных попыток с экспоненциальным backoff и timeout
 */
/**
 * Опции для retry функции
 */
export interface RetryOptions {
    /** Максимальное количество попыток (по умолчанию 3) */
    maxAttempts?: number;
    /** Таймаут на операцию в миллисекундах (по умолчанию 30000 = 30 секунд) */
    timeout?: number;
    /** Начальная задержка перед повторной попыткой в миллисекундах (по умолчанию 1000 = 1 секунда) */
    initialDelay?: number;
    /** Множитель для экспоненциального backoff (по умолчанию 2) */
    backoffMultiplier?: number;
    /** Функция для проверки, стоит ли повторять попытку для данной ошибки */
    shouldRetry?: (error: any) => boolean;
}
/**
 * Ошибка таймаута
 */
export declare class TimeoutError extends Error {
    constructor(message?: string);
}
/**
 * Ошибка исчерпания попыток
 */
export declare class RetryExhaustedError extends Error {
    readonly attempts: number;
    readonly lastError: any;
    constructor(attempts: number, lastError: any);
}
/**
 * Выполнить функцию с повторными попытками и таймаутом
 *
 * @param fn - Асинхронная функция для выполнения
 * @param options - Опции retry
 * @returns Результат выполнения функции
 * @throws TimeoutError - если операция превысила timeout
 * @throws RetryExhaustedError - если исчерпаны все попытки
 */
export declare function retryWithTimeout<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
/**
 * Создать функцию shouldRetry для SSH/сетевых ошибок
 * Повторяет попытку для сетевых ошибок и таймаутов, но не для ошибок аутентификации
 */
export declare function createSSHRetryPredicate(): (error: any) => boolean;
//# sourceMappingURL=retry.d.ts.map