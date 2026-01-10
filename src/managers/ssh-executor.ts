/**
 * SSH Executor
 * Простое выполнение SSH команд без пула соединений
 */

import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { retryWithTimeout, createSSHRetryPredicate } from '../utils/retry.js';
import type { SSHConfig } from '../utils/ssh-config.js';

export interface SSHExecuteOptions {
  /** Таймаут выполнения команды (мс) */
  timeout?: number;
  /** Кодировка вывода */
  encoding?: BufferEncoding;
  /** Рабочая директория */
  cwd?: string;
  /** Использовать sudo */
  sudo?: boolean;
}

export interface SSHExecuteResult {
  /** Вывод команды (stdout) */
  stdout: string;
  /** Ошибки (stderr) */
  stderr: string;
  /** Код выхода */
  exitCode: number;
}

/**
 * SSH Executor для выполнения команд
 * Каждый вызов создает новое SSH подключение
 */
export class SSHExecutor {
  /**
   * Выполнить команду на удаленном сервере
   * @param config - SSH конфигурация
   * @param command - Команда для выполнения
   * @param options - Опции выполнения
   * @returns Результат выполнения
   */
  async execute(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<SSHExecuteResult> {
    const timeout = options.timeout || 30000;
    
    // Добавляем sudo если нужно
    let finalCommand = command;
    if (options.sudo) {
      finalCommand = `sudo ${command}`;
    }
    
    // Добавляем cd если указана рабочая директория
    if (options.cwd) {
      finalCommand = `cd ${this.escapeShell(options.cwd)} && ${finalCommand}`;
    }
    
    logger.debug(`Executing SSH command: ${finalCommand.substring(0, 100)}...`);
    
    // Выполняем с retry логикой
    const executeFn = async () => {
      return this.executeInternal(config, finalCommand, options);
    };
    
    return retryWithTimeout(executeFn, {
      maxAttempts: 3,
      timeout,
      shouldRetry: createSSHRetryPredicate(),
    });
  }
  
  /**
   * Внутреннее выполнение команды (без retry)
   */
  private executeInternal(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions
  ): Promise<SSHExecuteResult> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const encoding = options.encoding || 'utf8';
      
      client.on('ready', () => {
        logger.debug(`SSH connected to ${config.host}`);
        
        client.exec(command, (err, stream) => {
          if (err) {
            client.end();
            reject(new Error(`Failed to execute command: ${err.message}`));
            return;
          }
          
          let stdout = '';
          let stderr = '';
          
          stream.on('close', (code: number) => {
            client.end();
            
            logger.debug(`SSH command finished with code ${code}`);
            resolve({
              stdout,
              stderr,
              exitCode: code || 0,
            });
          });
          
          stream.on('data', (data: Buffer) => {
            stdout += data.toString(encoding);
          });
          
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString(encoding);
          });
        });
      });
      
      client.on('error', (err) => {
        reject(new Error(`SSH connection error: ${err.message}`));
      });
      
      // Подключение
      this.connect(client, config);
    });
  }
  
  /**
   * Подключиться к серверу
   */
  private connect(client: Client, config: SSHConfig): void {
    const connectConfig: any = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 30000,
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
        
        logger.debug(`Using SSH key: ${keyPath}`);
      } catch (error: any) {
        logger.warn(`Failed to load SSH key from ${config.privateKeyPath}: ${error.message}`);
      }
    }
    
    // Пароль для аутентификации
    if (config.password) {
      connectConfig.password = config.password;
      logger.debug('Using password authentication');
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
  
  /**
   * Экранировать строку для shell
   */
  private escapeShell(str: string): string {
    return `'${str.replace(/'/g, "'\"'\"'")}'`;
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
}
