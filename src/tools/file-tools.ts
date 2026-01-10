/**
 * SSH File Tools
 * Инструменты для работы с файлами на удаленном сервере
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';

/**
 * File Tools
 */
export class FileTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Получить описания tools для MCP
   */
  getTools(): Tool[] {
    return [
      // ssh_file_read
      {
        name: 'ssh_file_read',
        description: 'Read file(s) from remote server. Supports single file or batch reading.',
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
        description: 'Write file(s) to remote server. Supports single file or batch writing.',
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
   * Обработать вызов tool
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
   * Обработать ssh_file_read
   */
  private async handleFileRead(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    const encoding = args.encoding || 'utf8';
    const sudo = args.sudo || false;
    
    // Если один файл - простой результат
    if (paths.length === 1) {
      const command = encoding === 'base64'
        ? `base64 '${this.escapePath(paths[0])}'`
        : `cat '${this.escapePath(paths[0])}'`;
      
      const result = await this.executor.execute(sshConfig, command, { sudo });
      
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
        const command = encoding === 'base64'
          ? `base64 '${this.escapePath(path)}'`
          : `cat '${this.escapePath(path)}'`;
        
        const result = await this.executor.execute(sshConfig, command, { sudo });
        
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
    
    // Форматируем вывод
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
   * Обработать ssh_file_write
   */
  private async handleFileWrite(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const files = Array.isArray(args.files) ? args.files : [args.files];
    
    // Если один файл - простой результат
    if (files.length === 1) {
      const file = files[0];
      await this.writeFile(sshConfig, file.path, file.content, file.mode, file.sudo || false);
      
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
        await this.writeFile(sshConfig, file.path, file.content, file.mode, file.sudo || false);
        results.push({
          path: file.path,
          success: true,
          bytesWritten: Buffer.byteLength(file.content, 'utf8'),
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
    
    // Форматируем вывод
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
   * Записать файл на удаленный сервер
   */
  private async writeFile(
    sshConfig: any,
    path: string,
    content: string,
    mode?: string,
    sudo: boolean = false
  ): Promise<void> {
    // Экранируем содержимое для heredoc
    const escapedContent = content.replace(/'/g, "'\"'\"'");
    
    // Команда записи через heredoc
    let command = `cat > '${this.escapePath(path)}' << 'SSHEOF'\n${escapedContent}\nSSHEOF`;
    
    // Добавляем chmod если указаны права
    if (mode) {
      command += ` && chmod ${mode} '${this.escapePath(path)}'`;
    }
    
    const result = await this.executor.execute(sshConfig, command, { sudo });
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file: ${result.stderr || result.stdout}`);
    }
  }
  
  /**
   * Обработать ssh_file_list
   */
  private async handleFileList(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    let command = 'ls -lah';
    
    if (args.recursive) {
      command = 'ls -lRah';
    }
    
    if (args.pattern) {
      command += ` '${this.escapePath(args.path)}'/${args.pattern}`;
    } else {
      command += ` '${this.escapePath(args.path)}'`;
    }
    
    const result = await this.executor.execute(sshConfig, command);
    
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list files: ${result.stderr || result.stdout}`);
    }
    
    return {
      content: [{ type: 'text', text: result.stdout }],
    };
  }
  
  /**
   * Экранировать путь для shell
   */
  private escapePath(path: string): string {
    return path.replace(/'/g, "'\"'\"'");
  }
}
