/**
 * SSH Log Tools
 * Tools for working with logs on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { createPathValidator } from '../utils/path-validator.js';

/**
 * Log Tools
 */
export class LogTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool descriptions for MCP
   */
  getTools(): Tool[] {
    return [
      // ssh_log_tail
      {
        name: 'ssh_log_tail',
        description: 'Get last N lines from log file(s). Supports single log or multiple logs.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            path: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'Log file path or array of paths',
            },
            lines: {
              type: 'number',
              description: 'Number of lines to show. Default: 100',
              default: 100,
            },
            sudo: {
              type: 'boolean',
              description: 'Read logs with sudo. Default: false',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      
      // ssh_log_search
      {
        name: 'ssh_log_search',
        description: 'Search for pattern in log file(s) using grep. Supports single log or multiple logs.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            path: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'Log file path, glob pattern (*.log), or array of paths',
            },
            query: {
              type: 'string',
              description: 'Search query (grep -E pattern)',
            },
            context: {
              type: 'number',
              description: 'Number of context lines to show before and after match. Default: 0',
              default: 0,
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Case sensitive search. Default: false',
              default: false,
            },
            sudo: {
              type: 'boolean',
              description: 'Read logs with sudo. Default: false',
              default: false,
            },
          },
          required: ['path', 'query'],
        },
      },
    ];
  }
  
  /**
   * Handle tool call
   */
  async handleCall(request: CallToolRequest): Promise<{ content: Array<{ type: string; text: string }> }> {
    const toolName = request.params.name;
    
    try {
      switch (toolName) {
        case 'ssh_log_tail':
          return await this.handleLogTail(request);
        case 'ssh_log_search':
          return await this.handleLogSearch(request);
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  }
  
  /**
   * Handle ssh_log_tail
   */
  private async handleLogTail(request: CallToolRequest) {
    const args = request.params.arguments as any;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const lines = args.lines || 100;
    const sudo = args.sudo || false;
    
    // Validate paths against security rules (if configured)
    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      for (const path of paths) {
        const pathValidation = pathValidator.validate(path);
        if (!pathValidation.valid) {
          throw new Error(`Path validation failed: ${pathValidation.error}`);
        }
      }
    }
    
    // Single log - simple result
    if (paths.length === 1) {
      const safePath = this.buildSafePath(paths[0]);
      const command = `tail -n ${lines} ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
      
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read log: ${result.stderr || result.stdout}`);
      }
      
      return {
        content: [{ type: 'text', text: result.stdout || '(empty log)' }],
      };
    }
    
    // Множественные логи - структурированный результат
    const results: Array<{
      path: string;
      lines: string[];
      totalLines: number;
      success: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = this.buildSafePath(path);
        const command = `tail -n ${lines} ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
        
        if (result.exitCode === 0) {
          const logLines = result.stdout.split('\n').filter(line => line.length > 0);
          results.push({
            path,
            lines: logLines,
            totalLines: logLines.length,
            success: true,
          });
        } else {
          results.push({
            path,
            lines: [],
            totalLines: 0,
            success: false,
            error: result.stderr || result.stdout,
          });
        }
      } catch (error: any) {
        results.push({
          path,
          lines: [],
          totalLines: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Tail ${results.length} logs (last ${lines} lines):\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `=== ${result.path} (${result.totalLines} lines) ===\n`;
        output += result.lines.join('\n') + '\n\n';
      } else {
        output += `=== ${result.path} (ERROR) ===\n`;
        output += `Error: ${result.error}\n\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }],
    };
  }
  
  /**
   * Handle ssh_log_search
   */
  private async handleLogSearch(request: CallToolRequest) {
    const args = request.params.arguments as any;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const query = args.query;
    const context = args.context || 0;
    const caseSensitive = args.caseSensitive || false;
    const sudo = args.sudo || false;
    
    // Validate paths against security rules (if configured)
    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      for (const path of paths) {
        const pathValidation = pathValidator.validate(path);
        if (!pathValidation.valid) {
          throw new Error(`Path validation failed: ${pathValidation.error}`);
        }
      }
    }
    
    // Build grep flags
    const grepFlags = [];
    grepFlags.push('-E'); // Extended regex
    if (!caseSensitive) grepFlags.push('-i'); // Case insensitive
    if (context > 0) grepFlags.push(`-C ${context}`); // Context lines
    grepFlags.push('-n'); // Line numbers
    
    // Single log - simple result
    if (paths.length === 1) {
      const safePath = this.buildSafePath(paths[0]);
      const command = `grep ${grepFlags.join(' ')} '${this.escapeQuery(query)}' ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
      
      // grep exit code 1 = no matches (not an error)
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Failed to search log: ${result.stderr || result.stdout}`);
      }
      
      if (!result.stdout) {
        return {
          content: [{ type: 'text', text: 'No matches found' }],
        };
      }
      
      return {
        content: [{ type: 'text', text: result.stdout }],
      };
    }
    
    // Множественные логи - структурированный результат
    const results: Array<{
      path: string;
      matches: string;
      matchCount: number;
      success: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = this.buildSafePath(path);
        const command = `grep ${grepFlags.join(' ')} '${this.escapeQuery(query)}' ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
        
        // grep exit code 1 = no matches
        if (result.exitCode === 0 || result.exitCode === 1) {
          const matchCount = result.stdout ? result.stdout.split('\n').filter(line => line.length > 0).length : 0;
          results.push({
            path,
            matches: result.stdout || '(no matches)',
            matchCount,
            success: true,
          });
        } else {
          results.push({
            path,
            matches: '',
            matchCount: 0,
            success: false,
            error: result.stderr || result.stdout,
          });
        }
      } catch (error: any) {
        results.push({
          path,
          matches: '',
          matchCount: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Search in ${results.length} logs (query: "${query}"):\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `=== ${result.path} (${result.matchCount} matches) ===\n`;
        output += result.matches + '\n\n';
      } else {
        output += `=== ${result.path} (ERROR) ===\n`;
        output += `Error: ${result.error}\n\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }],
    };
  }
  
  /**
   * Expand tilde (~) for remote execution
   * Converts ~ to $HOME for shell expansion on remote server
   * 
   * Examples:
   *   ~/file       → $HOME/file
   *   ~            → $HOME
   *   ~user/file   → ~user/file (left as-is, shell will expand)
   *   /abs/path    → /abs/path (no change)
   * 
   * Note: We use $HOME instead of ~ because:
   * 1. Single quotes prevent ~ expansion: tail '~/file' won't work
   * 2. $HOME works in double quotes: tail "$HOME/file" works
   * 3. We can safely escape everything except $HOME in double quotes
   */
  private expandRemoteTilde(path: string): string {
    if (!path) return path;
    
    // ~/path → $HOME/path
    if (path.startsWith('~/')) {
      return '$HOME/' + path.substring(2);
    }
    
    // ~ → $HOME
    if (path === '~') {
      return '$HOME';
    }
    
    // ~user/path → leave as-is (shell will expand ~user)
    // /absolute/path → leave as-is
    // ./relative/path → leave as-is
    return path;
  }
  
  /**
   * Escape path for single-quoted context (safest)
   * Used for paths without tilde or variables
   * 
   * Single quotes prevent ALL expansions (variables, commands, globs)
   * Only need to handle embedded single quotes: ' → '\''
   */
  private escapeForSingleQuotes(path: string): string {
    // Replace ' with '\'' (end quote, escaped quote, start quote)
    return path.replace(/'/g, "'\\''");
  }
  
  /**
   * Escape path for double-quoted context
   * Used when we need variable expansion (e.g., $HOME)
   * 
   * Double quotes allow variable expansion but we must escape:
   * - Backslashes (\)
   * - Double quotes (")
   * - Dollar signs ($) - except $HOME which we want to expand
   * - Backticks (`)
   * - Exclamation marks (!) - for history expansion
   */
  private escapeForDoubleQuotes(str: string): string {
    return str
      .replace(/\\/g, '\\\\')   // \ → \\
      .replace(/"/g, '\\"')     // " → \"
      .replace(/\$/g, '\\$')    // $ → \$ (prevent variable expansion)
      .replace(/`/g, '\\`')     // ` → \` (prevent command substitution)
      .replace(/!/g, '\\!');    // ! → \! (prevent history expansion)
  }
  
  /**
   * Build safe shell command with proper quoting
   * 
   * Strategy:
   * - If path contains ~ → expand to $HOME → use double quotes
   * - Otherwise → use single quotes (safest)
   * 
   * Double quotes are used for $HOME expansion but everything else is escaped
   * to prevent injection attacks (variables, commands, etc.)
   */
  private buildSafePath(path: string): string {
    const expanded = this.expandRemoteTilde(path);
    
    // Path with $HOME → use double quotes for expansion
    if (expanded.startsWith('$HOME')) {
      // Split: $HOME (don't escape) + rest (escape everything)
      const homePrefix = '$HOME';
      const restPath = expanded.substring(5); // After $HOME
      
      // Escape only the part after $HOME
      const escapedRest = this.escapeForDoubleQuotes(restPath);
      return `"${homePrefix}${escapedRest}"`;
    } else {
      // Regular path → use single quotes (safest)
      return `'${this.escapeForSingleQuotes(expanded)}'`;
    }
  }
  
  /**
   * Legacy escape method (kept for backward compatibility)
   * @deprecated Use escapeForSingleQuotes() or escapeForDoubleQuotes() instead
   */
  private escapePath(path: string): string {
    return this.escapeForSingleQuotes(path);
  }
  
  /**
   * Escape query for grep
   */
  private escapeQuery(query: string): string {
    return query.replace(/'/g, "'\\''");
  }
}
