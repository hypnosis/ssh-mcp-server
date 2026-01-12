/**
 * SSH Executor
 * SSH command execution with connection pooling (v1.1.0)
 */

import { logger } from '../utils/logger.js';
import { retryWithTimeout, createSSHRetryPredicate } from '../utils/retry.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { SSHManager } from './ssh-manager.js';

export interface SSHExecuteOptions {
  /** Command execution timeout (ms) */
  timeout?: number;
  /** Output encoding */
  encoding?: BufferEncoding;
  /** Working directory */
  cwd?: string;
  /** Use sudo */
  sudo?: boolean;
  /** Profile name for connection pool */
  profileName?: string;
}

export interface SSHExecuteResult {
  /** Command output (stdout) */
  stdout: string;
  /** Errors (stderr) */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * SSH Executor for command execution
 * v1.1.0 - Uses SSHManager with connection pooling
 */
export class SSHExecutor {
  private manager: SSHManager;
  
  constructor() {
    this.manager = new SSHManager();
  }
  /**
   * Execute command on remote server
   * @param config - SSH configuration
   * @param command - Command to execute
   * @param options - Execution options
   * @returns Execution result
   */
  async execute(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<SSHExecuteResult> {
    const timeout = options.timeout || 30000;
    
    // Add sudo if needed
    let finalCommand = command;
    if (options.sudo) {
      finalCommand = `sudo ${command}`;
    }
    
    // Add cd if working directory is specified
    if (options.cwd) {
      finalCommand = `cd ${this.escapeShell(options.cwd)} && ${finalCommand}`;
    }
    
    logger.debug(`Executing SSH command: ${finalCommand.substring(0, 100)}...`);
    
    // Execute with retry logic using SSHManager
    const executeFn = async () => {
      const stdout = await this.manager.execute(config, finalCommand, {
        timeout,
        encoding: options.encoding,
        profileName: options.profileName,
      });
      
      return {
        stdout,
        stderr: '',
        exitCode: 0,
      };
    };
    
    return retryWithTimeout(executeFn, {
      maxAttempts: 3,
      timeout,
      shouldRetry: createSSHRetryPredicate(),
    });
  }
  
  /**
   * Escape string for shell
   */
  private escapeShell(str: string): string {
    return `'${str.replace(/'/g, "'\"'\"'")}'`;
  }
  
  /**
   * Test connection to server
   */
  async testConnection(config: SSHConfig, profileName?: string): Promise<boolean> {
    try {
      await this.execute(config, 'echo "test"', { timeout: 5000, profileName });
      return true;
    } catch {
      return false;
    }
  }
}
