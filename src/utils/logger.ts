/**
 * Logger для MCP Server
 * Выводит в stderr (stdout занят MCP протоколом)
 * 
 * ENV variables:
 * - SSH_MCP_LOG_LEVEL: debug, info, warn, error (default: info)
 * - SSH_MCP_LOG_TIMESTAMP: true, false (default: true)
 * - SSH_MCP_LOG_COLORS: true, false (default: false)
 */

import { inspect } from 'util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Context logger (scoped logger)
 */
interface ContextLogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Секреты профилей, которым нельзя попадать в лог.
 *
 * Лог уходит в stderr, то есть прямо в вывод MCP-клиента. Сегодня код пишет
 * туда `hasPassword: true`, а не сам пароль, но это держится на внимательности:
 * одна строка `logger.debug('config:', config)` — и секрет в логе навсегда.
 * Сторож закрывает это в одной точке, независимо от длины секрета.
 */
const loggedSecrets = new Set<string>();

/**
 * Запомнить секрет, который логгер обязан вычищать из своего вывода.
 *
 * Вместе с самим секретом запоминаем его печатную форму: `inspect` экранирует
 * обратный слэш и перевод строки, поэтому пароль `a\b` попадает в лог как
 * `a\\b` и поиск сырой подстроки его не находит (замерено).
 */
export function hideFromLogs(secret: string | undefined): void {
  if (!secret) return;
  loggedSecrets.add(secret);

  const printed = JSON.stringify(secret).slice(1, -1);
  if (printed !== secret) loggedSecrets.add(printed);
}

/** Забыть все секреты — нужно тестам, чтобы прогоны не влияли друг на друга */
export function forgetLoggedSecrets(): void {
  loggedSecrets.clear();
}

function maskSecrets(text: string): string {
  let masked = text;
  for (const secret of loggedSecrets) {
    masked = masked.split(secret).join('***');
  }
  return masked;
}

/**
 * Очистить то, что печатается: строку — напрямую, объект — только если секрет
 * в нём действительно есть (иначе объект теряет читаемый вид на ровном месте).
 *
 * Смотрим на объект через `inspect`, а не через `JSON.stringify`: замер показал,
 * что сериализация в JSON пропускает секрет мимо сторожа сразу тремя путями —
 * `Error` превращается в `{}` (а текст с паролем живёт в message и stack),
 * циклическая ссылка бросает исключение, `Map` сериализуется в пустой объект.
 * `inspect` печатает ровно то же, что увидит человек в логе.
 */
function scrub(value: unknown): unknown {
  if (loggedSecrets.size === 0) return value;
  if (typeof value === 'string') return maskSecrets(value);

  const shown = inspect(value, { depth: 4 });
  const masked = maskSecrets(shown);
  return masked === shown ? value : masked;
}

class Logger {
  private level: LogLevel = 'info';
  private enableTimestamp: boolean = true;
  private enableColors: boolean = false;

  constructor() {
    // Read from environment variables
    this.level = (process.env.SSH_MCP_LOG_LEVEL as LogLevel) || 
                 (process.env.LOG_LEVEL as LogLevel) || 
                 'info';
    this.enableTimestamp = process.env.SSH_MCP_LOG_TIMESTAMP !== 'false';
    this.enableColors = process.env.SSH_MCP_LOG_COLORS === 'true';
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private log(level: LogLevel, message: string, ...args: any[]): void {
    if (!this.shouldLog(level)) return;

    let prefix = '';
    
    // Timestamp
    if (this.enableTimestamp) {
      const timestamp = new Date().toISOString();
      prefix += `[${timestamp}] `;
    }
    
    // Level
    prefix += `[${level.toUpperCase()}]`;
    
    // MCP: stdout для протокола, stderr для логов
    console.error(prefix, maskSecrets(message), ...args.map(scrub));
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args);
  }
  
  /**
   * Create context logger (scoped logger)
   * @param context - Context name (e.g. "ConnectionPool", "SSHExecutor")
   * @returns Context logger
   * 
   * @example
   * const poolLogger = logger.context('ConnectionPool');
   * poolLogger.debug('Creating connection...');
   * // Output: [2025-01-17T12:00:00.000Z] [DEBUG] [ConnectionPool] Creating connection...
   */
  context(context: string): ContextLogger {
    return {
      debug: (msg: string, ...args: any[]) => this.debug(`[${context}] ${msg}`, ...args),
      info: (msg: string, ...args: any[]) => this.info(`[${context}] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => this.warn(`[${context}] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => this.error(`[${context}] ${msg}`, ...args)
    };
  }
  
  /**
   * Performance timer
   * @param label - Timer label
   * @returns Function to end timer
   * 
   * @example
   * const endTimer = logger.time('SSH Connect');
   * // ... connect logic
   * endTimer(); // Logs: [⏱️ SSH Connect] 1234ms
   */
  time(label: string): () => void {
    const start = Date.now();
    
    return () => {
      const duration = Date.now() - start;
      this.debug(`[⏱️ ${label}] ${duration}ms`);
    };
  }
}

// Singleton instance
export const logger = new Logger();
