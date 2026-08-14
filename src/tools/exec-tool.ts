/**
 * SSH Exec Tool
 * Universal tool for executing SSH commands
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { DEFAULT_TIMEOUT_MS, SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { requireTextList } from '../utils/tool-args.js';
import { exitCodeHint, TRUNCATED_OUTPUT_NOTE, withTruncationNote } from '../utils/output-notes.js';
import {
  blockedMessage,
  CONFIRMATION_MARKER,
  findRemovalTargets,
  inspectCommand,
} from '../utils/destructive-command.js';
import { resolveRemovalTargets } from '../managers/removal-guard.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/**
 * Dangerous command patterns
 */
/*
 * Удаление в этом списке больше не значится: шаблон `rm -rf /` срабатывал на
 * любом абсолютном пути и печатал «rm -rf / detected» даже на `echo "rm -rf /"`.
 * Предупреждение, которое кричит на штатной уборке, агент перестаёт читать —
 * и настоящий снос корня в этом шуме теряется. Настоящую проверку делает
 * destructive-command.ts: она смотрит, куда путь ведёт, и не пускает команду.
 */
const DANGEROUS_PATTERNS = [
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
      description:
        'Execute command(s) on remote server via SSH. Supports single command or batch execution. ' +
        'SAFETY: a recursive delete is refused before anything runs when its target is the filesystem root, ' +
        'the home directory or a system tree (/etc, /usr, /var, /home, …) — including a path that only reaches ' +
        'one of them through a symlink, and including a target the server expands itself (variable, substitution, ' +
        `glob), which cannot be checked in advance. To run such a command deliberately, append "${CONFIRMATION_MARKER}" ` +
        'to that specific command; other commands in the same batch are unaffected.',
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
            description:
              `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} ` +
              `(${DEFAULT_TIMEOUT_MS / 1000} seconds)`,
            default: DEFAULT_TIMEOUT_MS,
          },
        },
        required: ['command'],
      },
    };
  }
  
  /**
   * Handle tool call
   */
  async handleCall(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const args = request.params.arguments as any;
      
      // Validate array parameter format
      const validation = validateArrayParameter(args.command, 'command');
      if (!validation.isValid) {
        return createValidationErrorResponse(validation.errorMessage!);
      }
      
      // Resolve SSH config and profile name
      const sshConfig = resolveSSHConfig({ profile: args.profile });
      
      // Форма проверяется до первой команды: без этого отсутствующий или не
      // строковый `command` доходил до executor и падал внутренним
      // `finalCommand.substring is not a function` — из такого текста
      // вызывающий не поймёт, что ошибся формой.
      const commands = requireTextList(args.command, 'command', '"uptime"');
      
      // Удаление корня, дома или системного дерева останавливается ДО первой
      // отправки — и весь вызов целиком. Проверять по ходу нельзя: половина
      // батча уехала бы, а состояние сервера стало бы неизвестным.
      const refusal = await this.refuseDestructive(commands, sshConfig, args.sudo);
      if (refusal) {
        return { content: [{ type: 'text', text: refusal }] };
      }

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
          // Ноль здесь значит «срок не назван»: общий срок подставит слой ниже
          timeout: args.timeout || undefined,
          signal,
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
          output += `\n\nExit code: ${result.exitCode}${exitCodeHint(result.exitCode)}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: withTruncationNote(
                output || '(command executed successfully, no output)',
                result.truncated
              ),
            },
          ],
        };
      }
      
      // Multiple commands - return structured result
      const results: Array<{
        command: string;
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated: boolean;
      }> = [];
      
      for (const cmd of commands) {
        const result = await this.executor.execute(sshConfig, cmd, {
          sudo: args.sudo || false,
          cwd: args.cwd,
          // Ноль здесь значит «срок не назван»: общий срок подставит слой ниже
          timeout: args.timeout || undefined,
          signal,
        });
        
        results.push({
          command: cmd,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
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
        
        output += `Exit code: ${result.exitCode}${exitCodeHint(result.exitCode)}\n`;

        if (result.truncated) {
          output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        }

        output += '\n';
      }
      
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error: any) {
      logger.error('ssh_exec failed:', error);
      return toolFailure(error);
    }
  }

  /**
   * Отказ, если хоть одна команда вызова сносит корень, дом или систему.
   *
   * Разбор строки решает почти всё сразу и без сети; на сервер уходит один
   * запрос и только за тем, чего в тексте не видно, — куда ведёт ссылка.
   * Возвращает готовый текст отказа или null, если идти можно.
   */
  private async refuseDestructive(
    commands: string[],
    config: SSHConfig,
    sudo?: boolean
  ): Promise<string | null> {
    // Паспорт нужен только ради домашнего каталога, а он нужен только там, где
    // удаление вообще есть. Обычная команда не должна платить за проверку,
    // которая её не касается, — поэтому дом берётся лениво.
    let home: string | null = null;

    for (const command of commands) {
      if (findRemovalTargets(command).length === 0) continue;
      if (home === null) home = (await this.executor.passport(config)).home;

      const verdict = inspectCommand(command, home);
      if (verdict.blocked) {
        return blockedMessage(command, verdict.reason!);
      }

      if (verdict.needsResolution.length > 0) {
        const resolution = await resolveRemovalTargets(
          this.executor,
          config,
          verdict.needsResolution,
          { sudo }
        );
        if (resolution.blocked) {
          return blockedMessage(command, resolution.reason!);
        }
      }
    }

    return null;
  }
}
