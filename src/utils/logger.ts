/**
 * Logger для MCP Server
 * Выводит в stderr (stdout занят MCP протоколом)
 * 
 * ENV variables:
 * - SSH_MCP_LOG_LEVEL: debug, info, warn, error (default: info)
 * - SSH_MCP_LOG_TIMESTAMP: true, false (default: true)
 * - SSH_MCP_LOG_COLORS: true, false (default: false)
 */

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
    console.error(prefix, message, ...args);
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
