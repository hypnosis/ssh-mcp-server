/**
 * SSH Log Tools
 * Инструменты для работы с логами на удаленном сервере
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';

/**
 * Log Tools
 */
export class LogTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Получить описания tools для MCP
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
   * Обработать вызов tool
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
   * Обработать ssh_log_tail
   */
  private async handleLogTail(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const lines = args.lines || 100;
    const sudo = args.sudo || false;
    
    // Если один лог - простой результат
    if (paths.length === 1) {
      const command = `tail -n ${lines} '${this.escapePath(paths[0])}'`;
      const result = await this.executor.execute(sshConfig, command, { sudo });
      
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
        const command = `tail -n ${lines} '${this.escapePath(path)}'`;
        const result = await this.executor.execute(sshConfig, command, { sudo });
        
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
    
    // Форматируем вывод
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
   * Обработать ssh_log_search
   */
  private async handleLogSearch(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const query = args.query;
    const context = args.context || 0;
    const caseSensitive = args.caseSensitive || false;
    const sudo = args.sudo || false;
    
    // Собираем grep флаги
    const grepFlags = [];
    grepFlags.push('-E'); // Extended regex
    if (!caseSensitive) grepFlags.push('-i'); // Case insensitive
    if (context > 0) grepFlags.push(`-C ${context}`); // Context lines
    grepFlags.push('-n'); // Line numbers
    
    // Если один лог - простой результат
    if (paths.length === 1) {
      const command = `grep ${grepFlags.join(' ')} '${this.escapeQuery(query)}' '${this.escapePath(paths[0])}'`;
      const result = await this.executor.execute(sshConfig, command, { sudo });
      
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
        const command = `grep ${grepFlags.join(' ')} '${this.escapeQuery(query)}' '${this.escapePath(path)}'`;
        const result = await this.executor.execute(sshConfig, command, { sudo });
        
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
    
    // Форматируем вывод
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
   * Экранировать путь для shell
   */
  private escapePath(path: string): string {
    return path.replace(/'/g, "'\"'\"'");
  }
  
  /**
   * Экранировать query для grep
   */
  private escapeQuery(query: string): string {
    return query.replace(/'/g, "'\"'\"'");
  }
}
