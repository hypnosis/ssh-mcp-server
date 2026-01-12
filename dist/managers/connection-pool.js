/**
 * Connection Pool
 * Manages SSH connections with keep-alive, auto-reconnect, and idle cleanup
 */
import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { retryWithTimeout, createSSHRetryPredicate } from '../utils/retry.js';
/**
 * Connection Pool (Singleton)
 * Manages SSH connections with automatic keep-alive, reconnection, and cleanup
 */
export class ConnectionPool {
    static instance;
    /** Map of profile name to pooled connection */
    connections = new Map();
    /** Locks for thread-safe connection creation */
    locks = new Map();
    /** Cleanup timer */
    cleanupTimer;
    /** Pool metrics */
    metrics = {
        totalConnections: 0,
        activeConnections: 0,
        reconnects: 0,
        totalCommands: 0,
        cacheHits: 0,
        cacheMisses: 0,
    };
    /** Idle timeout (30 seconds) */
    IDLE_TIMEOUT = 30000;
    /** Keep-alive interval (10 seconds) */
    KEEP_ALIVE_INTERVAL = 10000;
    /**
     * Private constructor (Singleton)
     */
    constructor() {
        logger.debug('[Connection Pool] Initializing connection pool');
        // Start cleanup timer (check every 10 seconds)
        this.cleanupTimer = setInterval(() => {
            this.cleanupIdleConnections();
        }, 10000);
        logger.info('[Connection Pool] ✅ Connection pool initialized');
    }
    /**
     * Get singleton instance
     */
    static getInstance() {
        if (!ConnectionPool.instance) {
            ConnectionPool.instance = new ConnectionPool();
        }
        return ConnectionPool.instance;
    }
    /**
     * Get or create client for profile
     * @param profileName - Profile name
     * @param config - SSH configuration
     * @returns SSH2 client
     */
    async getClient(profileName, config) {
        // Check existing connection
        const existing = this.connections.get(profileName);
        if (existing && existing.isReady) {
            // Check if config has changed (profile reload)
            if (this.hasConfigChanged(existing.config, config)) {
                logger.info(`[Connection Pool] Config changed for "${profileName}", reconnecting...`);
                // Close old connection
                await this.closeClient(profileName);
                // Create new connection (fallthrough)
            }
            else {
                // Config unchanged, reuse connection
                this.metrics.cacheHits++;
                this.metrics.totalCommands++;
                existing.lastUsed = Date.now();
                existing.activeCommands++;
                logger.debug(`[Connection Pool] Cache HIT for profile "${profileName}" (active: ${existing.activeCommands})`);
                return existing.client;
            }
        }
        // Check if connection is being created (avoid race condition)
        const existingLock = this.locks.get(profileName);
        if (existingLock) {
            logger.debug(`[Connection Pool] Waiting for existing connection creation for profile "${profileName}"`);
            return existingLock;
        }
        // Create new connection
        this.metrics.cacheMisses++;
        this.metrics.totalCommands++;
        logger.debug(`[Connection Pool] Cache MISS for profile "${profileName}", creating new connection`);
        // Create lock promise
        const lockPromise = this.createConnection(profileName, config);
        this.locks.set(profileName, lockPromise);
        try {
            const client = await lockPromise;
            return client;
        }
        finally {
            // Remove lock after connection is created
            this.locks.delete(profileName);
        }
    }
    /**
     * Release client (decrement active commands counter)
     * @param profileName - Profile name
     */
    releaseClient(profileName) {
        const pooled = this.connections.get(profileName);
        if (pooled && pooled.activeCommands > 0) {
            pooled.activeCommands--;
            pooled.lastUsed = Date.now();
            logger.debug(`[Connection Pool] Released client for profile "${profileName}" (active: ${pooled.activeCommands})`);
        }
    }
    /**
     * Close client and remove from pool
     * @param profileName - Profile name
     */
    async closeClient(profileName) {
        const pooled = this.connections.get(profileName);
        if (!pooled) {
            logger.debug(`[Connection Pool] No connection to close for profile "${profileName}"`);
            return;
        }
        logger.info(`[Connection Pool] Closing connection for profile "${profileName}"`);
        // Clear keep-alive interval
        if (pooled.keepAliveInterval) {
            clearInterval(pooled.keepAliveInterval);
        }
        // Close client
        pooled.client.end();
        // Remove from pool
        this.connections.delete(profileName);
        this.metrics.activeConnections--;
        logger.debug(`[Connection Pool] Connection closed for profile "${profileName}"`);
    }
    /**
     * Close all connections
     */
    async closeAll() {
        logger.info(`[Connection Pool] Closing all connections (${this.connections.size} active)`);
        // Clear cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        // Close all connections
        const closePromises = [];
        for (const profileName of this.connections.keys()) {
            closePromises.push(this.closeClient(profileName));
        }
        await Promise.all(closePromises);
        logger.info('[Connection Pool] ✅ All connections closed');
    }
    /**
     * Get pool statistics
     */
    getStats() {
        const connections = Array.from(this.connections.entries()).map(([name, pooled]) => ({
            profileName: name,
            isReady: pooled.isReady,
            activeCommands: pooled.activeCommands,
            idleTime: Date.now() - pooled.lastUsed,
        }));
        // Calculate activeConnections dynamically from actual connections map
        // to avoid desynchronization with the counter
        const activeConnections = this.connections.size;
        return {
            ...this.metrics,
            activeConnections, // Override with calculated value
            connections,
        };
    }
    /**
     * Create new SSH connection with retry
     */
    async createConnection(profileName, config) {
        logger.info(`[Connection Pool] Creating new connection for profile "${profileName}"`);
        logger.debug(`[Connection Pool] Config: ${config.username}@${config.host}:${config.port || 22}`);
        try {
            // Wrap connection creation in retry with exponential backoff
            const client = await retryWithTimeout(() => this.connectClient(profileName, config), {
                maxAttempts: 3,
                timeout: 10000, // 10s timeout per attempt
                initialDelay: 1000, // 1s
                backoffMultiplier: 2, // 1s, 2s, 4s
                shouldRetry: createSSHRetryPredicate(),
            });
            return client;
        }
        catch (error) {
            // Enhanced error messages with helpful hints
            logger.error(`[Connection Pool] ❌ Failed to connect to profile "${profileName}"`);
            logger.error(`[Connection Pool] Host: ${config.host}:${config.port || 22}`);
            logger.error(`[Connection Pool] Username: ${config.username}`);
            logger.error(`[Connection Pool] Error: ${error.message}`);
            // Specific error messages with troubleshooting hints
            if (error.message.includes('ECONNREFUSED') || error.code === 'ECONNREFUSED') {
                throw new Error(`Connection refused to ${config.host}:${config.port || 22}. ` +
                    `Check if SSH server is running and port is correct.`);
            }
            if (error.message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
                throw new Error(`Connection timeout to ${config.host}:${config.port || 22}. ` +
                    `Check firewall rules and network connectivity.`);
            }
            if (error.message.includes('ENOTFOUND') || error.code === 'ENOTFOUND') {
                throw new Error(`Host not found: ${config.host}. ` +
                    `Check hostname/IP address in profile configuration.`);
            }
            if (error.message.includes('authentication') || error.message.includes('Authentication failed')) {
                throw new Error(`Authentication failed for ${config.username}@${config.host}. ` +
                    `Check username, SSH key path, and passphrase.`);
            }
            if (error.message.includes('privateKey') || error.message.includes('private key')) {
                throw new Error(`Invalid SSH key at ${config.privateKeyPath}. ` +
                    `Check file exists and has correct permissions (600).`);
            }
            if (error.message.includes('timed out') || error.name === 'TimeoutError') {
                throw new Error(`Connection timeout to ${config.host}:${config.port || 22} after multiple attempts. ` +
                    `Check network connectivity and SSH server availability.`);
            }
            // Generic error with context
            throw new Error(`Failed to connect to ${config.username}@${config.host}:${config.port || 22}: ${error.message}`);
        }
    }
    /**
     * Connect client (single attempt)
     */
    async connectClient(profileName, config) {
        return new Promise((resolve, reject) => {
            const client = new Client();
            let connectionEstablished = false;
            client.on('ready', () => {
                connectionEstablished = true;
                logger.info(`[Connection Pool] ✅ Connection established for profile "${profileName}"`);
                // Store in pool
                const pooled = {
                    client,
                    config,
                    isReady: true,
                    lastUsed: Date.now(),
                    activeCommands: 1, // First command is using this connection
                };
                // Setup keep-alive
                pooled.keepAliveInterval = setInterval(() => {
                    if (pooled.isReady) {
                        client.exec('echo keepalive', (err) => {
                            if (err) {
                                logger.warn(`[Connection Pool] Keep-alive failed for profile "${profileName}": ${err.message}`);
                            }
                            else {
                                logger.debug(`[Connection Pool] Keep-alive ping sent for profile "${profileName}"`);
                            }
                        });
                    }
                }, this.KEEP_ALIVE_INTERVAL);
                // Setup auto-reconnect
                client.on('end', () => {
                    logger.warn(`[Connection Pool] Connection lost for profile "${profileName}"`);
                    pooled.isReady = false;
                    // Clear keep-alive
                    if (pooled.keepAliveInterval) {
                        clearInterval(pooled.keepAliveInterval);
                    }
                    // Remove from pool
                    this.connections.delete(profileName);
                    this.metrics.activeConnections--;
                    // Auto-reconnect after 1 second (if there are active commands)
                    if (pooled.activeCommands > 0) {
                        logger.info(`[Connection Pool] Auto-reconnecting for profile "${profileName}" (active commands: ${pooled.activeCommands})`);
                        setTimeout(() => {
                            this.metrics.reconnects++;
                            this.createConnection(profileName, config).catch((err) => {
                                logger.error(`[Connection Pool] Auto-reconnect failed for profile "${profileName}": ${err.message}`);
                            });
                        }, 1000);
                    }
                });
                client.on('error', (err) => {
                    logger.error(`[Connection Pool] Connection error for profile "${profileName}": ${err.message}`);
                    pooled.isReady = false;
                });
                this.connections.set(profileName, pooled);
                this.metrics.totalConnections++;
                this.metrics.activeConnections++;
                resolve(client);
            });
            client.on('error', (err) => {
                if (!connectionEstablished) {
                    logger.error(`[Connection Pool] Connection attempt failed for profile "${profileName}": ${err.message}`);
                    reject(err); // Reject with original error for retry logic
                }
            });
            // Connect
            this.connect(client, config);
        });
    }
    /**
     * Connect to server
     */
    connect(client, config) {
        logger.debug(`[Connection Pool] Connecting to ${config.host}:${config.port || 22} as ${config.username}`);
        const connectConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: 30000,
        };
        // Load private key
        if (config.privateKeyPath) {
            try {
                const keyPath = this.resolveKeyPath(config.privateKeyPath);
                if (!existsSync(keyPath)) {
                    throw new Error(`SSH private key not found: ${keyPath}`);
                }
                const privateKey = readFileSync(keyPath, 'utf8');
                connectConfig.privateKey = privateKey;
                if (config.passphrase) {
                    connectConfig.passphrase = config.passphrase;
                }
                logger.debug(`[Connection Pool] Using private key: ${keyPath}`);
            }
            catch (error) {
                logger.error(`[Connection Pool] Failed to load SSH key: ${error.message}`);
                throw error;
            }
        }
        // Password authentication
        if (config.password) {
            connectConfig.password = config.password;
            logger.debug(`[Connection Pool] Using password authentication`);
        }
        client.connect(connectConfig);
    }
    /**
     * Resolve SSH key path (support ~)
     */
    resolveKeyPath(keyPath) {
        if (keyPath.startsWith('~')) {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            return keyPath.replace('~', home);
        }
        return resolve(keyPath);
    }
    /**
     * Check if SSH config has changed
     */
    hasConfigChanged(oldConfig, newConfig) {
        return oldConfig.host !== newConfig.host ||
            oldConfig.port !== newConfig.port ||
            oldConfig.username !== newConfig.username ||
            oldConfig.privateKeyPath !== newConfig.privateKeyPath ||
            oldConfig.password !== newConfig.password ||
            oldConfig.passphrase !== newConfig.passphrase;
    }
    /**
     * Cleanup idle connections
     */
    cleanupIdleConnections() {
        const now = Date.now();
        const toClose = [];
        for (const [profileName, pooled] of this.connections) {
            const idleTime = now - pooled.lastUsed;
            // Close if no active commands and idle > 30s
            if (pooled.activeCommands === 0 && idleTime > this.IDLE_TIMEOUT) {
                logger.debug(`[Connection Pool] Closing idle connection for profile "${profileName}" (idle: ${Math.round(idleTime / 1000)}s)`);
                toClose.push(profileName);
            }
        }
        // Close idle connections
        for (const profileName of toClose) {
            this.closeClient(profileName);
        }
        if (toClose.length > 0) {
            logger.info(`[Connection Pool] Cleaned up ${toClose.length} idle connections`);
            // Reset metrics if pool is now empty (session ended)
            if (this.connections.size === 0) {
                logger.debug('[Connection Pool] All connections closed, resetting session metrics');
                this.resetMetrics();
            }
        }
    }
    /**
     * Reset session metrics
     * Called when all connections are closed (pool is empty)
     */
    resetMetrics() {
        this.metrics.totalConnections = 0;
        this.metrics.totalCommands = 0;
        this.metrics.cacheHits = 0;
        this.metrics.cacheMisses = 0;
        this.metrics.reconnects = 0;
        logger.debug('[Connection Pool] Session metrics reset to zero');
    }
}
//# sourceMappingURL=connection-pool.js.map