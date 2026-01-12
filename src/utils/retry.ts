/**
 * Retry & Timeout Utility
 * Утилита для повторных попыток с экспоненциальным backoff и timeout
 */

import { logger } from './logger.js';

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
export class TimeoutError extends Error {
  constructor(message: string = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Ошибка исчерпания попыток
 */
export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly lastError: any;

  constructor(attempts: number, lastError: any) {
    super(`Operation failed after ${attempts} attempts: ${lastError.message}`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
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
export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    timeout = 30000,
    initialDelay = 1000,
    backoffMultiplier = 2,
    shouldRetry = () => true, // По умолчанию повторяем для любых ошибок
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Создаем Promise с таймаутом
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new TimeoutError(`Operation timed out after ${timeout}ms`));
        }, timeout);
      });

      // Выполняем функцию с таймаутом
      const result = await Promise.race([fn(), timeoutPromise]);
      
      // Если успешно выполнено с первой попытки - не логируем
      if (attempt > 1) {
        logger.info(`Operation succeeded on attempt ${attempt}/${maxAttempts}`);
      }
      
      return result;
    } catch (error: any) {
      lastError = error;

      // Если это TimeoutError - не повторяем
      if (error instanceof TimeoutError) {
        logger.error(`Operation timed out on attempt ${attempt}/${maxAttempts}`);
        throw error;
      }

      // Проверяем, стоит ли повторять попытку
      if (!shouldRetry(error)) {
        logger.error(`Operation failed on attempt ${attempt}/${maxAttempts}, not retrying: ${error.message}`);
        throw error;
      }

      // Если это последняя попытка - выбрасываем ошибку
      if (attempt >= maxAttempts) {
        logger.error(`Operation failed after ${maxAttempts} attempts: ${error.message}`);
        throw new RetryExhaustedError(maxAttempts, lastError);
      }

      // Логируем попытку и ждем перед следующей
      logger.warn(`Operation failed on attempt ${attempt}/${maxAttempts}: ${error.message}. Retrying in ${delay}ms...`);
      
      await sleep(delay);
      
      // Увеличиваем задержку для следующей попытки (экспоненциальный backoff)
      delay *= backoffMultiplier;
    }
  }

  // Этот код не должен выполняться, но на всякий случай
  throw new RetryExhaustedError(maxAttempts, lastError);
}

/**
 * Создать функцию shouldRetry для SSH/сетевых ошибок
 * Повторяет попытку для сетевых ошибок и таймаутов, но не для ошибок аутентификации
 */
export function createSSHRetryPredicate(): (error: any) => boolean {
  return (error: any) => {
    // НЕ повторяем для ошибок аутентификации (проверяем ПЕРВЫМИ!)
    if (error.message) {
      const msg = error.message.toLowerCase();
      if (msg.includes('authentication') ||
          msg.includes('permission denied') ||
          msg.includes('publickey')) {
        return false;
      }
    }

    // Повторяем для сетевых ошибок
    if (error.code === 'ECONNREFUSED' || 
        error.code === 'ETIMEDOUT' || 
        error.code === 'ENOTFOUND' ||
        error.code === 'EAI_AGAIN' ||
        error.code === 'ECONNRESET') {
      return true;
    }

    // Повторяем для ошибок с сообщениями о таймауте и сети
    if (error.message) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') ||
          msg.includes('timed out') ||
          msg.includes('connection') ||
          msg.includes('network')) {
        return true;
      }
    }

    // По умолчанию повторяем
    return true;
  };
}

/**
 * Утилита для задержки
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
