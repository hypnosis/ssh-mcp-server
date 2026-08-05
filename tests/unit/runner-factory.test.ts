/**
 * Unit tests for the runner factory
 *
 * Фабрика решает единственный вопрос: каким транспортом пойдёт команда.
 * По умолчанию — системный ssh, прежний ssh2 остаётся по явному запросу.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { detectRuntimeMock } = vi.hoisted(() => ({ detectRuntimeMock: vi.fn() }));
vi.mock('../../src/runner/runtime-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/runtime-check.js')>();
  return { ...actual, detectRuntime: detectRuntimeMock };
});

const { poolMock } = vi.hoisted(() => ({
  poolMock: { isConnected: vi.fn(() => false) },
}));
vi.mock('../../src/managers/connection-pool.js', () => ({
  ConnectionPool: { getInstance: () => poolMock },
}));

const { getRunner, resolveBackend, resetRunnerRegistry } = await import(
  '../../src/runner/get-runner.js'
);
const { resetRunnerCache } = await import('../../src/runner/openssh-runner.js');
const { logger } = await import('../../src/utils/logger.js');

const CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

const originalBackend = process.env.SSH_MCP_BACKEND;

beforeEach(() => {
  delete process.env.SSH_MCP_BACKEND;
  detectRuntimeMock.mockResolvedValue({
    available: true,
    version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
    multiplexing: true,
    askpassForce: true,
    controlDir: '/home/user/.ssh/ssh-mcp',
  });
  resetRunnerRegistry();
  resetRunnerCache();
});

afterEach(() => {
  if (originalBackend === undefined) delete process.env.SSH_MCP_BACKEND;
  else process.env.SSH_MCP_BACKEND = originalBackend;
});

describe('resolveBackend', () => {
  it('без переменной окружения выбирает системный ssh', () => {
    expect(resolveBackend(undefined)).toBe('openssh');
  });

  it('распознаёт оба значения независимо от регистра и пробелов', () => {
    expect(resolveBackend(' openssh ')).toBe('openssh');
    expect(resolveBackend('SSH2')).toBe('ssh2');
  });

  it('на непонятное значение не падает, а выбирает транспорт по умолчанию', () => {
    expect(resolveBackend('libssh')).toBe('openssh');
  });
});

// Ответ «openssh» приходит двумя разными путями: значение узнали или не поняли
// и взяли запасное. Различает их только предупреждение
describe('resolveBackend: узнанное значение и откат к запасному', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('молчит, когда переменной нет', () => {
    expect(resolveBackend(undefined)).toBe('openssh');
    expect(warn).not.toHaveBeenCalled();
  });

  it('молчит на каждом узнанном значении', () => {
    expect(resolveBackend('openssh')).toBe('openssh');
    expect(resolveBackend('ssh2')).toBe('ssh2');
    expect(warn).not.toHaveBeenCalled();
  });

  it('на непонятном значении называет и его, и запасной транспорт', () => {
    resolveBackend('libssh');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('libssh');
    expect(message).toContain('falling back to "openssh"');
    expect(message).toContain('openssh, ssh2');
  });

  it('повторяет предупреждение один раз, а не на каждую команду', () => {
    resolveBackend('libssh');
    resolveBackend('libssh');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getRunner', () => {
  it('по умолчанию отдаёт транспорт на системном ssh', async () => {
    const runner = await getRunner(CONFIG, 'production');
    expect((await runner.stats()).backend).toBe('openssh');
  });

  it('отдаёт прежний транспорт по SSH_MCP_BACKEND=ssh2', async () => {
    process.env.SSH_MCP_BACKEND = 'ssh2';
    const runner = await getRunner(CONFIG, 'production');
    expect((await runner.stats()).backend).toBe('ssh2');
  });

  it('переиспользует транспорт профиля, чтобы не терять счётчики', async () => {
    process.env.SSH_MCP_BACKEND = 'ssh2';
    const first = await getRunner(CONFIG, 'production');
    const second = await getRunner(CONFIG, 'production');
    expect(second).toBe(first);
  });

  it('разным профилям даёт разные транспорты', async () => {
    process.env.SSH_MCP_BACKEND = 'ssh2';
    const production = await getRunner(CONFIG, 'production');
    const staging = await getRunner({ ...CONFIG, host: 'staging.example.com' }, 'staging');
    expect(staging).not.toBe(production);
  });

  it('после смены бэкенда отдаёт транспорт нового бэкенда', async () => {
    const before = await getRunner(CONFIG, 'production');
    process.env.SSH_MCP_BACKEND = 'ssh2';
    const after = await getRunner(CONFIG, 'production');

    expect(after).not.toBe(before);
    expect((await after.stats()).backend).toBe('ssh2');
  });
});
