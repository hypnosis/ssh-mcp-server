/**
 * Unit tests: сводка, которая едет рядом с текстом ответа `ssh_exec`.
 *
 * Текст отвечает человеку, сводка — агенту, и опасность у неё своя: клиент
 * сверяет пришедшее с объявленной схемой, поэтому неверное поле превращает
 * честный ответ в ошибку протокола. Здесь сторожатся сами значения, а не факт
 * того, что сводка есть.
 *
 * Главное правило формата проверяется отдельно: «выполнялась ли команда»
 * отвечает `exit_code`, а флаги отвечают только «почему» — иначе
 * заблокированная команда прочиталась бы как отработавшая.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';
import type { CommandSummary, ExecSummary } from '../../src/tools/exec-output.js';

const { executeMock, executeCheckedMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  executeCheckedMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    DEFAULT_TIMEOUT_MS: actual.DEFAULT_TIMEOUT_MS,
    SSHExecutor: class {
      execute = executeMock;
      executeChecked = executeCheckedMock;
      passport = passportMock;
    },
  };
});

const { resolveMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(() => ({ host: 'example.com', username: 'deploy', port: 22 })),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: resolveMock,
  getAvailableProfiles: () => ['production'],
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { SSHTimeoutError } = await import('../../src/runner/errors.js');

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_exec', arguments: args } } as CallToolRequest;
}

/** Ответы транспорта по образцу команды; всё, что не совпало, отвечает успехом */
function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    return { stdout: '', stderr: '', exitCode: 0, truncated: false, ...(match?.[1] ?? {}) };
  });
}

async function summaryOf(args: Record<string, unknown>): Promise<ExecSummary> {
  const response = await new ExecTool().handleCall(call(args));
  return response.structuredContent as ExecSummary;
}

async function commandsOf(args: Record<string, unknown>): Promise<CommandSummary[]> {
  return (await summaryOf(args)).commands;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
  passportMock.mockResolvedValue({ home: '/home/deploy', known: true, setsid: true });
  executeCheckedMock.mockResolvedValue({ stdout: 'pid 4242', stderr: '', exitCode: 0, truncated: false });
});

describe('сводка ssh_exec: форма не зависит от числа команд', () => {
  it.each([
    ['одиночной команде', 'hostname', 1],
    ['списку из одной команды', ['hostname'], 1],
    ['пачке', ['hostname', 'whoami', 'date'], 3],
  ])('по %s приходит список записей длиной %s', async (_label, command, length) => {
    expect(await commandsOf({ command })).toHaveLength(length as number);
  });

  it('записи идут в порядке отправки', async () => {
    const commands = await commandsOf({ command: ['hostname', 'whoami', 'date'] });

    expect(commands.map((entry) => entry.command)).toEqual(['hostname', 'whoami', 'date']);
  });

  /**
   * Клиент со схемой показывает вызывающему одни поля, поэтому вывод,
   * оставленный в тексте, не доезжает ни до кого.
   */
  it('вывод команды едет в сводке', async () => {
    respondWith([[/^hostname/, { stdout: 'debian', stderr: 'noise' }]]);

    const command = (await commandsOf({ command: 'hostname' }))[0];

    expect(command.stdout).toBe('debian');
    expect(command.stderr).toBe('noise');
  });

  it('целый вывод помечен нулём вырезанного', async () => {
    respondWith([[/^hostname/, { stdout: 'debian', stderr: '' }]]);

    expect((await commandsOf({ command: 'hostname' }))[0].clipped_bytes).toBe(0);
  });

  /** Пустая строка — «отработала молча», отсутствие поля — «не выполнялась» */
  it('у невыполненной команды полей вывода нет вовсе', async () => {
    respondWith([[/^hostname/, { stdout: 'debian', stderr: '' }]]);

    const commands = await commandsOf({ command: ['hostname', 'rm -rf /'] });
    const refused = commands[commands.length - 1];

    expect(refused.stdout).toBeUndefined();
    expect(refused.stderr).toBeUndefined();
    expect(refused.clipped_bytes).toBeUndefined();
  });
});

