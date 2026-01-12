/**
 * SSH Manager
 * Управление SSH соединениями и выполнением команд на удаленных серверах
 * v2.0.0 - Использует ConnectionPool для переиспользования соединений
 */
import { logger } from '../utils/logger.js';
import { ConnectionPool } from './connection-pool.js';
/**
 * SSH Manager для выполнения команд и работы с файлами
 * v2.0.0 - Использует ConnectionPool для переиспользования соединений
 */
export class SSHManager {
    /**
     * Выполнить команду на удаленном сервере
     * @param config - SSH конфигурация
     * @param command - Команда для выполнения
     * @param options - Опции выполнения
     * @returns Вывод команды (stdout)
     */
    async execute(config, command, options = {}) {
        const pool = ConnectionPool.getInstance();
        const profileName = options.profileName || 'default';
        const timeout = options.timeout || 30000;
        // Get client from pool
        const client = await pool.getClient(profileName, config);
        try {
            const result = await this.executeOnClient(client, command, options);
            return result;
        }
        finally {
            // Release client back to pool
            pool.releaseClient(profileName);
        }
    }
    /**
     * Выполнить несколько команд последовательно
     * v2.0.0 - Использует одно соединение для всех команд
     */
    async executeBatch(config, commands, options = {}) {
        const pool = ConnectionPool.getInstance();
        const profileName = options.profileName || 'default';
        // Get client from pool ONCE for all commands
        const client = await pool.getClient(profileName, config);
        const results = [];
        try {
            // Execute all commands on the same client
            for (const command of commands) {
                const result = await this.executeOnClient(client, command, options);
                results.push(result);
            }
            return results;
        }
        finally {
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
    executeOnClient(client, command, options = {}) {
        return new Promise((resolve, reject) => {
            const timeout = options.timeout || 30000;
            let timeoutId;
            let settled = false;
            // Helper to resolve once
            const resolveOnce = (value) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    resolve(value);
                }
            };
            // Helper to reject once
            const rejectOnce = (error) => {
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
                stream.on('close', (code) => {
                    if (code !== 0) {
                        rejectOnce(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
                    }
                    else {
                        resolveOnce(stdout);
                    }
                });
                stream.on('data', (data) => {
                    stdout += data.toString(options.encoding || 'utf8');
                });
                stream.stderr.on('data', (data) => {
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
     * Загрузить файл с удаленного сервера
     */
    async downloadFile(config, remotePath, localPath, options = {}) {
        // TODO: Реализовать загрузку файла через SFTP
        throw new Error('downloadFile not implemented yet');
    }
    /**
     * Загрузить файл на удаленный сервер
     */
    async uploadFile(config, localPath, remotePath, options = {}) {
        // TODO: Реализовать загрузку файла через SFTP
        throw new Error('uploadFile not implemented yet');
    }
    /**
     * Проверить подключение к серверу
     */
    async testConnection(config, profileName) {
        try {
            await this.execute(config, 'echo "test"', { timeout: 5000, profileName });
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=ssh-manager.js.map