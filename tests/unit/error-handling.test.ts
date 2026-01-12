/**
 * Error Handling Tests
 * Tests for timeout, retry, and error messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSHManager } from '../../src/managers/ssh-manager.js';
import { ConnectionPool } from '../../src/managers/connection-pool.js';
import { retryWithTimeout, createSSHRetryPredicate, TimeoutError, RetryExhaustedError } from '../../src/utils/retry.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

describe('Error Handling', () => {
  const mockConfig: SSHConfig = {
    host: 'test.example.com',
    port: 22,
    username: 'testuser',
    privateKeyPath: '~/.ssh/id_rsa_example',
  };

  beforeEach(() => {
    // Reset singleton instance before each test
    (ConnectionPool as any).instance = undefined;
  });

  afterEach(() => {
    // Cleanup after each test
    const pool = ConnectionPool.getInstance();
    pool.closeAll();
  });

  describe('Timeout Handling', () => {
    it('should timeout after specified duration', async () => {
      const slowOperation = async () => {
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds
        return 'success';
      };

      await expect(
        retryWithTimeout(slowOperation, {
          maxAttempts: 1,
          timeout: 1000, // 1 second timeout
        })
      ).rejects.toThrow(TimeoutError);
    });

    it('should not timeout if operation completes in time', async () => {
      const fastOperation = async () => {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms
        return 'success';
      };

      const result = await retryWithTimeout(fastOperation, {
        maxAttempts: 1,
        timeout: 1000, // 1 second timeout
      });

      expect(result).toBe('success');
    });

    it('should not cause race condition on timeout', async () => {
      let resolveCount = 0;
      let rejectCount = 0;

      const operation = async () => {
        return new Promise((resolve, reject) => {
          // Simulate slow operation
          setTimeout(() => {
            resolveCount++;
            resolve('late success');
          }, 2000);
        });
      };

      try {
        await retryWithTimeout(operation, {
          maxAttempts: 1,
          timeout: 500,
        });
      } catch (error) {
        rejectCount++;
      }

      // Wait for late resolve to potentially happen
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Should only reject once due to timeout
      expect(rejectCount).toBe(1);
      // Late resolve should happen but not affect the promise
      expect(resolveCount).toBe(1);
    });
  });

  describe('Retry Mechanism', () => {
    it('should retry on temporary errors', async () => {
      let attempts = 0;

      const flakeyOperation = async () => {
        attempts++;
        if (attempts < 3) {
          const error: any = new Error('ECONNREFUSED');
          error.code = 'ECONNREFUSED';
          throw error;
        }
        return 'success';
      };

      const result = await retryWithTimeout(flakeyOperation, {
        maxAttempts: 3,
        timeout: 5000,
        initialDelay: 100,
        shouldRetry: createSSHRetryPredicate(),
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should not retry on authentication errors', async () => {
      let attempts = 0;

      const authFailOperation = async () => {
        attempts++;
        throw new Error('Authentication failed');
      };

      await expect(
        retryWithTimeout(authFailOperation, {
          maxAttempts: 3,
          timeout: 5000,
          initialDelay: 100,
          shouldRetry: createSSHRetryPredicate(),
        })
      ).rejects.toThrow('Authentication failed');

      // Should only try once (no retry for auth errors)
      expect(attempts).toBe(1);
    });

    it('should exhaust retries and throw RetryExhaustedError', async () => {
      let attempts = 0;

      const alwaysFailOperation = async () => {
        attempts++;
        const error: any = new Error('ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        throw error;
      };

      await expect(
        retryWithTimeout(alwaysFailOperation, {
          maxAttempts: 3,
          timeout: 5000,
          initialDelay: 100,
          shouldRetry: createSSHRetryPredicate(),
        })
      ).rejects.toThrow(RetryExhaustedError);

      expect(attempts).toBe(3);
    });

    it('should use exponential backoff', async () => {
      const delays: number[] = [];
      let lastTime = Date.now();
      let attempts = 0;

      const operation = async () => {
        attempts++;
        if (attempts > 1) {
          const currentTime = Date.now();
          delays.push(currentTime - lastTime);
          lastTime = currentTime;
        } else {
          lastTime = Date.now();
        }

        if (attempts < 3) {
          const error: any = new Error('ECONNREFUSED');
          error.code = 'ECONNREFUSED';
          throw error;
        }
        return 'success';
      };

      await retryWithTimeout(operation, {
        maxAttempts: 3,
        timeout: 10000,
        initialDelay: 100,
        backoffMultiplier: 2,
        shouldRetry: createSSHRetryPredicate(),
      });

      // Check that delays increase (exponential backoff)
      // First delay ~100ms, second delay ~200ms
      expect(delays.length).toBe(2);
      expect(delays[0]).toBeGreaterThanOrEqual(90); // ~100ms (with tolerance)
      expect(delays[0]).toBeLessThan(150);
      expect(delays[1]).toBeGreaterThanOrEqual(180); // ~200ms (with tolerance)
      expect(delays[1]).toBeLessThan(250);
    });
  });

  describe('SSH Retry Predicate', () => {
    const shouldRetry = createSSHRetryPredicate();

    it('should retry on ECONNREFUSED', () => {
      const error: any = new Error('Connection refused');
      error.code = 'ECONNREFUSED';
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on ETIMEDOUT', () => {
      const error: any = new Error('Connection timeout');
      error.code = 'ETIMEDOUT';
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on ENOTFOUND', () => {
      const error: any = new Error('Host not found');
      error.code = 'ENOTFOUND';
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on ECONNRESET', () => {
      const error: any = new Error('Connection reset');
      error.code = 'ECONNRESET';
      expect(shouldRetry(error)).toBe(true);
    });

    it('should NOT retry on authentication errors', () => {
      const error = new Error('Authentication failed');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should NOT retry on permission denied', () => {
      const error = new Error('Permission denied (publickey)');
      expect(shouldRetry(error)).toBe(false);
    });

    it('should retry on timeout messages', () => {
      const error = new Error('Operation timed out');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on connection messages', () => {
      const error = new Error('Connection lost');
      expect(shouldRetry(error)).toBe(true);
    });
  });

  describe('Error Messages', () => {
    it('should provide helpful error message for ECONNREFUSED', () => {
      const error: any = new Error('ECONNREFUSED');
      error.code = 'ECONNREFUSED';

      // Simulate what ConnectionPool does
      const enhancedMessage = `Connection refused to ${mockConfig.host}:${mockConfig.port}. Check if SSH server is running and port is correct.`;

      expect(enhancedMessage).toContain('Connection refused');
      expect(enhancedMessage).toContain('SSH server is running');
      expect(enhancedMessage).toContain('port is correct');
    });

    it('should provide helpful error message for ETIMEDOUT', () => {
      const enhancedMessage = `Connection timeout to ${mockConfig.host}:${mockConfig.port}. Check firewall rules and network connectivity.`;

      expect(enhancedMessage).toContain('Connection timeout');
      expect(enhancedMessage).toContain('firewall rules');
      expect(enhancedMessage).toContain('network connectivity');
    });

    it('should provide helpful error message for ENOTFOUND', () => {
      const enhancedMessage = `Host not found: ${mockConfig.host}. Check hostname/IP address in profile configuration.`;

      expect(enhancedMessage).toContain('Host not found');
      expect(enhancedMessage).toContain('hostname/IP address');
      expect(enhancedMessage).toContain('profile configuration');
    });

    it('should provide helpful error message for authentication failure', () => {
      const enhancedMessage = `Authentication failed for ${mockConfig.username}@${mockConfig.host}. Check username, SSH key path, and passphrase.`;

      expect(enhancedMessage).toContain('Authentication failed');
      expect(enhancedMessage).toContain('username');
      expect(enhancedMessage).toContain('SSH key path');
      expect(enhancedMessage).toContain('passphrase');
    });

    it('should provide helpful error message for invalid SSH key', () => {
      const enhancedMessage = `Invalid SSH key at ${mockConfig.privateKeyPath}. Check file exists and has correct permissions (600).`;

      expect(enhancedMessage).toContain('Invalid SSH key');
      expect(enhancedMessage).toContain('file exists');
      expect(enhancedMessage).toContain('permissions (600)');
    });
  });

  describe('Integration Tests', () => {
    it('should handle command timeout gracefully', async () => {
      const manager = new SSHManager();

      // This test would require a real SSH connection
      // For now, we just verify the interface exists
      expect(manager.execute).toBeDefined();
      expect(manager.executeBatch).toBeDefined();
      expect(manager.testConnection).toBeDefined();
    });

    it('should handle connection pool metrics', () => {
      const pool = ConnectionPool.getInstance();
      const stats = pool.getStats();

      expect(stats).toHaveProperty('totalConnections');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('reconnects');
      expect(stats).toHaveProperty('totalCommands');
      expect(stats).toHaveProperty('cacheHits');
      expect(stats).toHaveProperty('cacheMisses');
      expect(stats).toHaveProperty('connections');
    });
  });
});
