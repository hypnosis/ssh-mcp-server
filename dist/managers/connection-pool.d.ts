/**
 * Connection Pool
 * Manages SSH connections with keep-alive, auto-reconnect, and idle cleanup
 */
import { Client } from 'ssh2';
import type { SSHConfig } from '../utils/ssh-config.js';
/**
 * Connection Pool (Singleton)
 * Manages SSH connections with automatic keep-alive, reconnection, and cleanup
 */
export declare class ConnectionPool {
    private static instance;
    /** Map of profile name to pooled connection */
    private connections;
    /** Locks for thread-safe connection creation */
    private locks;
    /** Cleanup timer */
    private cleanupTimer?;
    /** Pool metrics */
    private metrics;
    /** Idle timeout (30 seconds) */
    private readonly IDLE_TIMEOUT;
    /** Keep-alive interval (10 seconds) */
    private readonly KEEP_ALIVE_INTERVAL;
    /**
     * Private constructor (Singleton)
     */
    private constructor();
    /**
     * Get singleton instance
     */
    static getInstance(): ConnectionPool;
    /**
     * Get or create client for profile
     * @param profileName - Profile name
     * @param config - SSH configuration
     * @returns SSH2 client
     */
    getClient(profileName: string, config: SSHConfig): Promise<Client>;
    /**
     * Release client (decrement active commands counter)
     * @param profileName - Profile name
     */
    releaseClient(profileName: string): void;
    /**
     * Close client and remove from pool
     * @param profileName - Profile name
     */
    closeClient(profileName: string): Promise<void>;
    /**
     * Close all connections
     */
    closeAll(): Promise<void>;
    /**
     * Get pool statistics
     */
    getStats(): {
        activeConnections: number;
        connections: {
            profileName: string;
            isReady: boolean;
            activeCommands: number;
            idleTime: number;
        }[];
        /** Total connections created */
        totalConnections: number;
        /** Number of reconnects */
        reconnects: number;
        /** Total commands executed */
        totalCommands: number;
        /** Cache hits (reused connections) */
        cacheHits: number;
        /** Cache misses (new connections) */
        cacheMisses: number;
    };
    /**
     * Create new SSH connection with retry
     */
    private createConnection;
    /**
     * Connect client (single attempt)
     */
    private connectClient;
    /**
     * Connect to server
     */
    private connect;
    /**
     * Resolve SSH key path (support ~)
     */
    private resolveKeyPath;
    /**
     * Check if SSH config has changed
     */
    private hasConfigChanged;
    /**
     * Cleanup idle connections
     */
    private cleanupIdleConnections;
    /**
     * Reset session metrics
     * Called when all connections are closed (pool is empty)
     */
    private resetMetrics;
}
//# sourceMappingURL=connection-pool.d.ts.map