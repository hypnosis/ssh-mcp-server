/**
 * SSH Executor
 * SSH command execution with connection pooling (v2.0.0)
 */
import { logger } from '../utils/logger.js';
import { retryWithTimeout, createSSHRetryPredicate } from '../utils/retry.js';
import { SSHManager } from './ssh-manager.js';
/**
 * SSH Executor for command execution
 * v2.0.0 - Uses SSHManager with connection pooling
 */
export class SSHExecutor {
    manager;
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
    async execute(config, command, options = {}) {
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
    escapeShell(str) {
        return `'${str.replace(/'/g, "'\"'\"'")}'`;
    }
    /**
     * Test connection to server
     */
    async testConnection(config, profileName) {
        try {
            await this.execute(config, 'echo "test"', { timeout: 5000, profileName });
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=ssh-executor.js.map