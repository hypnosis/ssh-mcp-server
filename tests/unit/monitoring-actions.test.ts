/**
 * ssh_monitor: действия и то, что каждое из них печатает.
 *
 * Соседний `monitoring-runner.test.ts` стережёт состояние транспорта. Здесь —
 * перечитывание профилей, список, неизвестное действие и адрес, по которому
 * инструмент отчитывается: порт по умолчанию в отчёт попадает числом, а не
 * пустым местом.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RunnerStats } from '../../src/runner/types.js';

const {
  statsMock,
  pingMock,
  closeMasterMock,
  getRunnerMock,
  resolveConfigMock,
  getAvailableProfilesMock,
  getDefaultProfileMock,
  getBrokenProfilesMock,
  reloadProfilesMock,
} = vi.hoisted(() => ({
  statsMock: vi.fn(),
  pingMock: vi.fn(),
  closeMasterMock: vi.fn(),
  getRunnerMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  getAvailableProfilesMock: vi.fn(),
  getDefaultProfileMock: vi.fn(),
  getBrokenProfilesMock: vi.fn(),
  reloadProfilesMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

vi.mock('../../src/runner/control-sockets.js', () => ({
  listControlSockets: async () => [],
  idleWindowSec: () => 600,
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: resolveConfigMock,
  getAvailableProfiles: getAvailableProfilesMock,
  getDefaultProfile: getDefaultProfileMock,
  getBrokenProfiles: getBrokenProfilesMock,
  reloadProfiles: reloadProfilesMock,
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

async function run(args: Record<string, unknown>) {
  return new MonitoringTool().handleCall({
    params: { name: 'ssh_monitor', arguments: args },
  } as CallToolRequest);
}

async function textOf(args: Record<string, unknown>): Promise<string> {
  return (await run(args)).content[0].text as string;
}

const BROKEN_STAGING = {
  name: 'staging',
  field: 'port',
  value: '70000',
  reason: 'port must be a number between 1 and 65535',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfigMock.mockReturnValue({ host: 'example.com', username: 'deploy', port: 2222 });
  statsMock.mockResolvedValue(stats());
  pingMock.mockResolvedValue({ ok: true, masterWasActive: true, latencyMs: 42 });
  closeMasterMock.mockResolvedValue('closed');
  getRunnerMock.mockResolvedValue({ stats: statsMock, ping: pingMock, closeMaster: closeMasterMock });
  getAvailableProfilesMock.mockReturnValue(['production', 'staging']);
  getDefaultProfileMock.mockReturnValue('production');
  getBrokenProfilesMock.mockReturnValue([]);
  reloadProfilesMock.mockReturnValue(undefined);
});

describe('ssh_monitor reload', () => {
  it('перечитывает файл профилей, а не отвечает по памяти', async () => {
    await run({ action: 'reload' });

    expect(reloadProfilesMock).toHaveBeenCalledTimes(1);
  });

  it('называет, сколько профилей стало и сколько было', async () => {
    getAvailableProfilesMock
      .mockReturnValueOnce(['production'])
      .mockReturnValue(['production', 'staging', 'lab']);

    const text = await textOf({ action: 'reload' });

    expect(text).toContain('Loaded 3 profiles (was 1)');
  });

  it('перечисляет профили и помечает тот, что по умолчанию', async () => {
    const text = await textOf({ action: 'reload' });

    expect(text).toContain('• production (default)');
    expect(text).toContain('• staging\n');
  });

  it('несостоявшееся перечитывание подаётся ошибкой, а не пустым списком', async () => {
    reloadProfilesMock.mockImplementation(() => {
      throw new Error('SSH profiles file not found: /etc/ssh-profiles.json');
    });

    const response = await run({ action: 'reload' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('/etc/ssh-profiles.json');
  });
});

describe('ssh_monitor: действие, которого нет', () => {
  it('названо ошибкой вместе с тем, что было запрошено', async () => {
    const response = await run({ action: 'restart' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown action: restart');
  });
});

describe('ssh_monitor list', () => {
  it('помечает профиль по умолчанию, а остальные оставляет как есть', async () => {
    const text = await textOf({ action: 'list' });

    expect(text).toContain('• production ⭐ (default)');
    expect(text).toContain('• staging\n');
  });

  it('итог называет число профилей', async () => {
    const text = await textOf({ action: 'list' });

    expect(text).toContain('Total: 2 profiles');
  });

  it('сломанные профили считаются в итоге отдельно', async () => {
    getAvailableProfilesMock.mockReturnValue(['production']);
    getBrokenProfilesMock.mockReturnValue([BROKEN_STAGING]);

    const text = await textOf({ action: 'list' });

    expect(text).toContain('Total: 1 profiles, 1 broken');
  });

  it('без сломанных итог о них молчит', async () => {
    const text = await textOf({ action: 'list' });

    expect(text).not.toContain('broken');
  });
});

describe('адрес сервера в отчётах', () => {
  it.each([
    ['stats', 'stats'],
    ['test', 'test'],
  ])('%s печатает порт профиля', async (_name, action) => {
    expect(await textOf({ action })).toContain('example.com:2222');
  });

  it.each([
    ['stats', 'stats'],
    ['test', 'test'],
  ])('%s печатает порт по умолчанию, когда в профиле его нет', async (_name, action) => {
    resolveConfigMock.mockReturnValue({ host: 'example.com', username: 'deploy' });

    expect(await textOf({ action })).toContain('example.com:22');
  });

  it('проверка связи называет пользователя, под которым входили', async () => {
    expect(await textOf({ action: 'test' })).toContain('Username: deploy');
  });
});
