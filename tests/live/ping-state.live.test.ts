/**
 * Проверка связи живьём: четыре состояния и то, чем они различаются.
 *
 * Раньше `ping` отвечал «да» или «нет», и роутер с вендорской оболочкой попадал
 * в «нет» вместе с недоступным сервером — рабочее соединение выглядело как
 * молчание. Юнит это не поймает: он спрашивает мок, а мок отвечает тем, что мы
 * сами в него положили. Отличить «вошли, но команды не те» от «не вошли вовсе»
 * можно только на живых серверах.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getOpenSshRunner, closeAllRunners } from '../../src/runner/openssh-runner.js';
import {
  LAB_CONTROL_DIR,
  LAB_REQUIRED,
  LAB_SERVERS,
  labConfig,
  labPasswordConfig,
  labVendorConfig,
  labUnavailableReason,
} from './lab.js';

process.env.SSH_MCP_CONTROL_DIR = LAB_CONTROL_DIR;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

const LIVE_TIMEOUT_MS = 60_000;

/** Порт, который никто не слушает: соединение не состоится вовсе */
const DEAD_PORT = 2239;

afterAll(async () => {
  await closeAllRunners();
});

describe.each(LAB_SERVERS)('состояния связи — $name', { timeout: LIVE_TIMEOUT_MS }, (server) => {
  it.skipIf(unavailable)('рабочий сервер отвечает ready', async () => {
    const result = await (await getOpenSshRunner(labConfig(server))).ping();

    expect(result.state).toBe('ready');
    expect(result.exitCode).toBeUndefined();
  });

  it.skipIf(unavailable)('недоступный порт — no-route, а не отказ доступа', async () => {
    const runner = await getOpenSshRunner({ ...labConfig(server), port: DEAD_PORT });

    const result = await runner.ping();

    expect(result.state).toBe('no-route');
  });

  it.skipIf(unavailable)('неверный пароль — rejected, а не потерянная сеть', async () => {
    const runner = await getOpenSshRunner(labPasswordConfig(server, 'not-the-password'));

    const result = await runner.ping();

    expect(result.state).toBe('rejected');
  });
});

/**
 * Вендорская оболочка живёт на одном контейнере: она задаётся пользователем, а не
 * набором утилит, и второй сервер повторил бы ту же проверку без нового смысла.
 */
describe('сервер с вендорской оболочкой', { timeout: LIVE_TIMEOUT_MS }, () => {
  it.skipIf(unavailable)('вход проходит, но состояние — limited', async () => {
    const result = await (await getOpenSshRunner(labVendorConfig(LAB_SERVERS[0]))).ping();

    expect(result.state).toBe('limited');
    // Код возврата и текст сервера — то, по чему читающий поймёт, что это за машина
    expect(result.exitCode).toBe(127);
    expect(result.detail).toContain('no such command');
  });
});
