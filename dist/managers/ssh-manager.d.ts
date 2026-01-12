/**
 * SSH Manager
 * Управление SSH соединениями и выполнением команд на удаленных серверах
 * v2.0.0 - Использует ConnectionPool для переиспользования соединений
 */
import type { SSHConfig } from '../utils/ssh-config.js';
export interface SSHExecuteOptions {
    /** Таймаут выполнения команды (мс) */
    timeout?: number;
    /** Кодировка вывода */
    encoding?: BufferEncoding;
    /** Имя профиля для пула соединений */
    profileName?: string;
}
export interface SSHFileTransferOptions {
    /** Права доступа для файла */
    mode?: number;
}
/**
 * SSH Manager для выполнения команд и работы с файлами
 * v2.0.0 - Использует ConnectionPool для переиспользования соединений
 */
export declare class SSHManager {
    /**
     * Выполнить команду на удаленном сервере
     * @param config - SSH конфигурация
     * @param command - Команда для выполнения
     * @param options - Опции выполнения
     * @returns Вывод команды (stdout)
     */
    execute(config: SSHConfig, command: string, options?: SSHExecuteOptions): Promise<string>;
    /**
     * Выполнить несколько команд последовательно
     * v2.0.0 - Использует одно соединение для всех команд
     */
    executeBatch(config: SSHConfig, commands: string[], options?: SSHExecuteOptions): Promise<string[]>;
    /**
     * Выполнить команду на конкретном клиенте
     * @param client - SSH2 клиент
     * @param command - Команда для выполнения
     * @param options - Опции выполнения
     * @returns Вывод команды (stdout)
     */
    private executeOnClient;
    /**
     * Загрузить файл с удаленного сервера
     */
    downloadFile(config: SSHConfig, remotePath: string, localPath: string, options?: SSHFileTransferOptions): Promise<void>;
    /**
     * Загрузить файл на удаленный сервер
     */
    uploadFile(config: SSHConfig, localPath: string, remotePath: string, options?: SSHFileTransferOptions): Promise<void>;
    /**
     * Проверить подключение к серверу
     */
    testConnection(config: SSHConfig, profileName?: string): Promise<boolean>;
}
//# sourceMappingURL=ssh-manager.d.ts.map