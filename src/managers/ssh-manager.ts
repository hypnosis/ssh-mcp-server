/**
 * SSH Manager
 * Управление SSH соединениями и выполнением команд на удаленных серверах
 */

import { Client, ConnectConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';

export interface SSHExecuteOptions {
  /** Таймаут выполнения команды (мс) */
  timeout?: number;
  /** Кодировка вывода */
  encoding?: BufferEncoding;
}

export interface SSHFileTransferOptions {
  /** Права доступа для файла */
  mode?: number;
}

/**
 * SSH Manager для выполнения команд и работы с файлами
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
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = options.timeout || 30000;
      let timeoutId: NodeJS.Timeout;

      client.on('ready', () => {
        logger.debug(`SSH connected to ${config.host}, executing: ${command}`);

        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeoutId);
            client.end();
            reject(new Error(`Failed to execute command: ${err.message}`));
            return;
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code: number, signal: string) => {
            clearTimeout(timeoutId);
            client.end();

            if (code !== 0) {
              reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
            } else {
              resolve(stdout);
            }
          });

          stream.on('data', (data: Buffer) => {
            stdout += data.toString(options.encoding || 'utf8');
          });

          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString(options.encoding || 'utf8');
          });
        });
      });

      client.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      // Таймаут подключения
      timeoutId = setTimeout(() => {
        client.end();
        reject(new Error(`SSH command timeout after ${timeout}ms`));
      }, timeout);

      // Подключение
      this.connect(client, config);
    });
  }

  /**
   * Выполнить несколько команд последовательно
   */
  async executeBatch(
    config: SSHConfig,
    commands: string[],
    options: SSHExecuteOptions = {}
  ): Promise<string[]> {
    const results: string[] = [];

    for (const command of commands) {
      const result = await this.execute(config, command, options);
      results.push(result);
    }

    return results;
  }

  /**
   * Загрузить файл с удаленного сервера
   */
  async downloadFile(
    config: SSHConfig,
    remotePath: string,
    localPath: string,
    options: SSHFileTransferOptions = {}
  ): Promise<void> {
    // TODO: Реализовать загрузку файла через SFTP
    throw new Error('downloadFile not implemented yet');
  }

  /**
   * Загрузить файл на удаленный сервер
   */
  async uploadFile(
    config: SSHConfig,
    localPath: string,
    remotePath: string,
    options: SSHFileTransferOptions = {}
  ): Promise<void> {
    // TODO: Реализовать загрузку файла через SFTP
    throw new Error('uploadFile not implemented yet');
  }

  /**
   * Проверить подключение к серверу
   */
  async testConnection(config: SSHConfig): Promise<boolean> {
    try {
      await this.execute(config, 'echo "test"', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Подключиться к серверу
   */
  private connect(client: Client, config: SSHConfig): void {
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
    };

    // Загрузка приватного ключа
    if (config.privateKeyPath) {
      try {
        const keyPath = this.resolveKeyPath(config.privateKeyPath);
        const privateKey = readFileSync(keyPath, 'utf8');
        connectConfig.privateKey = privateKey;
        
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase;
        }
      } catch (error: any) {
        logger.warn(`Failed to load SSH key from ${config.privateKeyPath}: ${error.message}`);
      }
    }

    // Пароль для аутентификации
    if (config.password) {
      connectConfig.password = config.password;
    }

    client.connect(connectConfig);
  }

  /**
   * Разрешить путь к SSH ключу (поддержка ~)
   */
  private resolveKeyPath(keyPath: string): string {
    if (keyPath.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return keyPath.replace('~', home);
    }
    return resolve(keyPath);
  }
}
