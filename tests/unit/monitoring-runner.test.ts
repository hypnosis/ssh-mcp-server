/**
 * Unit tests: ssh_monitor рассказывает про транспорт, а не про пул
 *
 * Метрики пула соединений имеют смысл только на бэкенде ssh2 — на openssh
 * пула нет вовсе, и раздел «Active Connections» показывал бы пустоту при
 * живом master-соединении. Теперь состояние спрашивается у транспорта.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RunnerStats } from '../../src/runner/types.js';

const { statsMock, pingMock, getRunnerMock } = vi.hoisted(() => ({
  statsMock: vi.fn(),
  pingMock: vi.fn(),
  getRunnerMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 2222 }),
  getAvailableProfiles: () => ['production', 'staging'],
  getDefaultProfile: () => 'production',
  reloadProfiles: () => undefined,
}));

const { MonitoringTool } = await import('../../src/tools/monitoring-tool.js');

function stats(overrides: Partial<RunnerStats> = {}): RunnerStats {
  return {
    backend: 'openssh',
    multiplexing: true,
    masterActive: true,
    commandsThisSession: 12,
    transfersThisSession: 3,
    ...overrides,
  };
}

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_monitor', arguments: args } } as CallToolRequest;
}

async function run(args: Record<string, unknown>) {
  return new MonitoringTool().handleCall(call(args));
}

beforeEach(() => {
  vi.clearAllMocks();
  statsMock.mockResolvedValue(stats());
  pingMock.mockResolvedValue({ ok: true, masterWasActive: true, latencyMs: 42 });
  getRunnerMock.mockResolvedValue({ stats: statsMock, ping: pingMock });
});

describe('ssh_monitor stats', () => {
  it('называет бэкенд и состояние общего соединения', async () => {
    statsMock.mockResolvedValue(
      stats({ sshVersion: 'OpenSSH_9.6p1', masterPid: 4242, controlPath: '/tmp/cm-prod' })
    );

    const text = (await run({ action: 'stats' })).content[0].text as string;

    expect(text).toContain('openssh');
    expect(text).toContain('OpenSSH_9.6p1');
    expect(text).toContain('4242');
    expect(text).toContain('/tmp/cm-prod');
  });

  it('объясняет, почему мультиплексирования нет', async () => {
    statsMock.mockResolvedValue(
      stats({
        backend: 'ssh2',
        multiplexing: false,
        multiplexingDisabledReason: 'connections are pooled inside this process',
        masterActive: false,
      })
    );

    const text = (await run({ action: 'stats' })).content[0].text as string;

    expect(text).toContain('pooled inside this process');
  });

  it('показывает счётчики команд и передач', async () => {
    const text = (await run({ action: 'stats' })).content[0].text as string;

    expect(text).toContain('12');
    expect(text).toContain('3');
  });

  it('последняя ошибка транспорта видна, если она была', async () => {
    statsMock.mockResolvedValue(stats({ lastError: 'connect ECONNREFUSED' }));

    const text = (await run({ action: 'stats' })).content[0].text as string;

    expect(text).toContain('ECONNREFUSED');
  });

  it('спрашивает транспорт запрошенного профиля', async () => {
    await run({ action: 'stats', profile: 'staging' });

    expect(getRunnerMock).toHaveBeenCalledWith(expect.anything(), 'staging');
  });
});

describe('ssh_monitor test', () => {
  it('проверяет связь через ping и показывает задержку', async () => {
    const text = (await run({ action: 'test', profile: 'production' })).content[0].text as string;

    expect(pingMock).toHaveBeenCalled();
    expect(text).toContain('42ms');
    expect(text).toContain('example.com:2222');
  });

  it('переиспользованное соединение отмечается отдельно', async () => {
    pingMock.mockResolvedValue({ ok: true, masterWasActive: false, latencyMs: 380 });

    const text = (await run({ action: 'test' })).content[0].text as string;

    expect(text.toLowerCase()).toContain('new connection');
  });

  it('недоступный сервер — это ошибка, а не «✅»', async () => {
    pingMock.mockResolvedValue({ ok: false, masterWasActive: false, latencyMs: 5000 });

    const response = await run({ action: 'test' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text as string).not.toContain('✅');
  });

  it('сбой транспорта тоже подаётся как неудачная проверка', async () => {
    pingMock.mockRejectedValue(new Error('Authentication failed'));

    const response = await run({ action: 'test' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text as string).toContain('Authentication failed');
  });
});
