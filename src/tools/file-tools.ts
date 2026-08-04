/**
 * SSH File Tools
 * Tools for working with files on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, posix as posixPath } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { sha256OfBuffer } from '../utils/sha256.js';
import { verifyRemoteFiles } from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath, type ExpandedPath } from '../managers/remote-home.js';
import { buildSudoStagingPath, shellQuote } from '../utils/tmp-name.js';
import { shellGlob, shellMode } from '../utils/shell-arg.js';
import { truncatedReadMessage, withTruncationNote } from '../utils/output-notes.js';

/**
 * До какого размера содержимое едет прямо в канале команды.
 *
 * Выше этой границы файл отдаётся транспорту: держать мегабайты в памяти
 * процесса и гнать их одним куском незачем, а транспорт умеет их потоком.
 */
const INLINE_WRITE_LIMIT = 256 * 1024;

/**
 * File Tools
 */
export class FileTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool descriptions for MCP
   */
  getTools(): Tool[] {
    return [
      // ssh_file_read
      {
        name: 'ssh_file_read',
        description:
          'Read file(s) from remote server. Supports single file or batch reading. ' +
          'For binaries use binary=true (reads via SFTP, returns base64). ' +
          'For large files prefer ssh_download.',
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
              description: 'File path or array of file paths to read',
            },
            encoding: {
              type: 'string',
              enum: ['utf8', 'base64'],
              description: 'File encoding. Default: utf8',
              default: 'utf8',
            },
            binary: {
              type: 'boolean',
              description:
                'Read via SFTP and return base64 (binary-safe). Default: false. Implies encoding=base64.',
              default: false,
            },
            sudo: {
              type: 'boolean',
              description: 'Read files with sudo. Default: false',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      
      // ssh_file_write
      {
        name: 'ssh_file_write',
        description:
          'Write file(s) to remote server. Supports single file or batch writing. ' +
          'Optional flags per file: verify (sha256 after write), atomic (write to .tmp + rename), ' +
          'binary (content is base64; uploaded via SFTP — required for binaries). ' +
          'For files >256KB, binaries, or directories prefer ssh_upload.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            files: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    mode: { type: 'string', description: 'File permissions (e.g., "644", "755")' },
                    sudo: { type: 'boolean', description: 'Write with sudo' },
                    verify: {
                      type: 'boolean',
                      description: 'Verify sha256 after write. Default: false.',
                    },
                    atomic: {
                      type: 'boolean',
                      description:
                        'Write to a temp path next to target and rename on success. Default: false.',
                    },
                    binary: {
                      type: 'boolean',
                      description:
                        'Content is base64-encoded; upload via SFTP. Default: false.',
                    },
                  },
                  required: ['path', 'content'],
                },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      content: { type: 'string' },
                      mode: { type: 'string' },
                      sudo: { type: 'boolean' },
                      verify: { type: 'boolean' },
                      atomic: { type: 'boolean' },
                      binary: { type: 'boolean' },
                    },
                    required: ['path', 'content'],
                  },
                },
              ],
              description: 'Single file object or array of file objects to write',
            },
          },
          required: ['files'],
        },
      },
      
      // ssh_file_list
      {
        name: 'ssh_file_list',
        description: 'List files in directory on remote server',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            path: {
              type: 'string',
              description: 'Directory path to list',
            },
            pattern: {
              type: 'string',
              description: 'File pattern (e.g., "*.log", "*.conf")',
            },
            recursive: {
              type: 'boolean',
              description: 'List files recursively. Default: false',
              default: false,
            },
          },
          required: ['path'],
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
        case 'ssh_file_read':
          return await this.handleFileRead(request);
        case 'ssh_file_write':
          return await this.handleFileWrite(request);
        case 'ssh_file_list':
          return await this.handleFileList(request);
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
   * Handle ssh_file_read
   */
  private async handleFileRead(request: CallToolRequest) {
    const args = request.params.arguments as any;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const requested = Array.isArray(args.path) ? args.path : [args.path];
    const binary = args.binary === true;
    const encoding = binary ? 'base64' : (args.encoding || 'utf8');
    const sudo = args.sudo || false;

    // Пути раскрываются и проверяются правилами до первой команды — весь
    // список сразу, как и раньше: отказ на пятом файле не должен приходить
    // после того, как первые четыре уже прочитаны
    const paths: string[] = [];
    for (const path of requested) {
      const target = await resolveRemotePath(this.executor, sshConfig, path, { profileName, sudo });
      for (const warning of target.warnings) logger.warn(`[file-tools] ${warning}`);
      paths.push(target.path);
    }

    // Single file - simple result
    if (paths.length === 1) {
      if (binary) {
        const b64 = await this.readFileBinary(sshConfig, paths[0], profileName);
        return { content: [{ type: 'text', text: b64 }] };
      }
      const command = this.buildReadCommand(paths[0], encoding);

      const result = await this.executor.execute(sshConfig, command, {
        sudo,
        profileName,
        idempotent: true,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr || result.stdout}`);
      }

      // Часть файла нельзя отдавать как файл: дальше её примут за содержимое
      if (result.truncated) {
        throw new Error(`Failed to read file: ${truncatedReadMessage(paths[0])}`);
      }

      return {
        content: [{ type: 'text', text: result.stdout }],
      };
    }
    
    // Множественные файлы - структурированный результат
    const results: Array<{
      path: string;
      content: string;
      size: number;
      success: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        if (binary) {
          const b64 = await this.readFileBinary(sshConfig, path, profileName);
          results.push({
            path,
            content: b64,
            size: Buffer.from(b64, 'base64').length,
            success: true,
          });
          continue;
        }
        const command = this.buildReadCommand(path, encoding);

        const result = await this.executor.execute(sshConfig, command, {
          sudo,
          profileName,
          idempotent: true,
        });

        if (result.exitCode === 0 && result.truncated) {
          results.push({
            path,
            content: '',
            size: 0,
            success: false,
            error: truncatedReadMessage(path),
          });
        } else if (result.exitCode === 0) {
          results.push({
            path,
            content: result.stdout,
            size: Buffer.byteLength(result.stdout, 'utf8'),
            success: true,
          });
        } else {
          results.push({
            path,
            content: '',
            size: 0,
            success: false,
            error: result.stderr || result.stdout,
          });
        }
      } catch (error: any) {
        results.push({
          path,
          content: '',
          size: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Read ${results.length} files:\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `✓ ${result.path} (${result.size} bytes)\n`;
        output += '─'.repeat(60) + '\n';
        output += result.content + '\n\n';
      } else {
        output += `✗ ${result.path}\n`;
        output += `  Error: ${result.error}\n\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }],
    };
  }
  
  /**
   * Handle ssh_file_write
   */
  private async handleFileWrite(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const requested = Array.isArray(args.files) ? args.files : [args.files];

    // Пути раскрываются и проверяются правилами до первой записи — весь список
    // сразу: отказ на пятом файле не должен приходить после того, как первые
    // четыре уже легли на сервер
    const files: Array<{ file: any; target: ExpandedPath }> = [];
    for (const file of requested) {
      files.push({
        file,
        target: await resolveRemotePath(this.executor, sshConfig, file.path, {
          profileName,
          sudo: file.sudo,
        }),
      });
    }

    // Single file - simple result
    if (files.length === 1) {
      const { file, target } = files[0];
      const written = await this.writeFileRouted(sshConfig, file, target, profileName);

      // Печатается путь, по которому файл оказался на самом деле: при `~` он
      // отличается от запрошенного, и человек должен видеть настоящий адрес
      const notes = written.warnings.map((warning) => `\n⚠ ${warning}`).join('');

      return {
        content: [{ type: 'text', text: `File written successfully: ${written.path}${notes}` }],
      };
    }

    // Множественные файлы - структурированный результат
    const results: Array<{
      path: string;
      success: boolean;
      bytesWritten: number;
      warnings?: string[];
      error?: string;
    }> = [];

    for (const { file, target } of files) {
      try {
        const written = await this.writeFileRouted(sshConfig, file, target, profileName);
        results.push({
          path: written.path,
          success: true,
          warnings: written.warnings,
          bytesWritten: file.binary
            ? Buffer.from(file.content || '', 'base64').length
            : Buffer.byteLength(file.content, 'utf8'),
        });
      } catch (error: any) {
        results.push({
          path: target.path,
          success: false,
          bytesWritten: 0,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Write ${results.length} files:\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `✓ ${result.path} (${result.bytesWritten} bytes)\n`;
        for (const warning of result.warnings || []) {
          output += `  ⚠ ${warning}\n`;
        }
      } else {
        output += `✗ ${result.path}\n`;
        output += `  Error: ${result.error}\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }],
    };
  }
  
  /**
   * Записать файл на сервер.
   *
   * Путь один на любое содержимое: данные попадают во временный путь рядом с
   * целью и встают на место установщиком. Различается только способ наполнения
   * временного пути — мелкое едет потоком в stdin команды `cat`, крупное и
   * двоичное отдаётся транспорту.
   *
   * Содержимое не появляется в строке команды никогда. Прежний быстрый путь
   * вклеивал его в heredoc, и на живых серверах это портило запись: апостроф
   * превращался в пять символов, строка `SSHEOF` внутри текста обрывала файл,
   * а его остаток исполнялся как команды.
   */
  private async writeFileRouted(
    sshConfig: any,
    file: {
      path: string;
      content: string;
      mode?: string;
      sudo?: boolean;
      verify?: boolean;
      atomic?: boolean;
      binary?: boolean;
    },
    /** Раскрытый и уже проверенный правилами путь назначения */
    target: ExpandedPath,
    profileName: string
  ): Promise<{ path: string; warnings: string[] }> {
    const buf = file.binary
      ? Buffer.from(file.content || '', 'base64')
      : Buffer.from(file.content || '', 'utf8');

    // Права проверяются до первой команды: отказ на полпути оставил бы после
    // себя временный путь и запись, которой не просили
    const mode = file.mode ? shellMode(file.mode, 'mode') : undefined;

    const expectedHash = sha256OfBuffer(buf);
    const ops = remotePathOps({
      executor: this.executor,
      config: sshConfig,
      profileName,
      sudo: file.sudo,
    });

    const outcome = await install(ops, {
      finalPath: target.path,
      kind: 'file',
      stage: (staging) =>
        buf.length > INLINE_WRITE_LIMIT
          ? this.stageByTransport(sshConfig, profileName, staging, buf, file.sudo)
          : this.stageByStdin(sshConfig, profileName, staging, buf, file.sudo),
      verify: async (staging) => {
        if (!file.verify) return null;

        const result = await verifyRemoteFiles(
          this.executor,
          sshConfig,
          [{ path: staging, hash: expectedHash }],
          { profileName, sudo: file.sudo }
        );

        if (result.status === 'mismatched') {
          return `local=${expectedHash}, remote differs`;
        }

        // «Проверить нечем» — не то же самое, что испорченная запись:
        // отказывать здесь значило бы рушить исправную запись на сервере
        // без sha256sum и openssl
        if (result.status === 'unavailable') {
          logger.warn(`[file-tools] verification skipped: ${result.reason}`);
        }

        return null;
      },
      finalize: async (staging) => {
        if (!mode) return;
        await this.executor.executeChecked(
          sshConfig,
          `chmod ${mode} -- ${shellQuote(staging)}`,
          { profileName, sudo: file.sudo }
        );
      },
    });

    return { path: outcome.path, warnings: [...target.warnings, ...outcome.warnings] };
  }

  /**
   * Наполнить временный путь потоком в stdin.
   *
   * Содержимое идёт байтами по каналу, а не текстом команды, поэтому shell его
   * не разбирает: ни кавычки, ни границы строк, ни нулевой байт ничего не
   * значат. Проверено вживую на BusyBox и dash, на обоих бэкендах.
   */
  private async stageByStdin(
    sshConfig: any,
    profileName: string,
    staging: string,
    content: Buffer,
    sudo?: boolean
  ): Promise<void> {
    await this.executor.executeChecked(sshConfig, `cat > ${shellQuote(staging)}`, {
      profileName,
      sudo,
      stdin: content,
    });
  }

  /** Наполнить временный путь через транспорт: для крупного и двоичного */
  private async stageByTransport(
    sshConfig: any,
    profileName: string,
    staging: string,
    content: Buffer,
    sudo?: boolean
  ): Promise<void> {
    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-write-'));
    const localFile = join(localDir, 'payload.bin');
    writeFileSync(localFile, content);

    try {
      const runner = await getRunner(sshConfig, profileName);

      if (!sudo) {
        await runner.upload(localFile, staging);
        return;
      }

      // Под sudo передача идёт от имени пользователя в /tmp, а рядом с целью
      // копия появляется уже с правами. `install` здесь не годится: он
      // копирует поверх, то есть уничтожает старое содержимое до того, как
      // записано новое, — ровно то, чего этот протокол не допускает
      const handoff = buildSudoStagingPath();
      await runner.upload(localFile, handoff);
      try {
        await this.executor.executeChecked(
          sshConfig,
          `cp -- ${shellQuote(handoff)} ${shellQuote(staging)}`,
          { profileName, sudo: true }
        );
      } finally {
        await this.executor
          .execute(sshConfig, `rm -f -- ${shellQuote(handoff)}`, { profileName })
          .catch(() => undefined);
      }
    } finally {
      try { rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Забрать файл целиком и вернуть base64.
   * Нужно при binary=true: `cat` через PTY портит байты вне utf8.
   */
  private async readFileBinary(
    sshConfig: any,
    remotePath: string,
    profileName: string
  ): Promise<string> {
    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-read-'));
    const localFile = join(localDir, 'payload.bin');
    try {
      const runner = await getRunner(sshConfig, profileName);
      await runner.download(remotePath, localFile);

      const data = await readFile(localFile);
      return data.toString('base64');
    } finally {
      try { rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Handle ssh_file_list
   */
  private async handleFileList(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const target = await resolveRemotePath(this.executor, sshConfig, args.path, { profileName });
    const safePath = shellQuote(target.path);

    let command = 'ls -lah';
    
    if (args.recursive) {
      command = 'ls -lRah';
    }
    
    if (args.pattern) {
      // Шаблон обязан раскрыться на сервере, поэтому в кавычки он не уходит:
      // всё, кроме знаков шаблона, обезврежено обратным слэшем
      command += ` ${safePath}/${shellGlob(args.pattern, 'pattern')}`;
    } else {
      command += ` ${safePath}`;
    }
    
    const result = await this.executor.execute(sshConfig, command, {
      profileName,
      idempotent: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list files: ${result.stderr || result.stdout}`);
    }

    return {
      content: [{ type: 'text', text: withTruncationNote(result.stdout, result.truncated) }],
    };
  }
  
  /**
   * Команда чтения файла.
   *
   * Путь приходит сюда уже раскрытым и уезжает в одинарных кавычках — тем же
   * способом, что и при записи.
   */
  private buildReadCommand(path: string, encoding: string): string {
    return `${encoding === 'base64' ? 'base64' : 'cat'} ${shellQuote(path)}`;
  }
}
