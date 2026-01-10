/**
 * SSH Configuration Module
 * Управление SSH конфигурацией для удаленных серверов
 */

import { logger } from './logger.js';

/**
 * SSH конфигурация для подключения к удаленному серверу
 */
export interface SSHConfig {
  /** Адрес сервера (IP или доменное имя) */
  host: string;
  /** Порт SSH (по умолчанию 22) */
  port?: number;
  /** Имя пользователя для SSH подключения */
  username: string;
  /** Путь к приватному SSH ключу */
  privateKeyPath?: string;
  /** Пароль для зашифрованного SSH ключа */
  passphrase?: string;
  /** Пароль для аутентификации (не рекомендуется для production) */
  password?: string;
}


/**
 * Валидация SSH конфигурации
 */
export function validateSSHConfig(config: Partial<SSHConfig>): string[] {
  const errors: string[] = [];

  if (!config.host || typeof config.host !== 'string' || config.host.trim().length === 0) {
    errors.push('SSH host is required and must be a non-empty string');
  }

  if (!config.username || typeof config.username !== 'string' || config.username.trim().length === 0) {
    errors.push('SSH username is required and must be a non-empty string');
  }

  if (config.port !== undefined) {
    if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
      errors.push('SSH port must be a number between 1 and 65535');
    }
  }

  if (config.privateKeyPath !== undefined) {
    if (typeof config.privateKeyPath !== 'string' || config.privateKeyPath.trim().length === 0) {
      errors.push('SSH privateKeyPath must be a non-empty string');
    }
  }

  if (!config.privateKeyPath && !config.password) {
    logger.warn('SSH config: neither privateKeyPath nor password specified. Authentication may fail.');
  }

  return errors;
}
