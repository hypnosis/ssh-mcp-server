/**
 * Logger для MCP Server
 * Выводит в stderr (stdout занят MCP протоколом)
 *
 * ENV variables:
 * - SSH_MCP_LOG_LEVEL: debug, info, warn, error (default: info)
 * - SSH_MCP_LOG_TIMESTAMP: true, false (default: true)
 * - SSH_MCP_LOG_COLORS: true, false (default: false)
 */
class Logger {
    level = 'info';
    enableTimestamp = true;
    enableColors = false;
    constructor() {
        // Read from environment variables
        this.level = process.env.SSH_MCP_LOG_LEVEL ||
            process.env.LOG_LEVEL ||
            'info';
        this.enableTimestamp = process.env.SSH_MCP_LOG_TIMESTAMP !== 'false';
        this.enableColors = process.env.SSH_MCP_LOG_COLORS === 'true';
    }
    shouldLog(level) {
        const levels = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.level);
    }
    log(level, message, ...args) {
        if (!this.shouldLog(level))
            return;
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
    debug(message, ...args) {
        this.log('debug', message, ...args);
    }
    info(message, ...args) {
        this.log('info', message, ...args);
    }
    warn(message, ...args) {
        this.log('warn', message, ...args);
    }
    error(message, ...args) {
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
    context(context) {
        return {
            debug: (msg, ...args) => this.debug(`[${context}] ${msg}`, ...args),
            info: (msg, ...args) => this.info(`[${context}] ${msg}`, ...args),
            warn: (msg, ...args) => this.warn(`[${context}] ${msg}`, ...args),
            error: (msg, ...args) => this.error(`[${context}] ${msg}`, ...args)
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
    time(label) {
        const start = Date.now();
        return () => {
            const duration = Date.now() - start;
            this.debug(`[⏱️ ${label}] ${duration}ms`);
        };
    }
}
// Singleton instance
export const logger = new Logger();
//# sourceMappingURL=logger.js.map