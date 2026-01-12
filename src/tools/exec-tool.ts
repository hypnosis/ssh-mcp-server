/**
 * SSH Exec Tool
 * Universal tool for executing SSH commands
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';

/**
 * Dangerous command patterns
 */
const DANGEROUS_PATTERNS = [
  // Deletion
  { pattern: /\brm\s+-rf\s+\//, message: 'rm -rf / detected' },
  { pattern: /\brm\s+-rf\s+~/, message: 'rm -rf ~ detected' },
  { pattern: /\brm\s+-rf\s+\*/, message: 'rm -rf * detected' },
  
  // Permissions
  { pattern: /\bchmod\s+777\b/, message: 'chmod 777 detected (security risk)' },
  
  // System commands
  { pattern: /\breboot\b/, message: 'reboot detected' },
  { pattern: /\bshutdown\b/, message: 'shutdown detected' },
  { pattern: /\bhalt\b/, message: 'halt detected' },
  { pattern: /\bpoweroff\b/, message: 'poweroff detected' },
  
  // Docker bulk deletion
  { pattern: /\bdocker\s+system\s+prune\s+-a/, message: 'docker system prune -a detected' },
  { pattern: /\bdocker\s+rm\s+.*-f\s+\$\(docker\s+ps/, message: 'docker rm all containers detected' },
  
  // Database
  { pattern: /\bDROP\s+DATABASE\b/i, message: 'DROP DATABASE detected' },
  { pattern: /\bDROP\s+TABLE\b/i, message: 'DROP TABLE detected' },
  { pattern: /\bTRUNCATE\b/i, message: 'TRUNCATE detected' },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*;/i, message: 'DELETE without WHERE detected' },
];

/**
 * Check command for dangerous patterns
 */
function checkDangerousCommand(command: string): string | null {
  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `⚠️  DANGEROUS COMMAND: ${message}`;
    }
  }
  return null;
}

/**
 * SSH Exec Tool
 */
export class ExecTool {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool description for MCP
   */
  getTool(): Tool {
    return {
      name: 'ssh_exec',
      description: 'Execute command(s) on remote server via SSH. Supports single command or batch execution.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: 'SSH profile name from SSH_PROFILES_FILE. If not specified, uses default profile.',
          },
          command: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Single command string or array of commands to execute. For arrays, use JSON format with double quotes: ["cmd1", "cmd2"]. Examples: command: "hostname" (single) or command: ["hostname", "whoami", "date"] (batch)',
          },
          sudo: {
            type: 'boolean',
            description: 'Execute command(s) with sudo. Default: false',
            default: false,
          },
          cwd: {
            type: 'string',
            description: 'Working directory for command execution',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds. Default: 30000 (30 seconds)',
            default: 30000,
          },
        },
        required: ['command'],
      },
    };
  }
  
  /**
   * Handle tool call
   */
  async handleCall(request: CallToolRequest): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const args = request.params.arguments as any;
      
      // Validate array parameter format
      const validation = validateArrayParameter(args.command, 'command');
      if (!validation.isValid) {
        return createValidationErrorResponse(validation.errorMessage!);
      }
      
      // Resolve SSH config and profile name
      const profileName = args.profile || 'default';
      const sshConfig = resolveSSHConfig({ profile: args.profile });
      
      // Determine command type (string or array)
      const commands = Array.isArray(args.command) ? args.command : [args.command];
      
      // Check for dangerous commands
      const warnings: string[] = [];
      for (const cmd of commands) {
        const warning = checkDangerousCommand(cmd);
        if (warning) {
          warnings.push(`${warning}\nCommand: ${cmd.substring(0, 100)}`);
        }
      }
      
      // Single command - return simple result
      if (commands.length === 1) {
        const result = await this.executor.execute(sshConfig, commands[0], {
          sudo: args.sudo || false,
          cwd: args.cwd,
          timeout: args.timeout || 30000,
          profileName,
        });
        
        let output = '';
        
        // Add warnings
        if (warnings.length > 0) {
          output += warnings.join('\n\n') + '\n\n';
        }
        
        // Add stdout
        if (result.stdout) {
          output += result.stdout;
        }
        
        // Add stderr if present
        if (result.stderr) {
          output += `\n\nSTDERR:\n${result.stderr}`;
        }
        
        // Add exit code if not 0
        if (result.exitCode !== 0) {
          output += `\n\nExit code: ${result.exitCode}`;
        }
        
        return {
          content: [{ type: 'text', text: output || '(command executed successfully, no output)' }],
        };
      }
      
      // Multiple commands - return structured result
      const results: Array<{
        command: string;
        stdout: string;
        stderr: string;
        exitCode: number;
      }> = [];
      
      for (const cmd of commands) {
        const result = await this.executor.execute(sshConfig, cmd, {
          sudo: args.sudo || false,
          cwd: args.cwd,
          timeout: args.timeout || 30000,
          profileName,
        });
        
        results.push({
          command: cmd,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
      
      // Format output
      let output = '';
      
      // Add warnings
      if (warnings.length > 0) {
        output += warnings.join('\n\n') + '\n\n';
        output += '═'.repeat(60) + '\n\n';
      }
      
      output += `Executed ${results.length} commands:\n\n`;
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        output += `[${ i + 1}/${results.length}] ${result.command}\n`;
        output += '─'.repeat(60) + '\n';
        
        if (result.stdout) {
          output += result.stdout + '\n';
        }
        
        if (result.stderr) {
          output += `STDERR: ${result.stderr}\n`;
        }
        
        output += `Exit code: ${result.exitCode}\n\n`;
      }
      
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error: any) {
      logger.error('ssh_exec failed:', error);
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  }
}
