/**
 * SSH Configuration Module
 * Управление SSH конфигурацией для удаленных серверов
 */
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
export declare function validateSSHConfig(config: Partial<SSHConfig>): string[];
//# sourceMappingURL=ssh-config.d.ts.map