/**
 * SSH Configuration Module
 * Управление SSH конфигурацией для удаленных серверов
 */

import type { PathSecurityConfig } from './path-validator.js';

/**
 * Политика проверки ключа хоста.
 * `accept-new` — запомнить ключ при первом подключении, но заметить подмену.
 */
export type StrictHostKeyChecking = 'yes' | 'accept-new' | 'no';

export const STRICT_HOST_KEY_CHECKING_VALUES: StrictHostKeyChecking[] = ['yes', 'accept-new', 'no'];

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
  /** Политика проверки ключа хоста (по умолчанию accept-new; только бэкенд openssh) */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Игнорировать пользовательский ~/.ssh/config (только бэкенд openssh) */
  ignoreUserConfig?: boolean;
  /**
   * Ограничения на пути: белый и чёрный списки каталогов.
   *
   * Поле задаётся в профиле и обязано доехать сюда: инструменты берут правила
   * только отсюда. Пока его здесь не было, `pathSecurity` из файла профилей
   * молча терялся при сборке конфига — README обещал защиту, а валидатор ни
   * разу не создавался (замерено на живых серверах: запись в запрещённый
   * каталог проходила).
   */
  pathSecurity?: PathSecurityConfig;
}
