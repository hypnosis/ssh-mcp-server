/**
 * Unit tests: ssh_monitor рассказывает про транспорт, а не про пул
 *
 * Пула нет: соединение держит сам ssh, и раздел «Active Connections»
 * показывал бы пустоту при живом master. Состояние спрашивается у транспорта.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RunnerStats } from '../../src/runner/types.js';

const {
  statsMock,
  pingMock,
  closeMasterMock,
  getRunnerMock,
  listSocketsMock,
  resolveConfigMock,
  getAvailableProfilesMock,
  getBrokenProfilesMock,
} = vi.hoisted(() => ({
  statsMock: vi.fn(),
  pingMock: vi.fn(),
  closeMasterMock: vi.fn(),
  getRunnerMock: vi.fn(),
  listSocketsMock: vi.fn(),
  resolveConfigMock: vi.fn(() => ({ host: 'example.com', username: 'deploy', port: 2222 })),
  getAvailableProfilesMock: vi.fn(() => ['production', 'staging']),
  getBrokenProfilesMock: vi.fn(() => []),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

vi.mock('../../src/runner/control-sockets.js', () => ({
  listControlSockets: listSocketsMock,
  idleWindowSec: () => 600,
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: resolveConfigMock,
  getAvailableProfiles: getAvailableProfilesMock,
  getBrokenProfiles: getBrokenProfilesMock,
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
  resolveConfigMock.mockReturnValue({ host: 'example.com', username: 'deploy', port: 2222 });
  statsMock.mockResolvedValue(stats());
  pingMock.mockResolvedValue({ state: 'ready', masterWasActive: true, latencyMs: 42 });
  closeMasterMock.mockResolvedValue('closed');
  listSocketsMock.mockResolvedValue([]);
  getRunnerMock.mockResolvedValue({ stats: statsMock, ping: pingMock, closeMaster: closeMasterMock });
  getAvailableProfilesMock.mockReturnValue(['production', 'staging']);
  getBrokenProfilesMock.mockReturnValue([]);
});

function broken(overrides: Partial<{ name: string; field: string; value: string; reason: string }> = {}) {
  return { name: 'staging', field: 'port', value: '70000', reason: 'port must be a number between 1 and 65535', ...overrides };
}

describe('ssh_monitor stats', () => {
  it('называет бэкенд и состояние общего соединения', async () => {
    statsMock.mockResolvedValue(
      stats({ sshVersion: 'OpenSSH_9.6p1', masterPid: 4242, controlPath: '/tmp/cm-prod' })
    );

    const text = (await run({ action: 'stats', profile: 'production' })).content[0].text as string;

    expect(text).toContain('openssh');
    expect(text).toContain('OpenSSH_9.6p1');
    expect(text).toContain('4242');
    expect(text).toContain('/tmp/cm-prod');
  });

  it('объясняет, почему мультиплексирования нет', async () => {
    statsMock.mockResolvedValue(
      stats({
        multiplexing: false,
        multiplexingDisabledReason: 'ControlPersist requires OpenSSH 5.6+, found OpenSSH_5.3',
        masterActive: false,
      })
    );

    const text = (await run({ action: 'stats', profile: 'production' })).content[0].text as string;

    expect(text).toContain('ControlPersist requires OpenSSH 5.6+');
  });

  it('показывает счётчики команд и передач', async () => {
    const text = (await run({ action: 'stats', profile: 'production' })).content[0].text as string;

    expect(text).toContain('12');
    expect(text).toContain('3');
  });

  it('последняя ошибка транспорта видна, если она была', async () => {
    statsMock.mockResolvedValue(stats({ lastError: 'connect ECONNREFUSED' }));

    const text = (await run({ action: 'stats', profile: 'production' })).content[0].text as string;

    expect(text).toContain('ECONNREFUSED');
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
    pingMock.mockResolvedValue({ state: 'ready', masterWasActive: false, latencyMs: 380 });

    const text = (await run({ action: 'test', profile: 'production' })).content[0].text as string;

    expect(text.toLowerCase()).toContain('new connection');
  });

  it('недоступный сервер — это ошибка, а не «✅»', async () => {
    pingMock.mockResolvedValue({ state: 'no-route', masterWasActive: false, latencyMs: 5000 });

    const response = await run({ action: 'test', profile: 'production' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text as string).not.toContain('✅');
  });

  it('сбой транспорта тоже подаётся как неудачная проверка', async () => {
    pingMock.mockRejectedValue(new Error('Authentication failed'));

    const response = await run({ action: 'test', profile: 'production' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text as string).toContain('Authentication failed');
  });
});

describe('ssh_monitor list', () => {
  it('без сломанных профилей список не обрастает пустой секцией', async () => {
    const text = (await run({ action: 'list' })).content[0].text as string;

    expect(text).toContain('production');
    expect(text).toContain('staging');
    expect(text.toLowerCase()).not.toContain('broken');
  });

  it('сломанный профиль назван вместе с причиной', async () => {
    getBrokenProfilesMock.mockReturnValue([broken({ name: 'typo-host' })]);

    const text = (await run({ action: 'list' })).content[0].text as string;

    expect(text).toContain('typo-host');
    expect(text).toContain(
      'Profile "typo-host" has invalid port: port must be a number between 1 and 65535 (got 70000)'
    );
  });

  it('несколько сломанных профилей перечисляются все', async () => {
    getBrokenProfilesMock.mockReturnValue([
      broken({ name: 'typo-host', field: 'port' }),
      broken({ name: 'typo-key', field: 'strictHostKeyChecking', reason: 'allowed values are yes, accept-new, no', value: '"maybe"' }),
    ]);

    const text = (await run({ action: 'list' })).content[0].text as string;

    expect(text).toContain('typo-host');
    expect(text).toContain('typo-key');
  });
});

function socket(overrides: Partial<{ path: string; since: Date; state: string }> = {}) {
  return { path: '/tmp/cm/s-abc', since: new Date(0), state: 'alive', ...overrides };
}

describe('ssh_monitor close', () => {
  it('закрывает соединение названного профиля и говорит, чьё', async () => {
    const response = await run({ action: 'close', profile: 'staging' });

    expect(closeMasterMock).toHaveBeenCalled();
    expect(response.isError).toBeUndefined();
    // Закрывается соединение названного профиля, а не какое придётся
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
    const text = response.content[0].text as string;
    expect(text).toContain('Shared Connection: staging');
    expect(text).toContain('example.com:2222');
  });

  it('без имени профиля ничего не закрывается', async () => {
    const response = await run({ action: 'close' });

    expect(response.isError).toBe(true);
    expect(closeMasterMock).not.toHaveBeenCalled();
  });

  it('«закрывать было нечего» — это успех, а не ошибка', async () => {
    closeMasterMock.mockResolvedValue('nothing-to-close');

    const response = await run({ action: 'close', profile: 'production' });

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text as string).toContain('idled out');
  });

  it('без мультиплексирования объясняет, что закрывать нечего в принципе', async () => {
    closeMasterMock.mockResolvedValue('multiplexing-off');

    const text = (await run({ action: 'close', profile: 'production' })).content[0].text as string;

    expect(text).toContain('multiplexing is off');
  });

  it('сбой закрытия подаётся ошибкой', async () => {
    closeMasterMock.mockRejectedValue(new Error('ssh: command not found'));

    const response = await run({ action: 'close', profile: 'production' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text as string).toContain('ssh: command not found');
  });

  it('называет соединения, оставшиеся на машине, и срок их простоя', async () => {
    listSocketsMock.mockResolvedValue([socket(), socket({ path: '/tmp/cm/s-def' })]);

    const text = (await run({ action: 'close', profile: 'production' })).content[0].text as string;

    expect(text).toContain('2 live connection(s)');
    expect(text).toContain('600s');
  });

  it('огрызки сокетов за живые соединения не считаются', async () => {
    listSocketsMock.mockResolvedValue([socket({ state: 'stale' }), socket({ state: 'unknown' })]);

    const text = (await run({ action: 'close', profile: 'production' })).content[0].text as string;

    expect(text).toContain('no live connections');
  });

  it('нечитаемый каталог не выдаётся за пустой и не рушит закрытие', async () => {
    listSocketsMock.mockRejectedValue(new Error('EACCES: permission denied'));

    const response = await run({ action: 'close', profile: 'production' });

    expect(response.isError).toBeUndefined();
    const text = response.content[0].text as string;
    expect(text).toContain('✅ Closed');
    expect(text).toContain('unknown');
    expect(text).toContain('EACCES');
  });
});
