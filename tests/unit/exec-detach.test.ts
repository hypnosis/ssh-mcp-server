/**
 * Unit tests: `detach` у ssh_exec.
 *
 * Сборка команд задачи проверяется своим файлом; здесь — только соединение с
 * инструментом: что отказ выносится до отправки, что сторож удаления работает и
 * на этом пути, и что рабочий каталог достаётся команде, а не служебным файлам.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

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

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

function call(command: string | string[], extra: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name: 'ssh_exec', arguments: { command, detach: true, ...extra } } } as CallToolRequest;
}

/** Всё, что ушло в транспорт за вызов — обоими путями сразу */
function sentCommands(): string[] {
  return [...executeMock.mock.calls, ...executeCheckedMock.mock.calls].map((args) => String(args[1]));
}

/** Команда запуска задачи, если она вообще уходила */
function startCommand(): string {
  return String(executeCheckedMock.mock.calls[0]?.[1] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  // Мок злее сервера: резолв ссылки отвечает настоящей целью, а не именем
  executeMock.mockImplementation(async (_config: unknown, command: string) => ({
    stdout: command.includes('readlink -f') ? '/\n' : 'ok',
    stderr: '',
    exitCode: 0,
    truncated: false,
  }));
  executeCheckedMock.mockResolvedValue({
    stdout: 'SSH_MCP_JOB pid=4242\n',
    stderr: '',
    exitCode: 0,
    truncated: false,
  });
  passportMock.mockResolvedValue({
    ...UNKNOWN_PASSPORT,
    known: true,
    home: '/home/deploy',
    setsid: true,
  });
});

describe('ssh_exec: detach', () => {
  it('объявлен в схеме инструмента', () => {
    const schema = new ExecTool().getTool().inputSchema as { properties: Record<string, unknown> };

    expect(schema.properties.detach).toMatchObject({ type: 'boolean', default: false });
  });

  it('отдаёт идентификатор задачи и pid, названный сервером', async () => {
    const result = await new ExecTool().handleCall(call('sleep 120 && echo done'));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Job [a-z0-9-]+ started \(pid 4242\)\./);
  });

  it('идентификатор из ответа — тот же, что в пути каталога задачи', async () => {
    const result = await new ExecTool().handleCall(call('sleep 120'));

    const id = result.content[0].text.match(/Job (\S+) started/)?.[1];
    expect(id).toBeTruthy();
    expect(startCommand()).toContain(`/home/deploy/.ssh-mcp/jobs/${id}`);
  });

  it('pid, который сервер не назвал, не выдаётся за полученный', async () => {
    executeCheckedMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    const result = await new ExecTool().handleCall(call('sleep 120'));

    expect(result.content[0].text).toContain('did not report a pid');
    expect(result.content[0].text).not.toContain('pid undefined');
  });

  it('каталог задачи строится от дома из паспорта', async () => {
    await new ExecTool().handleCall(call('sleep 120'));

    expect(startCommand()).toContain("mkdir -p '/home/deploy/.ssh-mcp/jobs/");
  });

  it('неизвестный дом — отказ, а не путь наугад', async () => {
    passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, home: '' });

    const result = await new ExecTool().handleCall(call('sleep 120'));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('home directory');
    expect(executeCheckedMock).not.toHaveBeenCalled();
  });

  it('setsid берётся из паспорта: он есть', async () => {
    await new ExecTool().handleCall(call('sleep 120'));

    expect(startCommand()).toContain('setsid sh -c');
  });

  it('setsid берётся из паспорта: его нет — запуск идёт через nohup', async () => {
    passportMock.mockResolvedValue({
      ...UNKNOWN_PASSPORT,
      known: true,
      home: '/home/deploy',
      setsid: false,
    });

    await new ExecTool().handleCall(call('sleep 120'));

    expect(startCommand()).toContain('nohup sh -c');
    expect(startCommand()).not.toContain('setsid');
  });

  it('рабочий каталог достаётся команде задачи, а не служебным файлам', async () => {
    await new ExecTool().handleCall(call('make build', { cwd: '/srv/app' }));

    // Каталог задачи создаётся с самого начала строки — значит `cd` внутри
    expect(startCommand().startsWith('mkdir -p ')).toBe(true);
    // Команда уезжает закавыченной целиком, поэтому кавычки каталога удвоены
    expect(startCommand()).toContain(`cd '\\''/srv/app'\\'' || exit 1; make build`);
  });

  /**
   * Тело задачи с неудавшимся переходом обязано закончиться, не выполнив
   * ничего: иначе задача отчитывается кодом 0 о работе в чужом каталоге.
   */
  it('неудачный переход обрывает всю команду задачи', async () => {
    await new ExecTool().handleCall(call('echo before; pwd', { cwd: '/srv/app' }));

    expect(startCommand()).toContain(`|| exit 1; echo before; pwd`);
    expect(startCommand()).not.toContain(`'\\'' && `);
  });

  /**
   * Ни срока, ни отмены: задача живёт дольше вызова, а обрыв между её стартом и
   * ответом оставил бы её работать без идентификатора, то есть без снятия.
   */
  it('запуск идёт без опций вызова', async () => {
    const controller = new AbortController();

    await new ExecTool().handleCall(call('sleep 120', { timeout: 1000 }), controller.signal);

    expect(executeCheckedMock.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('detach: false — обычный путь, а не задача', async () => {
    await new ExecTool().handleCall({
      params: { name: 'ssh_exec', arguments: { command: 'uptime', detach: false } },
    } as CallToolRequest);

    expect(executeCheckedMock).not.toHaveBeenCalled();
    expect(sentCommands()).toEqual(['uptime']);
  });

  it('без detach путь остаётся прежним — задача не заводится', async () => {
    await new ExecTool().handleCall({
      params: { name: 'ssh_exec', arguments: { command: 'uptime' } },
    } as CallToolRequest);

    expect(executeCheckedMock).not.toHaveBeenCalled();
    expect(sentCommands()).toEqual(['uptime']);
  });
});

describe('ssh_exec: чего detach не умеет', () => {
  it('вместе с sudo — отказ до отправки', async () => {
    const result = await new ExecTool().handleCall(call('sleep 120', { sudo: true }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be combined with sudo');
    expect(sentCommands()).toEqual([]);
  });

  it('вместе с interactive — отказ до отправки', async () => {
    const result = await new ExecTool().handleCall(call('sleep 120', { interactive: true }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be combined with interactive');
    expect(sentCommands()).toEqual([]);
  });

  it('с несколькими командами — отказ: задача одна', async () => {
    const result = await new ExecTool().handleCall(call(['sleep 120', 'echo done']));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('got an array of 2 commands');
    expect(sentCommands()).toEqual([]);
  });

  it('массив из одной команды задачей быть может', async () => {
    const result = await new ExecTool().handleCall(call(['sleep 120']));

    expect(result.isError).toBeUndefined();
    expect(startCommand()).toContain('sleep 120');
  });

  it('снос корня отменяет вызов до того, как заведётся каталог задачи', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /'));

    expect(result.content[0].text).toContain('⛔ BLOCKED');
    expect(result.isError).toBe(true);
    expect(executeCheckedMock).not.toHaveBeenCalled();
  });

  it('снос через ссылку отменяет вызов после резолва, но до запуска задачи', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /var/www/data/'));

    expect(result.content[0].text).toContain('via symlink');
    expect(result.isError).toBe(true);
    expect(executeCheckedMock).not.toHaveBeenCalled();
  });
});
