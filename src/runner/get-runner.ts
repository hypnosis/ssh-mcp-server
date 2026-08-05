/**
 * Дверь к транспорту
 *
 * Единственное место, где инструменты берут соединение. Выбора внутри нет:
 * команды идут системным клиентом ssh. Дверь остаётся ради поддержки старых
 * серверов — развилка встанет сюда одним слоем, а не ветвлением в каждом
 * инструменте.
 */

import type { SSHConfig } from '../utils/ssh-config.js';
import { getOpenSshRunner } from './openssh-runner.js';
import type { CommandRunner } from './types.js';

/**
 * Получить транспорт для соединения
 */
export async function getRunner(config: SSHConfig): Promise<CommandRunner> {
  return getOpenSshRunner(config);
}
