/**
 * SSH Executor
 * SSH command execution with connection pooling (v2.0.0)
 */
import type { SSHConfig } from '../utils/ssh-config.js';
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
 * v2.0.0 - Uses SSHManager with connection pooling
 */
export declare class SSHExecutor {
    private manager;
    constructor();
    /**
     * Execute command on remote server
     * @param config - SSH configuration
     * @param command - Command to execute
     * @param options - Execution options
     * @returns Execution result
     */
    execute(config: SSHConfig, command: string, options?: SSHExecuteOptions): Promise<SSHExecuteResult>;
    /**
     * Escape string for shell
     */
    private escapeShell;
    /**
     * Test connection to server
     */
    testConnection(config: SSHConfig, profileName?: string): Promise<boolean>;
}
//# sourceMappingURL=ssh-executor.d.ts.map