describe('сводка ssh_exec: код возврата', () => {
  it('нулевой код назван числом, а не пустотой — иначе успех неотличим от невыполнения', async () => {
    expect((await commandsOf({ command: 'true' }))[0].exit_code).toBe(0);
  });

  it('ненулевой код доезжает как есть', async () => {
    respondWith([[/^grep/, { exitCode: 2 }]]);

    expect((await commandsOf({ command: 'grep x file' }))[0].exit_code).toBe(2);
  });

  it('в пачке код стоит у своей команды', async () => {
    respondWith([[/^whoami/, { exitCode: 1 }]]);

    const commands = await commandsOf({ command: ['hostname', 'whoami'] });

    expect(commands.map((entry) => entry.exit_code)).toEqual([0, 1]);
  });
});

describe('сводка ssh_exec: обрезка и сторож времени', () => {
  it.each([
    [true, true],
    [false, false],
  ])('обрезка вывода (%s) доезжает полем', async (truncated, expected) => {
    respondWith([[/^cat/, { truncated }]]);

    expect((await commandsOf({ command: 'cat /var/log/big' }))[0].truncated).toBe(expected);
  });

  /**
   * Коды у сторожа два: 124 у coreutils и 143 у BusyBox. Тест на один из них
   * оставляет второй без присмотра, а расходятся наборы утилит молча.
   */
  it.each([
    [124, true],
    [143, true],
    [1, false],
    [0, false],
  ])('код %s читается как остановка сторожем: %s', async (exitCode, expected) => {
    respondWith([[/^sleep/, { exitCode }]]);

    expect((await commandsOf({ command: 'sleep 99' }))[0].timed_out).toBe(expected);
  });

  it('остановленная сторожем команда всё же отчиталась — код у неё есть', async () => {
    respondWith([[/^sleep/, { exitCode: 124 }]]);

    expect((await commandsOf({ command: 'sleep 99' }))[0].exit_code).toBe(124);
  });
});

describe('сводка ssh_exec: отказ сторожа удаления', () => {
  const batch = ['uptime', 'rm -rf /', 'whoami'];

  it('отказ приходит со сводкой, хотя ответ помечен провалом', async () => {
    const response = await new ExecTool().handleCall(call({ command: batch }));

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeDefined();
  });

  it('видно, какая именно команда отказана', async () => {
    const commands = await commandsOf({ command: batch });

    expect(commands.map((entry) => entry.blocked)).toEqual([false, true, false]);
  });

  it('причина отказа названа полем и повторяет ту, что ушла в текст', async () => {
    const response = await new ExecTool().handleCall(call({ command: batch }));
    const blocked = (response.structuredContent as ExecSummary).commands[1];

    expect(blocked.blocked_reason).toBeTruthy();
    expect(response.content[0].text).toContain(blocked.blocked_reason!);
  });

  /** Отказ останавливает весь вызов, поэтому не выполнялась и та команда, что стояла раньше */
  it('остальные команды помечены невыполненными — и после отказанной, и до неё', async () => {
    const commands = await commandsOf({ command: batch });

    expect(commands.map((entry) => entry.not_run)).toEqual([true, false, true]);
  });

  it('кода нет ни у одной команды: не выполнялась ни одна', async () => {
    const commands = await commandsOf({ command: batch });

    expect(commands.map((entry) => entry.exit_code)).toEqual([null, null, null]);
  });

  it('на сервер при отказе не уходит ни одной команды вызова', async () => {
    await commandsOf({ command: batch });

    expect(executeMock.mock.calls.map(([, command]) => String(command))).not.toContain('uptime');
  });
});

