/**
 * Выбор транспорта
 *
 * Единственная дверь к способу доставки команд. По умолчанию команды идут
 * системным клиентом ssh; прежний бэкенд ssh2 остаётся доступен переменной
 * окружения `SSH_MCP_BACKEND` до своего сноса. Оба дают одинаковый результат:
 * контракт проверяется одним набором тестов.
 */

import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { getOpenSshRunner } from './openssh-runner.js';
import { Ssh2Runner } from './ssh2-runner.js';
import type { CommandRunner } from './types.js';

export type RunnerBackend = 'openssh' | 'ssh2';

const DEFAULT_BACKEND: RunnerBackend = 'openssh';

/** О непонятном значении переменной предупреждаем один раз, а не на каждую команду */
let unknownBackendReported = false;

/**
 * Какой транспорт просили в окружении
 */
export function resolveBackend(raw = process.env.SSH_MCP_BACKEND): RunnerBackend {
  const value = raw?.trim().toLowerCase();

  if (!value) return DEFAULT_BACKEND;
  if (value === 'openssh' || value === 'ssh2') return value;

  if (!unknownBackendReported) {
    unknownBackendReported = true;
    logger.warn(
      `[Runner] Unknown SSH_MCP_BACKEND "${raw}", falling back to "${DEFAULT_BACKEND}". ` +
      `Supported values: openssh, ssh2`
    );
  }

  return DEFAULT_BACKEND;
}

/**
 * Транспорты на ssh2 живут по имени профиля: состояние (соединение, счётчики)
 * привязано к записи в пуле, а она заведена именно под этим именем.
 */
const ssh2Runners = new Map<string, Ssh2Runner>();

/**
 * Получить транспорт для профиля
 */
export async function getRunner(config: SSHConfig, profileName: string): Promise<CommandRunner> {
  if (resolveBackend() === 'openssh') {
    return getOpenSshRunner(config);
  }

  const existing = ssh2Runners.get(profileName);
  if (existing) return existing;

  const runner = new Ssh2Runner(config, profileName);
  ssh2Runners.set(profileName, runner);
  return runner;
}

/** Забыть созданные транспорты, не трогая соединения (используется в тестах) */
export function resetRunnerRegistry(): void {
  ssh2Runners.clear();
  unknownBackendReported = false;
}
