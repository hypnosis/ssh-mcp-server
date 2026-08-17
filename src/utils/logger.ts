/**
 * Logger for the MCP server
 * Writes to stderr (stdout is taken by the MCP protocol)
 *
 * ENV variables:
 * - SSH_MCP_LOG_LEVEL: debug, info, warn, error (default: info)
 * - SSH_MCP_LOG_TIMESTAMP: true, false (default: true)
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
 * Profile secrets that must never reach the log.
 *
 * The log goes to stderr, i.e. straight into the MCP client's output. Today
 * the code writes `hasPassword: true` there, not the password itself, but
 * that holds only as long as everyone stays careful: one line like
 * `logger.debug('config:', config)` and the secret is in the log for good.
 * The guard closes that off in a single place, regardless of the secret's length.
 */
const loggedSecrets = new Set<string>();

/**
 * Remember a secret the logger must scrub from its output.
 *
 * Along with the secret itself, its printed form is remembered too: `inspect`
 * escapes backslashes and newlines, so a password `a\b` ends up in the log as
 * `a\\b`, and searching for the raw substring would miss it.
 */
export function hideFromLogs(secret: string | undefined): void {
  if (!secret) return;
  loggedSecrets.add(secret);

  const printed = JSON.stringify(secret).slice(1, -1);
  if (printed !== secret) loggedSecrets.add(printed);
}

/** Forget all secrets — needed by tests so runs don't affect each other */
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
 * Clean up what's printed: a string directly, an object only if it actually
 * contains a secret (otherwise the object would lose its readable shape for nothing).
 *
 * Objects are viewed through `inspect` rather than `JSON.stringify`: JSON
 * serialization lets a secret slip past the guard three separate ways — an
 * `Error` turns into `{}` while the password text still lives in its message
 * and stack, a circular reference throws, and a `Map` serializes to an empty
 * object. `inspect` prints exactly what a human would see in the log.
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

  constructor() {
    // Read from environment variables
    this.level = (process.env.SSH_MCP_LOG_LEVEL as LogLevel) ||
                 (process.env.LOG_LEVEL as LogLevel) ||
                 'info';
    this.enableTimestamp = process.env.SSH_MCP_LOG_TIMESTAMP !== 'false';
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

    // MCP: stdout for the protocol, stderr for logs
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
