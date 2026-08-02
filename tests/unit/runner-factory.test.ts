/**
 * Unit tests for the runner factory
 *
 * Фабрика решает единственный вопрос: каким транспортом пойдёт команда.
 * Пока идёт переход, ответ по умолчанию — прежний ssh2.
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
  it('без переменной окружения остаётся на прежнем транспорте', () => {
    expect(resolveBackend(undefined)).toBe('ssh2');
  });

  it('распознаёт оба значения независимо от регистра и пробелов', () => {
    expect(resolveBackend(' openssh ')).toBe('openssh');
    expect(resolveBackend('SSH2')).toBe('ssh2');
  });

  it('на непонятное значение не падает, а возвращается к прежнему транспорту', () => {
    expect(resolveBackend('libssh')).toBe('ssh2');
  });
});

describe('getRunner', () => {
  it('по умолчанию отдаёт транспорт на ssh2', async () => {
    const runner = await getRunner(CONFIG, 'production');
    expect((await runner.stats()).backend).toBe('ssh2');
  });

  it('отдаёт транспорт на системном ssh по SSH_MCP_BACKEND=openssh', async () => {
    process.env.SSH_MCP_BACKEND = 'openssh';
    const runner = await getRunner(CONFIG, 'production');
    expect((await runner.stats()).backend).toBe('openssh');
  });

  it('переиспользует транспорт профиля, чтобы не терять счётчики', async () => {
    const first = await getRunner(CONFIG, 'production');
    const second = await getRunner(CONFIG, 'production');
    expect(second).toBe(first);
  });

  it('разным профилям даёт разные транспорты', async () => {
    const production = await getRunner(CONFIG, 'production');
    const staging = await getRunner({ ...CONFIG, host: 'staging.example.com' }, 'staging');
    expect(staging).not.toBe(production);
  });

  it('после смены бэкенда отдаёт транспорт нового бэкенда', async () => {
    const before = await getRunner(CONFIG, 'production');
    process.env.SSH_MCP_BACKEND = 'openssh';
    const after = await getRunner(CONFIG, 'production');

    expect(after).not.toBe(before);
    expect((await after.stats()).backend).toBe('openssh');
  });
});
