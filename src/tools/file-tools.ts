/**
 * SSH File Tools
 * Tools for working with files on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { ConnectionPool } from '../managers/connection-pool.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { createPathValidator } from '../utils/path-validator.js';
import {
  sha256OfBuffer,
  buildRemoteSha256Command,
  parseRemoteSha256,
} from '../utils/sha256.js';
import { buildTempPath, shellQuote } from '../utils/tmp-name.js';

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

    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const binary = args.binary === true;
    const encoding = binary ? 'base64' : (args.encoding || 'utf8');
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
    
    // Single file - simple result
    if (paths.length === 1) {
      if (binary) {
        const b64 = await this.readFileBinary(sshConfig, paths[0], profileName);
        return { content: [{ type: 'text', text: b64 }] };
      }
      const command = this.buildSafeCommand(paths[0], 'cat', encoding);

      const result = await this.executor.execute(sshConfig, command, {
        sudo,
        profileName,
        idempotent: true,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr || result.stdout}`);
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
        const command = this.buildSafeCommand(path, 'cat', encoding);

        const result = await this.executor.execute(sshConfig, command, {
          sudo,
          profileName,
          idempotent: true,
        });

        if (result.exitCode === 0) {
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
    
    const files = Array.isArray(args.files) ? args.files : [args.files];
    
    // Validate paths against security rules (if configured)
    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      for (const file of files) {
        const pathValidation = pathValidator.validate(file.path);
        if (!pathValidation.valid) {
          throw new Error(`Path validation failed: ${pathValidation.error}`);
        }
      }
    }
    
    // Single file - simple result
    if (files.length === 1) {
      const file = files[0];
      await this.writeFileRouted(sshConfig, file, profileName);

      return {
        content: [{ type: 'text', text: `File written successfully: ${file.path}` }],
      };
    }

    // Множественные файлы - структурированный результат
    const results: Array<{
      path: string;
      success: boolean;
      bytesWritten: number;
      error?: string;
    }> = [];

    for (const file of files) {
      try {
        await this.writeFileRouted(sshConfig, file, profileName);
        results.push({
          path: file.path,
          success: true,
          bytesWritten: file.binary
            ? Buffer.from(file.content || '', 'base64').length
            : Buffer.byteLength(file.content, 'utf8'),
        });
      } catch (error: any) {
        results.push({
          path: file.path,
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
   * Write file to remote server
   */
  private async writeFile(
    sshConfig: any,
    path: string,
    content: string,
    mode?: string,
    sudo: boolean = false,
    profileName?: string
  ): Promise<void> {
    // Expand tilde in path
    const expanded = this.expandRemoteTilde(path);
    
    // Escape content for heredoc
    const escapedContent = content.replace(/'/g, "'\"'\"'");
    
    // Build safe path for write
    let safePath: string;
    if (expanded.startsWith('$HOME')) {
      const homePrefix = '$HOME';
      const restPath = expanded.substring(5);
      const escapedRest = this.escapeForDoubleQuotes(restPath);
      safePath = `"${homePrefix}${escapedRest}"`;
    } else {
      safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
    }
    
    // Write command via heredoc
    let command = `cat > ${safePath} << 'SSHEOF'\n${escapedContent}\nSSHEOF`;
    
    // Add chmod if permissions specified
    if (mode) {
      command += ` && chmod ${mode} ${safePath}`;
    }
    
    const result = await this.executor.execute(sshConfig, command, { sudo, profileName });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file: ${result.stderr || result.stdout}`);
    }
  }

  /**
   * Route a write to either the heredoc fast path or SFTP path,
   * depending on the per-file flags.
   *
   * SFTP path is taken when ANY of:
   *  - file.binary === true
   *  - file.verify === true
   *  - file.atomic === true
   *  - utf8 content size > 256KB
   *
   * SFTP path also handles file.sudo via /tmp staging + `sudo install`.
   * Otherwise the legacy heredoc writer is used (back-compat).
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
    profileName: string
  ): Promise<void> {
    const useSftp =
      file.binary === true ||
      file.verify === true ||
      file.atomic === true ||
      Buffer.byteLength(file.content || '', 'utf8') > 256 * 1024;

    if (!useSftp) {
      // Legacy fast path — unchanged behaviour
      await this.writeFile(
        sshConfig,
        file.path,
        file.content,
        file.mode,
        file.sudo || false,
        profileName
      );
      return;
    }

    await this.writeFileSftp(sshConfig, file, profileName);
  }

  /**
   * SFTP write path: writes the buffer to a local temp file, fastPut to remote,
   * then optional sha256 verify, atomic rename, chmod, and sudo install.
   */
  private async writeFileSftp(
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
    profileName: string
  ): Promise<void> {
    const buf = file.binary
      ? Buffer.from(file.content || '', 'base64')
      : Buffer.from(file.content || '', 'utf8');

    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-write-'));
    const localFile = join(localDir, 'payload.bin');
    writeFileSync(localFile, buf);

    const expectedHash = sha256OfBuffer(buf);
    const atomic = file.atomic !== false && (file.atomic || file.verify);
    // For sudo writes we always stage in /tmp, then `sudo install`. atomic flag
    // is irrelevant in that path because install does an atomic rename itself.
    const remoteTarget = file.sudo
      ? `/tmp/.ssh-mcp-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : atomic
        ? buildTempPath(file.path)
        : file.path;

    const pool = ConnectionPool.getInstance();
    const sftp = await pool.getSftp(profileName, sshConfig);
    try {
      // Ensure parent dir on remote (best-effort, non-sudo path only)
      if (!file.sudo) {
        const parent = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
        if (parent && parent !== '/') {
          await this.executor.executeChecked(
            sshConfig,
            `mkdir -p ${shellQuote(parent)}`,
            { profileName }
          );
        }
      }
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localFile, remoteTarget, { concurrency: 4, chunkSize: 32768 }, (err) => {
          if (err) reject(new Error(`SFTP fastPut failed: ${err.message}`));
          else resolve();
        });
      });
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
      try { rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    try {
      if (file.verify) {
        const cmd = buildRemoteSha256Command(shellQuote(remoteTarget));
        const r = await this.executor.execute(sshConfig, cmd, {
          profileName,
          sudo: file.sudo,
          idempotent: true,
        });
        if (r.stdout.includes('NO_SHA256_TOOL')) {
          logger.warn(`[file-tools] sha256 tools not available on remote; verify skipped`);
        } else if (r.exitCode !== 0) {
          // Проверка не состоялась — это не то же самое, что испорченная запись
          throw new Error(
            `Failed to verify ${remoteTarget}: ${r.stderr.trim() || `exit code ${r.exitCode}`}`
          );
        } else {
          const actual = parseRemoteSha256(r.stdout);
          if (actual !== expectedHash) {
            await this.executor
              .execute(sshConfig, `rm -f ${shellQuote(remoteTarget)}`, {
                profileName,
                sudo: file.sudo,
              })
              .catch(() => undefined);
            throw new Error(
              `sha256 mismatch after write: local=${expectedHash}, remote differs`
            );
          }
        }
      }

      if (file.sudo) {
        // Move staged file into place
        const flags: string[] = [];
        if (file.mode) flags.push(`-m ${file.mode}`);
        const parent = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
        if (parent && parent !== '/') {
          await this.executor.executeChecked(
            sshConfig,
            `mkdir -p ${shellQuote(parent)}`,
            { profileName, sudo: true }
          );
        }
        await this.executor.executeChecked(
          sshConfig,
          `install ${flags.join(' ')} ${shellQuote(remoteTarget)} ${shellQuote(file.path)}`,
          { profileName, sudo: true }
        );
        await this.executor
          .execute(sshConfig, `rm -f ${shellQuote(remoteTarget)}`, { profileName })
          .catch(() => undefined);
      } else if (atomic) {
        await this.executor.executeChecked(
          sshConfig,
          `mv -f ${shellQuote(remoteTarget)} ${shellQuote(file.path)}`,
          { profileName }
        );
        if (file.mode) {
          await this.executor.executeChecked(
            sshConfig,
            `chmod ${file.mode} ${shellQuote(file.path)}`,
            { profileName }
          );
        }
      } else {
        // Non-atomic, non-sudo: chmod final path if mode set
        if (file.mode) {
          await this.executor.executeChecked(
            sshConfig,
            `chmod ${file.mode} ${shellQuote(file.path)}`,
            { profileName }
          );
        }
      }
    } catch (err) {
      // best-effort cleanup of staged file
      await this.executor
        .execute(sshConfig, `rm -f ${shellQuote(remoteTarget)}`, {
          profileName,
          sudo: file.sudo,
        })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Read a file via SFTP into a Buffer and return base64.
   * Used when binary=true to avoid utf8 corruption from `cat` over PTY.
   */
  private async readFileBinary(
    sshConfig: any,
    remotePath: string,
    profileName: string
  ): Promise<string> {
    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-read-'));
    const localFile = join(localDir, 'payload.bin');
    const pool = ConnectionPool.getInstance();
    const sftp = await pool.getSftp(profileName, sshConfig);
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          remotePath,
          localFile,
          { concurrency: 4, chunkSize: 32768 },
          (err) => {
            if (err) reject(new Error(`SFTP fastGet failed: ${err.message}`));
            else resolve();
          }
        );
      });
      const buf = (await import('fs/promises')).readFile(localFile);
      const data = await buf;
      return data.toString('base64');
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
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
    
    // Validate path against security rules (if configured)
    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      const pathValidation = pathValidator.validate(args.path);
      if (!pathValidation.valid) {
        throw new Error(`Path validation failed: ${pathValidation.error}`);
      }
    }
    
    const expanded = this.expandRemoteTilde(args.path);
    
    // Build safe path
    let safePath: string;
    if (expanded.startsWith('$HOME')) {
      const homePrefix = '$HOME';
      const restPath = expanded.substring(5);
      const escapedRest = this.escapeForDoubleQuotes(restPath);
      safePath = `"${homePrefix}${escapedRest}"`;
    } else {
      safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
    }
    
    let command = 'ls -lah';
    
    if (args.recursive) {
      command = 'ls -lRah';
    }
    
    if (args.pattern) {
      command += ` ${safePath}/${args.pattern}`;
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
      content: [{ type: 'text', text: result.stdout }],
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
   * 1. Single quotes prevent ~ expansion: cat '~/file' won't work
   * 2. $HOME works in double quotes: cat "$HOME/file" works
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
  private buildSafeCommand(path: string, command: string, encoding?: string): string {
    const expanded = this.expandRemoteTilde(path);
    
    // Path with $HOME → use double quotes for expansion
    if (expanded.startsWith('$HOME')) {
      // Split: $HOME (don't escape) + rest (escape everything)
      const homePrefix = '$HOME';
      const restPath = expanded.substring(5); // After $HOME
      
      // Escape only the part after $HOME
      const escapedRest = this.escapeForDoubleQuotes(restPath);
      const safePath = `"${homePrefix}${escapedRest}"`;
      
      // Build command based on encoding
      if (encoding === 'base64') {
        return `base64 ${safePath}`;
      } else if (command === 'cat') {
        return `cat ${safePath}`;
      } else if (command === 'tail') {
        return `tail ${safePath}`;
      } else {
        return `${command} ${safePath}`;
      }
    } else {
      // Regular path → use single quotes (safest)
      const safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
      
      // Build command based on encoding
      if (encoding === 'base64') {
        return `base64 ${safePath}`;
      } else if (command === 'cat') {
        return `cat ${safePath}`;
      } else if (command === 'tail') {
        return `tail ${safePath}`;
      } else {
        return `${command} ${safePath}`;
      }
    }
  }
  
  /**
   * Legacy escape method (kept for backward compatibility)
   * @deprecated Use escapeForSingleQuotes() or escapeForDoubleQuotes() instead
   */
  private escapePath(path: string): string {
    return this.escapeForSingleQuotes(path);
  }
}
