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
  getBrokenProfilesMock,
  reloadProfilesMock,
} = vi.hoisted(() => ({
  statsMock: vi.fn(),
  pingMock: vi.fn(),
  closeMasterMock: vi.fn(),
  getRunnerMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  getAvailableProfilesMock: vi.fn(),
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
  pingMock.mockResolvedValue({ state: 'ready', masterWasActive: true, latencyMs: 42 });
  closeMasterMock.mockResolvedValue('closed');
  getRunnerMock.mockResolvedValue({ stats: statsMock, ping: pingMock, closeMaster: closeMasterMock });
  getAvailableProfilesMock.mockReturnValue(['production', 'staging']);
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

  it('перечисляет профили, никого не выделяя', async () => {
    const text = await textOf({ action: 'reload' });

    expect(text).toContain('• production\n');
    expect(text).toContain('• staging\n');
    expect(text).not.toMatch(/default/i);
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
  it('перечисляет профили, никого не выделяя', async () => {
    const text = await textOf({ action: 'list' });

    expect(text).toContain('• production\n');
    expect(text).toContain('• staging\n');
    expect(text).not.toMatch(/default/i);
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

describe('действие без имени профиля не выбирает сервер само', () => {
  it.each(['stats', 'test', 'close'])('%s отказывает и называет, из чего выбирать', async (action) => {
    const response = await run({ action });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('production, staging');
    expect(getRunnerMock).not.toHaveBeenCalled();
  });

  it.each(['stats', 'test', 'close'])('%s не может прочитать профили — отказ называет причину', async (action) => {
    getAvailableProfilesMock.mockImplementation(() => {
      throw new Error('SSH profiles file not found: /etc/ssh-profiles.json');
    });

    const response = await run({ action });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('/etc/ssh-profiles.json');
  });
});

describe('адрес сервера в отчётах', () => {
  it.each([
    ['stats', 'stats'],
    ['test', 'test'],
  ])('%s печатает порт профиля', async (_name, action) => {
    expect(await textOf({ action, profile: 'production' })).toContain('example.com:2222');
  });

  it.each([
    ['stats', 'stats'],
    ['test', 'test'],
  ])('%s печатает порт по умолчанию, когда в профиле его нет', async (_name, action) => {
    resolveConfigMock.mockReturnValue({ host: 'example.com', username: 'deploy' });

    expect(await textOf({ action, profile: 'production' })).toContain('example.com:22');
  });

  it('проверка связи называет пользователя, под которым входили', async () => {
    expect(await textOf({ action: 'test', profile: 'production' })).toContain('Username: deploy');
  });
});

describe('ssh_monitor test называет состояние первым словом', () => {
  const PING = {
    ready: { state: 'ready', masterWasActive: true, latencyMs: 42 },
    limited: {
      state: 'limited',
      masterWasActive: true,
      latencyMs: 114,
      exitCode: 127,
      detail: 'Command::Base error[7405600]: no such command: true.',
    },
    'no-route': {
      state: 'no-route',
      masterWasActive: false,
      latencyMs: 1316,
      detail: 'Cannot reach example.com:2222. Connection refused',
    },
    rejected: {
      state: 'rejected',
      masterWasActive: false,
      latencyMs: 900,
      detail: 'Authentication failed for example.com:2222',
    },
  } as const;

  it.each([
    ['ready', '✅ ready'],
    ['limited', '⚠️ limited'],
    ['no-route', '❌ no-route'],
    ['rejected', '❌ rejected'],
  ] as const)('%s стоит в первой строке', async (state, headline) => {
    pingMock.mockResolvedValue(PING[state]);

    const text = await textOf({ action: 'test', profile: 'production' });

    expect(text.split('\n')[0]).toContain(headline);
  });

  it('рабочее соединение с чужой оболочкой не названо молчанием', async () => {
    pingMock.mockResolvedValue(PING.limited);

    const text = await textOf({ action: 'test', profile: 'production' });

    expect(text).not.toContain('not reached');
    expect(text).toContain('exit code 127');
    expect(text).toContain('no such command: true');
    // Совет объясняет, чем такой сервер отличается: оболочка не POSIX,
    // файловые инструменты не годятся, а ssh_exec с командами вендора — годится
    expect(text).toContain('not POSIX');
    expect(text).toContain('ssh_exec');
    // Инструменты названы поимённо: «инструменты аудита» ничего не говорят
    // тому, кто выбирает, чем сейчас пользоваться
    for (const tool of [
      'ssh_snapshot',
      'ssh_audit_baseline',
      'ssh_tls_check',
      'ssh_disk_breakdown',
      'ssh_service_status',
    ]) {
      expect(text, `совет не называет ${tool}`).toContain(tool);
    }
  });

  it.each([
    ['no-route', true],
    ['rejected', true],
    ['limited', false],
    ['ready', false],
  ] as const)('%s помечается ошибкой вызова: %s', async (state, expected) => {
    pingMock.mockResolvedValue(PING[state]);

    expect((await run({ action: 'test', profile: 'production' })).isError ?? false).toBe(expected);
  });

  it('отказ доступа не отправляет чинить сеть', async () => {
    pingMock.mockResolvedValue(PING.rejected);

    const text = await textOf({ action: 'test', profile: 'production' });

    expect(text).toContain('the network is fine');
  });

  it('недостижимый сервер не отправляет чинить доступ', async () => {
    pingMock.mockResolvedValue(PING['no-route']);

    const text = await textOf({ action: 'test', profile: 'production' });

    expect(text).toContain('credentials are not the problem');
  });

  it('исправному соединению советов не даётся', async () => {
    pingMock.mockResolvedValue(PING.ready);

    const text = await textOf({ action: 'test', profile: 'production' });

    // Отчёт заканчивается строкой о соединении: пустой совет не печатается вовсе
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/connection$/);
    expect(text).not.toContain('Check the');
  });
});
