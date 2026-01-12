/**
 * Logger для MCP Server
 * Выводит в stderr (stdout занят MCP протоколом)
 *
 * ENV variables:
 * - SSH_MCP_LOG_LEVEL: debug, info, warn, error (default: info)
 * - SSH_MCP_LOG_TIMESTAMP: true, false (default: true)
 * - SSH_MCP_LOG_COLORS: true, false (default: false)
 */
/**
 * Context logger (scoped logger)
 */
interface ContextLogger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
declare class Logger {
    private level;
    private enableTimestamp;
    private enableColors;
    constructor();
    private shouldLog;
    private log;
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
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
    context(context: string): ContextLogger;
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
    time(label: string): () => void;
}
export declare const logger: Logger;
export {};
//# sourceMappingURL=logger.d.ts.map