describe('сводка ssh_exec: вызов оборвался посреди пачки', () => {
  /** Сначала одна команда отвечает, на второй транспорт падает */
  function failOnSecond(error: Error): void {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (/^whoami/.test(command)) throw error;
      return { stdout: 'debian', stderr: '', exitCode: 0, truncated: false };
    });
  }

  it('сделанное не пропадает: у первой команды код на месте', async () => {
    failOnSecond(new Error('connection reset'));

    const commands = await commandsOf({ command: ['hostname', 'whoami', 'date'] });

    expect(commands[0].exit_code).toBe(0);
  });

  it('оборванная команда не отчиталась, а до третьей не дошли', async () => {
    failOnSecond(new Error('connection reset'));

    const commands = await commandsOf({ command: ['hostname', 'whoami', 'date'] });

    expect(commands[1]).toMatchObject({ exit_code: null, not_run: false });
    expect(commands[2]).toMatchObject({ exit_code: null, not_run: true });
  });

  /**
   * Сторож времени и оборванная связь ведут себя одинаково для текста, но не
   * для агента: после тайм-аута команда на сервере может быть ещё жива.
   */
  it.each([
    ['тайм-аут', new SSHTimeoutError('Command timed out after 30000ms on host'), true],
    ['обрыв связи', new Error('connection reset'), false],
  ])('%s помечается на оборванной команде: %s', async (_label, error, expected) => {
    failOnSecond(error as Error);

    const commands = await commandsOf({ command: ['hostname', 'whoami', 'date'] });

    expect(commands[1].timed_out).toBe(expected);
  });

  it('ответ остаётся провалом и называет причину текстом', async () => {
    failOnSecond(new Error('connection reset'));

    const response = await new ExecTool().handleCall(call({ command: ['hostname', 'whoami'] }));

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('connection reset');
  });
});

describe('сводка ssh_exec: фоновая задача', () => {
  it('идентификатор задачи в поле тот же, что в тексте ответа', async () => {
    const response = await new ExecTool().handleCall(call({ command: 'sleep 60', detach: true }));
    const summary = response.structuredContent as ExecSummary;

    expect(summary.job_id).toBeTruthy();
    expect(response.content[0].text).toContain(`Job ${summary.job_id} started`);
  });

  it('запущенная задача ещё не отчиталась и не помечена невыполненной', async () => {
    const summary = await summaryOf({ command: 'sleep 60', detach: true });

    expect(summary.commands).toHaveLength(1);
    expect(summary.commands[0]).toMatchObject({ exit_code: null, not_run: false, blocked: false });
  });

  it('без detach поле задачи пустое, а не выдуманное', async () => {
    expect((await summaryOf({ command: 'hostname' })).job_id).toBeNull();
  });
});

describe('сводка ssh_exec: предупреждение стоит у своей команды', () => {
  it('в пачке предупреждение достаётся виновной команде, а не первой', async () => {
    const commands = await commandsOf({ command: ['uptime', 'chmod 777 /srv/app'] });

    expect(commands[0].warning).toBeNull();
    expect(commands[1].warning).toBe('chmod 777 detected (security risk)');
  });

  it('безобидной команде предупреждение не приписывается', async () => {
    expect((await commandsOf({ command: 'uptime' }))[0].warning).toBeNull();
  });

  it('предупреждение не отменяет команду: код у неё есть', async () => {
    respondWith([[/^chmod/, { exitCode: 0 }]]);

    expect((await commandsOf({ command: 'chmod 777 /srv/app' }))[0].exit_code).toBe(0);
  });
});

describe('сводка ssh_exec: где её не бывает', () => {
  it('список, записанный строкой, — входов не разобрали, сводки нет', async () => {
    const response = await new ExecTool().handleCall(call({ command: "['uptime', 'whoami']" }));

    expect(response.structuredContent).toBeUndefined();
  });

  it('нераспознанный профиль — сводки нет', async () => {
    resolveMock.mockImplementationOnce(() => {
      throw new Error('Unknown profile');
    });

    const response = await new ExecTool().handleCall(call({ command: 'hostname' }));

    expect(response.structuredContent).toBeUndefined();
  });

  it('detach со списком команд — сводки нет: до отправки не дошло', async () => {
    const response = await new ExecTool().handleCall(
      call({ command: ['hostname', 'whoami'], detach: true })
    );

    expect(response.structuredContent).toBeUndefined();
  });
});
