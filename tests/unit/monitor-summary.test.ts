/**
 * Unit tests: сводка рядом с ответом `ssh_monitor`.
 *
 * Состояние решает всё дальнейшее: на `limited` файловые инструменты, снимок и
 * аудит работать не с чем, а добывалось оно разбором первой строки с эмодзи.
 *
 * Отдельно сторожится то, что измеряет только `test`: у остальных действий
 * состояние обязано приходить пустым, иначе непроверенная связь прочитается
 * как проверенная и здоровая.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { PingResult } from '../../src/runner/types.js';
import type { MonitorSummary } from '../../src/tools/monitor-output.js';

const { pingMock, statsMock, closeMasterMock, getRunnerMock, resolveConfigMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  statsMock: vi.fn(),
  closeMasterMock: vi.fn(),
  getRunnerMock: vi.fn(),
  resolveConfigMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

vi.mock('../../src/runner/control-sockets.js', () => ({
  listControlSockets: async () => [],
  idleWindowSec: () => 600,
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: resolveConfigMock,
  getAvailableProfiles: () => ['production', 'office-router'],
  getBrokenProfiles: () => [],
  reloadProfiles: () => undefined,
}));

const { MonitoringTool } = await import('../../src/tools/monitoring-tool.js');

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_monitor', arguments: args } } as CallToolRequest;
}

async function summaryOf(args: Record<string, unknown>): Promise<MonitorSummary> {
  const response = await new MonitoringTool().handleCall(call(args));
  return response.structuredContent as MonitorSummary;
}

function ping(overrides: Partial<PingResult> = {}): PingResult {
  return { state: 'ready', masterWasActive: true, latencyMs: 42, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfigMock.mockReturnValue({ host: 'example.com', username: 'deploy', port: 22 });
  pingMock.mockResolvedValue(ping());
  statsMock.mockResolvedValue({
    backend: 'openssh',
    multiplexing: true,
    masterActive: true,
    commandsThisSession: 1,
    transfersThisSession: 0,
  });
  closeMasterMock.mockResolvedValue('closed');
  getRunnerMock.mockResolvedValue({
    ping: pingMock,
    stats: statsMock,
    closeMaster: closeMasterMock,
  });
});

describe('сводка ssh_monitor: состояние связи', () => {
  it.each([['ready'], ['limited'], ['no-route'], ['rejected']])(
    'состояние %s приходит полем, а не первой строкой текста',
    async (state) => {
      pingMock.mockResolvedValue(ping({ state: state as PingResult['state'] }));

      expect((await summaryOf({ action: 'test', profile: 'production' })).state).toBe(state);
    }
  );

  it('недостижимый сервер отвечает провалом, но сводку всё равно приносит', async () => {
    pingMock.mockResolvedValue(ping({ state: 'no-route' }));

    const response = await new MonitoringTool().handleCall(call({ action: 'test', profile: 'production' }));

    expect(response.isError).toBe(true);
    expect((response.structuredContent as MonitorSummary).state).toBe('no-route');
  });

  it('названный профиль стоит в сводке — иначе непонятно, о какой машине речь', async () => {
    expect((await summaryOf({ action: 'test', profile: 'office-router' })).profile).toBe('office-router');
  });

  it('задержка доезжает числом', async () => {
    pingMock.mockResolvedValue(ping({ latencyMs: 340 }));

    expect((await summaryOf({ action: 'test', profile: 'production' })).latency_ms).toBe(340);
  });

  /**
   * Код пробы несёт только `limited`. Ноль на его месте у здоровой связи
   * читался бы как выполненная проба, поэтому там пустота.
   */
  it.each([
    ['limited', 127, 127],
    ['ready', undefined, null],
  ])('у состояния %s код пробы приходит как %s', async (state, exitCode, expected) => {
    pingMock.mockResolvedValue(ping({ state: state as PingResult['state'], exitCode: exitCode as number | undefined }));

    expect((await summaryOf({ action: 'test', profile: 'production' })).exit_code).toBe(expected);
  });
});

describe('сводка ssh_monitor: действия, которые до сервера не ходят', () => {
  it.each([
    ['stats', { action: 'stats', profile: 'production' }],
    ['reload', { action: 'reload' }],
    ['list', { action: 'list' }],
    ['close', { action: 'close', profile: 'production' }],
  ])('%s называет себя действием и не выдумывает состояния', async (action, args) => {
    const summary = await summaryOf(args);

    expect(summary.action).toBe(action);
    expect(summary.state).toBeNull();
    expect(summary.latency_ms).toBeNull();
    expect(summary.exit_code).toBeNull();
  });

  it.each([
    ['stats', { action: 'stats', profile: 'production' }, 'production'],
    ['close', { action: 'close', profile: 'office-router' }, 'office-router'],
    ['list', { action: 'list' }, null],
    ['reload', { action: 'reload' }, null],
  ])('%s показывает машину, если действие вообще про машину', async (_action, args, expected) => {
    expect((await summaryOf(args)).profile).toBe(expected);
  });
});

describe('сводка ssh_monitor: где её не бывает', () => {
  it('неизвестное действие — разбирать нечего', async () => {
    const response = await new MonitoringTool().handleCall(call({ action: 'fly' }));

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
  });

  it('действие без профиля — отказ без сводки', async () => {
    const response = await new MonitoringTool().handleCall(call({ action: 'test' }));

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
  });
});
