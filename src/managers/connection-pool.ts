/**
 * Connection Pool
 * Manages SSH connections with keep-alive, auto-reconnect, and idle cleanup
 */

import { Client, ConnectConfig } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/**
 * Pooled connection data
 */
interface PooledConnection {
  /** SSH2 client instance */
  client: Client;
  /** SSH configuration */
  config: SSHConfig;
  /** Connection is ready for use */
  isReady: boolean;
  /** Timestamp of last usage */
  lastUsed: number;
  /** Number of active commands */
  activeCommands: number;
  /** Keep-alive interval ID */
  keepAliveInterval?: NodeJS.Timeout;
}

/**
 * Connection Pool metrics
 */
interface PoolMetrics {
  /** Total connections created */
  totalConnections: number;
  /** Currently active connections */
  activeConnections: number;
  /** Number of reconnects */
  reconnects: number;
  /** Total commands executed */
  totalCommands: number;
  /** Cache hits (reused connections) */
  cacheHits: number;
  /** Cache misses (new connections) */
  cacheMisses: number;
}

/**
 * Connection Pool (Singleton)
 * Manages SSH connections with automatic keep-alive, reconnection, and cleanup
 */
export class ConnectionPool {
  private static instance: ConnectionPool;
  
  /** Map of profile name to pooled connection */
  private connections: Map<string, PooledConnection> = new Map();
  
  /** Locks for thread-safe connection creation */
  private locks: Map<string, Promise<Client>> = new Map();
  
  /** Cleanup timer */
  private cleanupTimer?: NodeJS.Timeout;
  
  /** Pool metrics */
  private metrics: PoolMetrics = {
    totalConnections: 0,
    activeConnections: 0,
    reconnects: 0,
    totalCommands: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  
  /** Idle timeout (30 seconds) */
  private readonly IDLE_TIMEOUT = 30000;
  
  /** Keep-alive interval (10 seconds) */
  private readonly KEEP_ALIVE_INTERVAL = 10000;
  
  /**
   * Private constructor (Singleton)
   */
  private constructor() {
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
  static getInstance(): ConnectionPool {
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
  async getClient(profileName: string, config: SSHConfig): Promise<Client> {
    // Check existing connection
    const existing = this.connections.get(profileName);
    
    if (existing && existing.isReady) {
      this.metrics.cacheHits++;
      this.metrics.totalCommands++;
      existing.lastUsed = Date.now();
      existing.activeCommands++;
      
      logger.debug(`[Connection Pool] Cache HIT for profile "${profileName}" (active: ${existing.activeCommands})`);
      
      return existing.client;
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
    } finally {
      // Remove lock after connection is created
      this.locks.delete(profileName);
    }
  }
  
  /**
   * Release client (decrement active commands counter)
   * @param profileName - Profile name
   */
  releaseClient(profileName: string): void {
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
  async closeClient(profileName: string): Promise<void> {
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
  async closeAll(): Promise<void> {
    logger.info(`[Connection Pool] Closing all connections (${this.connections.size} active)`);
    
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Close all connections
    const closePromises: Promise<void>[] = [];
    
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
    
    return {
      ...this.metrics,
      connections,
    };
  }
  
  /**
   * Create new SSH connection
   */
  private async createConnection(profileName: string, config: SSHConfig): Promise<Client> {
    logger.info(`[Connection Pool] Creating new connection for profile "${profileName}"`);
    
    return new Promise((resolve, reject) => {
      const client = new Client();
      let connectionEstablished = false;
      
      client.on('ready', () => {
        connectionEstablished = true;
        
        logger.info(`[Connection Pool] ✅ Connection established for profile "${profileName}"`);
        
        // Store in pool
        const pooled: PooledConnection = {
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
              } else {
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
          logger.error(`[Connection Pool] ❌ Failed to connect for profile "${profileName}": ${err.message}`);
          reject(new Error(`SSH connection error: ${err.message}`));
        }
      });
      
      // Connect
      this.connect(client, config);
    });
  }
  
  /**
   * Connect to server
   */
  private connect(client: Client, config: SSHConfig): void {
    logger.debug(`[Connection Pool] Connecting to ${config.host}:${config.port || 22} as ${config.username}`);
    
    const connectConfig: ConnectConfig = {
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
      } catch (error: any) {
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
  private resolveKeyPath(keyPath: string): string {
    if (keyPath.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return keyPath.replace('~', home);
    }
    return resolve(keyPath);
  }
  
  /**
   * Cleanup idle connections
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    const toClose: string[] = [];
    
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
    }
  }
}
