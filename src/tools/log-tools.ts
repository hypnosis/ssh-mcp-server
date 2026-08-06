/**
 * SSH Log Tools
 * Tools for working with logs on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { TRUNCATED_OUTPUT_NOTE, withTruncationNote } from '../utils/output-notes.js';
import { shellCount, shellQuote } from '../utils/shell-arg.js';
import { requireText, requireTextList } from '../utils/tool-args.js';
import { resolveRemotePath } from '../managers/path-guard.js';

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
    
    const paths = requireTextList(args.path, 'path', '"/var/log/syslog"');
    // Тип из схемы ничего не гарантирует: MCP отдаёт аргументы как есть
    const lines = shellCount(args.lines ?? 100, 'lines');
    const sudo = args.sudo || false;

    // Правила профиля проверяет buildSafePath — уже на раскрытом пути

    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, profileName, paths[0], sudo);
      const command = `tail -n ${lines} ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
      
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read log: ${result.stderr || result.stdout}`);
      }
      
      return {
        content: [
          { type: 'text', text: withTruncationNote(result.stdout || '(empty log)', result.truncated) },
        ],
      };
    }

    // Множественные логи - структурированный результат
    const results: Array<{
      path: string;
      lines: string[];
      totalLines: number;
      success: boolean;
      truncated?: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = await this.buildSafePath(sshConfig, profileName, path, sudo);
        const command = `tail -n ${lines} ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, profileName, idempotent: true });
        
        if (result.exitCode === 0) {
          const logLines = result.stdout.split('\n').filter(line => line.length > 0);
          results.push({
            path,
            lines: logLines,
            totalLines: logLines.length,
            success: true,
            truncated: result.truncated,
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
        output += result.lines.join('\n') + '\n';
        if (result.truncated) output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        output += '\n';
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
    
    const paths = requireTextList(args.path, 'path', '"/var/log/syslog"');
    const query = requireText(args.query, 'query', '"error"');
    const context = shellCount(args.context ?? 0, 'context');
    const caseSensitive = args.caseSensitive || false;
    const sudo = args.sudo || false;

    // Правила профиля проверяет buildSafePath — уже на раскрытом пути

    // Build grep flags
    const grepFlags = [];
    grepFlags.push('-E'); // Extended regex
    if (!caseSensitive) grepFlags.push('-i'); // Case insensitive
    if (context > 0) grepFlags.push(`-C ${context}`); // Context lines
    grepFlags.push('-n'); // Line numbers
    
    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, profileName, paths[0], sudo);
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
        content: [{ type: 'text', text: withTruncationNote(result.stdout, result.truncated) }],
      };
    }

    // Множественные логи - структурированный результат
    const results: Array<{
      path: string;
      matches: string;
      matchCount: number;
      success: boolean;
      truncated?: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = await this.buildSafePath(sshConfig, profileName, path, sudo);
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
            truncated: result.truncated,
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
        output += result.matches + '\n';
        if (result.truncated) output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        output += '\n';
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
   * Путь журнала для команды.
   *
   * `~` раскрывается у нас по домашнему каталогу из паспорта и уезжает в
   * одинарных кавычках — тем же способом, что в записи и чтении файлов.
   *
   * Правила профиля проверяются здесь же, после раскрытия. Раньше они стояли
   * выше по коду и смотрели на сырой путь: `~/secret` валидатор подменял
   * выдуманным `/home/user/secret`, и под root запрет `/root` не срабатывал —
   * замер на обоих контейнерах отдавал содержимое запрещённого файла.
   */
  private async buildSafePath(
    sshConfig: any,
    profileName: string,
    path: string,
    sudo: boolean
  ): Promise<string> {
    const target = await resolveRemotePath(this.executor, sshConfig, path, { profileName, sudo });

    for (const warning of target.warnings) {
      logger.warn(`[log-tools] ${warning}`);
    }

    return shellQuote(target.path);
  }

  /**
   * Escape query for grep
   */
  private escapeQuery(query: string): string {
    return query.replace(/'/g, "'\\''");
  }
}
