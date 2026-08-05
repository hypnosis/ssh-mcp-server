/**
 * Unit tests for the runner factory
 *
 * Дверь к транспорту не выбирает: она отдаёт транспорт на системном ssh и
 * держит одно соединение на назначение.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { detectRuntimeMock } = vi.hoisted(() => ({ detectRuntimeMock: vi.fn() }));
vi.mock('../../src/runner/runtime-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/runtime-check.js')>();
  return { ...actual, detectRuntime: detectRuntimeMock };
});

const { getRunner } = await import('../../src/runner/get-runner.js');
const { resetRunnerCache } = await import('../../src/runner/openssh-runner.js');

const CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

beforeEach(() => {
  detectRuntimeMock.mockResolvedValue({
    available: true,
    version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
    multiplexing: true,
    askpassForce: true,
    controlDir: '/home/user/.ssh/ssh-mcp',
  });
  resetRunnerCache();
});

describe('getRunner', () => {
  it('отдаёт транспорт на системном ssh', async () => {
    const runner = await getRunner(CONFIG);
    expect((await runner.stats()).backend).toBe('openssh');
  });

  it('одному назначению даёт один транспорт', async () => {
    const first = await getRunner(CONFIG);
    const second = await getRunner(CONFIG);
    expect(second).toBe(first);
  });

  it('разным серверам даёт разные транспорты', async () => {
    const production = await getRunner(CONFIG);
    const staging = await getRunner({ ...CONFIG, host: 'staging.example.com' });
    expect(staging).not.toBe(production);
  });
});
