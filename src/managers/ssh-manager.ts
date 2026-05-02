/**
 * SSH Manager
 * Управление SSH соединениями и выполнением команд на удаленных серверах
 * v1.1.0 - Использует ConnectionPool для переиспользования соединений
 */

import { Client, SFTPWrapper } from 'ssh2';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { ConnectionPool } from './connection-pool.js';

export interface SSHExecuteOptions {
  /** Таймаут выполнения команды (мс) */
  timeout?: number;
  /** Кодировка вывода */
  encoding?: BufferEncoding;
  /** Имя профиля для пула соединений */
  profileName?: string;
}

export interface SSHFileTransferOptions {
  /** Права доступа для файла (octal number, e.g. 0o644) */
  mode?: number;
  /** Имя профиля для пула соединений */
  profileName?: string;
  /** Concurrency for fastPut/fastGet chunking */
  concurrency?: number;
  /** Chunk size in bytes (default 32768) */
  chunkSize?: number;
}

/**
 * SSH Manager для выполнения команд и работы с файлами
 * v1.1.0 - Использует ConnectionPool для переиспользования соединений
 */
export class SSHManager {
  /**
   * Выполнить команду на удаленном сервере
   * @param config - SSH конфигурация
   * @param command - Команда для выполнения
   * @param options - Опции выполнения
   * @returns Вывод команды (stdout)
   */
  async execute(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<string> {
    const pool = ConnectionPool.getInstance();
    const profileName = options.profileName || 'default';
    const timeout = options.timeout || 30000;
    
    // Get client from pool
    const client = await pool.getClient(profileName, config);
    
    try {
      const result = await this.executeOnClient(client, command, options);
      return result;
    } finally {
      // Release client back to pool
      pool.releaseClient(profileName);
    }
  }

  /**
   * Выполнить несколько команд последовательно
   * v1.1.0 - Использует одно соединение для всех команд
   */
  async executeBatch(
    config: SSHConfig,
    commands: string[],
    options: SSHExecuteOptions = {}
  ): Promise<string[]> {
    const pool = ConnectionPool.getInstance();
    const profileName = options.profileName || 'default';
    
    // Get client from pool ONCE for all commands
    const client = await pool.getClient(profileName, config);
    
    const results: string[] = [];
    
    try {
      // Execute all commands on the same client
      for (const command of commands) {
        const result = await this.executeOnClient(client, command, options);
        results.push(result);
      }
      
      return results;
    } finally {
      // Release client after ALL commands
      pool.releaseClient(profileName);
    }
  }

  /**
   * Выполнить команду на конкретном клиенте
   * @param client - SSH2 клиент
   * @param command - Команда для выполнения
   * @param options - Опции выполнения
   * @returns Вывод команды (stdout)
   */
  private executeOnClient(
    client: Client,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 30000;
      let timeoutId: NodeJS.Timeout;
      let settled = false;

      // Helper to resolve once
      const resolveOnce = (value: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        }
      };

      // Helper to reject once
      const rejectOnce = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        }
      };

      logger.debug(`[SSH Manager] Executing command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);

      client.exec(command, (err, stream) => {
        if (err) {
          rejectOnce(new Error(`Failed to execute command: ${err.message}`));
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          if (code !== 0) {
            rejectOnce(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
          } else {
            resolveOnce(stdout);
          }
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString(options.encoding || 'utf8');
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString(options.encoding || 'utf8');
        });
      });

      // Timeout
      timeoutId = setTimeout(() => {
        rejectOnce(new Error(`SSH command timeout after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * Загрузить файл с удалённого сервера через SFTP (binary-safe, streaming).
   */
  async downloadFile(
    config: SSHConfig,
    remotePath: string,
    localPath: string,
    options: SSHFileTransferOptions = {}
  ): Promise<void> {
    const pool = ConnectionPool.getInstance();
    const profileName = options.profileName || 'default';
    const sftp = await pool.getSftp(profileName, config);

    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          remotePath,
          localPath,
          {
            concurrency: options.concurrency ?? 4,
            chunkSize: options.chunkSize ?? 32768,
          },
          (err) => {
            if (err) {
              reject(new Error(`SFTP download failed: ${err.message}`));
              return;
            }
            resolve();
          }
        );
      });
      logger.debug(`[SSH Manager] downloadFile ${remotePath} -> ${localPath}`);
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
    }
  }

  /**
   * Загрузить файл на удалённый сервер через SFTP (binary-safe, streaming).
   * mode опционально применяется через chmod после успешной заливки.
   */
  async uploadFile(
    config: SSHConfig,
    localPath: string,
    remotePath: string,
    options: SSHFileTransferOptions = {}
  ): Promise<void> {
    const pool = ConnectionPool.getInstance();
    const profileName = options.profileName || 'default';
    const sftp = await pool.getSftp(profileName, config);

    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          localPath,
          remotePath,
          {
            concurrency: options.concurrency ?? 4,
            chunkSize: options.chunkSize ?? 32768,
            mode: options.mode,
          },
          (err) => {
            if (err) {
              reject(new Error(`SFTP upload failed: ${err.message}`));
              return;
            }
            resolve();
          }
        );
      });
      logger.debug(`[SSH Manager] uploadFile ${localPath} -> ${remotePath}`);
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
    }
  }

  /**
   * Получить SFTP-канал на пуле для расширенных операций.
   * Caller обязан вызвать sftp.end() и pool.releaseClient(profileName).
   */
  async getSftp(config: SSHConfig, profileName: string = 'default'): Promise<SFTPWrapper> {
    const pool = ConnectionPool.getInstance();
    return pool.getSftp(profileName, config);
  }

  /**
   * Проверить подключение к серверу
   */
  async testConnection(config: SSHConfig, profileName?: string): Promise<boolean> {
    try {
      await this.execute(config, 'echo "test"', { timeout: 5000, profileName });
      return true;
    } catch {
      return false;
    }
  }
}
