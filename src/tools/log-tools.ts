/**
 * SSH Log Tools
 * Tools for working with logs on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import {
  TRUNCATED_OUTPUT_NOTE,
  withTruncationNote,
  DEFAULT_MAX_MATCHES,
  limitMatches,
  matchLimitNote,
} from '../utils/output-notes.js';
import { shellCount, shellQuote } from '../utils/shell-arg.js';
import { requireText, requireTextList } from '../utils/tool-args.js';
import { resolveRemotePath } from '../managers/path-guard.js';
import { posix as posixPath } from 'path';

/** Знаки, из-за которых имя считается шаблоном, а не именем файла */
const GLOB_CHARS = /[*?[]/;

/** Сколько файлов шаблон раскрывает за раз */
const MAX_GLOB_MATCHES = 50;

/** Маркер ответа: путь существует под своим именем, шаблон раскрывать нечего */
const GLOB_LITERAL = 'SSH_MCP_GLOB_LITERAL';

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
              description: 'Log file path, glob pattern (*.log), or array of paths',
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
            maxMatches: {
              type: 'number',
              description: `Maximum matches per log file. Default: ${DEFAULT_MAX_MATCHES}`,
              default: DEFAULT_MAX_MATCHES,
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
  async handleCall(request: CallToolRequest): Promise<ToolResult> {
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
      return toolFailure(error);
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
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const requested = requireTextList(args.path, 'path', '"/var/log/syslog"');
    // Тип из схемы ничего не гарантирует: MCP отдаёт аргументы как есть
    const lines = shellCount(args.lines ?? 100, 'lines');
    const sudo = args.sudo || false;

    // Правила профиля проверяет buildSafePath — уже на раскрытом пути
    const { paths, notes } = await this.expandPatterns(sshConfig, requested, sudo);

    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, paths[0], sudo);
      const command = `tail -n ${lines} ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read log: ${result.stderr || result.stdout}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: this.withGlobNotes(
              withTruncationNote(result.stdout || '(empty log)', result.truncated),
              notes
            ),
          },
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
        const safePath = await this.buildSafePath(sshConfig, path, sudo);
        const command = `tail -n ${lines} ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true });
        
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
      content: [{ type: 'text', text: this.withGlobNotes(output, notes) }],
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
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const requested = requireTextList(args.path, 'path', '"/var/log/syslog"');
    const query = requireText(args.query, 'query', '"error"');
    const context = shellCount(args.context ?? 0, 'context');
    const caseSensitive = args.caseSensitive || false;
    const maxMatches = shellCount(args.maxMatches ?? DEFAULT_MAX_MATCHES, 'maxMatches');
    const sudo = args.sudo || false;

    // Правила профиля проверяет buildSafePath — уже на раскрытом пути
    const { paths, notes } = await this.expandPatterns(sshConfig, requested, sudo);

    // Build grep flags
    const grepFlags = [];
    grepFlags.push('-E'); // Extended regex
    if (!caseSensitive) grepFlags.push('-i'); // Case insensitive
    if (context > 0) grepFlags.push(`-C ${context}`); // Context lines
    grepFlags.push('-n'); // Line numbers
    // Одно совпадение сверх предела — признак, что в журнале есть ещё.
    // Предел ставит сама grep, а не хвостовой `head`: он вернул бы ноль и за
    // отсутствующий файл, и «нечего искать» стало бы неотличимо от ошибки
    grepFlags.push(`-m ${maxMatches + 1}`);
    
    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, paths[0], sudo);
      const command = `grep ${grepFlags.join(' ')} ${shellQuote(query)} ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true });
      
      // grep exit code 1 = no matches (not an error)
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Failed to search log: ${result.stderr || result.stdout}`);
      }
      
      if (!result.stdout) {
        return {
          content: [{ type: 'text', text: this.withGlobNotes('No matches found', notes) }],
        };
      }

      const limited = limitMatches(result.stdout, maxMatches);

      return {
        content: [
          {
            type: 'text',
            text: this.withGlobNotes(
              limited.limited
                ? `${withTruncationNote(limited.text, result.truncated)}\n\n${matchLimitNote(maxMatches)}`
                : withTruncationNote(limited.text, result.truncated),
              notes
            ),
          },
        ],
      };
    }

    // Множественные логи - структурированный результат
    const results: Array<{
      path: string;
      matches: string;
      matchCount: number;
      success: boolean;
      truncated?: boolean;
      limited?: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = await this.buildSafePath(sshConfig, path, sudo);
        const command = `grep ${grepFlags.join(' ')} ${shellQuote(query)} ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true });
        
        // grep exit code 1 = no matches
        if (result.exitCode === 0 || result.exitCode === 1) {
          const limited = limitMatches(result.stdout, maxMatches);
          const matchCount = limited.text ? limited.text.split('\n').filter(line => line.length > 0).length : 0;
          results.push({
            path,
            matches: limited.text || '(no matches)',
            matchCount,
            success: true,
            truncated: result.truncated,
            limited: limited.limited,
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
        if (result.limited) output += `${matchLimitNote(maxMatches)}\n`;
        output += '\n';
      } else {
        output += `=== ${result.path} (ERROR) ===\n`;
        output += `Error: ${result.error}\n\n`;
      }
    }

    return {
      content: [{ type: 'text', text: this.withGlobNotes(output, notes) }],
    };
  }
  
  /**
   * Файлы, которые назвал шаблон.
   *
   * Раскрывает его `find` по имени, а не оболочка сервера: путь уезжает в
   * кавычках, иначе вместе со звёздочкой ожили бы пробел, `$(…)` и перевод
   * строки в имени. Каталог проверяется правилами профиля здесь, каждое
   * найденное имя — обычным путём в месте вызова.
   *
   * Путь, существующий под своим именем, шаблоном не считается: скобка в имени
   * файла читалась и раньше.
   */
  private async expandPatterns(
    sshConfig: any,
    paths: string[],
    sudo: boolean
  ): Promise<{ paths: string[]; notes: string[] }> {
    const expanded: string[] = [];
    const notes: string[] = [];

    for (const path of paths) {
      const pattern = posixPath.basename(path);
      const directory = posixPath.dirname(path);

      if (GLOB_CHARS.test(directory)) {
        throw new Error(
          `cannot expand "${path}": a pattern is supported in the file name, not in the directory.`
        );
      }

      if (!GLOB_CHARS.test(pattern)) {
        expanded.push(path);
        continue;
      }

      const target = await resolveRemotePath(this.executor, sshConfig, directory, {
        sudo,
      });
      for (const warning of target.warnings) {
        logger.warn(`[log-tools] ${warning}`);
      }

      const literal = posixPath.join(target.path, pattern);
      const result = await this.executor.execute(
        sshConfig,
        `if [ -e ${shellQuote(literal)} ]; then printf '${GLOB_LITERAL}\\n'; else ` +
          `find ${shellQuote(target.path)} -maxdepth 1 ! -type d ` +
          `-name ${shellQuote(pattern)} -print0 2>/dev/null; fi`,
        { sudo, idempotent: true }
      );

      if (result.stdout.split('\n').some((line) => line.trim() === GLOB_LITERAL)) {
        expanded.push(literal);
        continue;
      }

      // Скрытые файлы шаблон без точки не называет — как и оболочка
      const matches = result.stdout
        .split('\0')
        .filter((name) => name.length > 0)
        .filter((name) => pattern.startsWith('.') || !posixPath.basename(name).startsWith('.'))
        .sort();

      if (matches.length === 0) {
        throw new Error(
          result.truncated
            ? `cannot expand "${path}": the list of matching files was too long to read.`
            : `no files match "${path}"`
        );
      }

      if (result.truncated) {
        notes.push(`Note: the list of files matching "${path}" was cut off, so it may be incomplete.`);
      }

      if (matches.length > MAX_GLOB_MATCHES) {
        notes.push(
          `Note: "${path}" matched ${matches.length} files, showing the first ${MAX_GLOB_MATCHES}.`
        );
      }

      expanded.push(...matches.slice(0, MAX_GLOB_MATCHES));
    }

    return { paths: expanded, notes };
  }

  /** Пометки о раскрытии шаблона идут под ответом, а не вместо него */
  private withGlobNotes(text: string, notes: string[]): string {
    return notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text;
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
    path: string,
    sudo: boolean
  ): Promise<string> {
    const target = await resolveRemotePath(this.executor, sshConfig, path, { sudo });

    for (const warning of target.warnings) {
      logger.warn(`[log-tools] ${warning}`);
    }

    return shellQuote(target.path);
  }
}
