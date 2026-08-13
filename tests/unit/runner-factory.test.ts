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

const RUNTIME = {
  available: true,
  version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
  multiplexing: true,
  askpassForce: true,
  controlDir: '/home/user/.ssh/ssh-mcp',
};

let detectCallCount = 0;

beforeEach(() => {
  detectCallCount = 0;
  // Обнаружение отвечает не в том же тике и вразнобой: на живой машине каждый
  // вызов запускает свой `ssh -V`, и они заканчиваются в произвольном порядке.
  // Именно на этом ожидании вызовы расходятся между проверкой кэша и записью.
  detectRuntimeMock.mockImplementation(() => {
    const delayMs = 10 - (detectCallCount++ % 10);
    return new Promise((resolve) => setTimeout(() => resolve({ ...RUNTIME }), delayMs));
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

  it('одному назначению даёт один транспорт и на волне одновременных вызовов', async () => {
    const runners = await Promise.all(Array.from({ length: 10 }, () => getRunner(CONFIG)));

    for (const runner of runners) {
      expect(runner).toBe(runners[0]);
    }
  });

  it('разным серверам даёт разные транспорты', async () => {
    const production = await getRunner(CONFIG);
    const staging = await getRunner({ ...CONFIG, host: 'staging.example.com' });
    expect(staging).not.toBe(production);
  });
});
