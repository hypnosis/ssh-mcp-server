/**
 * Обнаружение системного ssh спрашивается один раз на волну
 *
 * Между проверкой кэша и записью в него стоит запуск `ssh -V`. Если кэшировать
 * результат, а не сам вызов, десять параллельных команд успевают проскочить
 * проверку до записи — и каждая заводит своё обнаружение и свой транспорт.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

const { detectRuntime, resetRuntimeCache } = await import('../../src/runner/runtime-check.js');

beforeEach(() => {
  execFileMock.mockReset();
  // Ответ приходит не в том же тике: так параллельные вызовы успевают
  // столкнуться, как они сталкиваются на живом сервере
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    setTimeout(() => callback(null, '', 'OpenSSH_10.2p1, LibreSSL 3.3.6'), 1);
  });
  resetRuntimeCache();
});

describe('detectRuntime', () => {
  it('запускает `ssh -V` один раз на десять одновременных вызовов', async () => {
    await Promise.all(Array.from({ length: 10 }, () => detectRuntime()));

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('всем одновременным вызовам отдаёт одно и то же обнаружение', async () => {
    const [first, ...rest] = await Promise.all(Array.from({ length: 10 }, () => detectRuntime()));

    for (const runtime of rest) {
      expect(runtime).toBe(first);
    }
  });

  it('после сброса кэша спрашивает систему заново', async () => {
    await detectRuntime();
    resetRuntimeCache();
    await detectRuntime();

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('по force спрашивает систему заново, не дожидаясь сброса', async () => {
    await detectRuntime();
    await detectRuntime({ force: true });

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
