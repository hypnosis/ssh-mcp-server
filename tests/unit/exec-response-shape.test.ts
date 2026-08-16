/**
 * Unit tests: форма того, что `ssh_exec` отдаёт агенту.
 *
 * У инструмента две ветки ответа — одиночная команда отдаёт голый вывод, пачка
 * собирает нумерованный разбор. Тесты проверяли только то, что команда уехала на
 * сервер, поэтому ветки были неразличимы: мутация «считать любой вызов пачкой»
 * оставалась незамеченной, хотя ответ при этом меняется целиком.
 *
 * Сюда же — объявление инструмента и опции вызова. Схему агент читает раньше
 * первой команды, а `sudo` уезжает двумя отдельными строками, по одной на ветку.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    DEFAULT_TIMEOUT_MS: actual.DEFAULT_TIMEOUT_MS,
    SSHExecutor: class {
      execute = executeMock;
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
  getDefaultProfile: () => 'production',
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { CONFIRMATION_MARKER } = await import('../../src/utils/destructive-command.js');

/** Ответы транспорта по образцу команды; всё, что не совпало, отвечает успехом */
function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    return { stdout: '', stderr: '', exitCode: 0, truncated: false, ...(match?.[1] ?? {}) };
  });
}

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_exec', arguments: args } } as CallToolRequest;
}

/** Текст ответа инструмента на один вызов */
async function answer(args: Record<string, unknown>): Promise<string> {
  const response = await new ExecTool().handleCall(call(args));
  return response.content[0].text;
}

/** Опции, с которыми позвали исполнитель для команды по образцу */
function sentOptions(pattern: RegExp): Record<string, unknown> | undefined {
  const sent = executeMock.mock.calls.find(([, command]) => pattern.test(String(command)));
  return sent?.[2] as Record<string, unknown> | undefined;
}

/** Свойства схемы инструмента */
function schemaProperties(): Record<string, Record<string, unknown>> {
  return new ExecTool().getTool().inputSchema.properties as Record<string, Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
  passportMock.mockResolvedValue({ home: '/home/deploy', known: true });
});

describe('ssh_exec: объявление инструмента', () => {
  it('называется именем, по которому его зовут', () => {
    expect(new ExecTool().getTool().name).toBe('ssh_exec');
  });

  it('без команды звать нечего — она единственная обязательная', () => {
    expect(new ExecTool().getTool().inputSchema.required).toEqual(['command']);
  });

  it('команда объявлена и строкой, и списком строк', () => {
    expect(schemaProperties().command.oneOf).toEqual([
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ]);
  });

  it('аргументы объявлены записью', () => {
    expect(new ExecTool().getTool().inputSchema.type).toBe('object');
  });

  it.each([
    ['profile', 'string'],
    ['sudo', 'boolean'],
    ['cwd', 'string'],
    ['timeout', 'number'],
  ])('%s объявлен как %s', (name, type) => {
    expect(schemaProperties()[name].type).toBe(type);
  });

  it('sudo по умолчанию выключен', () => {
    expect(schemaProperties().sudo.default).toBe(false);
  });

  /**
   * Маркер — единственный способ провести отказанное удаление, и узнаёт о нём
   * агент только отсюда: описание без маркера превращает отказ в тупик.
   */
  it('описание называет маркер подтверждения', () => {
    expect(new ExecTool().getTool().description).toContain(CONFIRMATION_MARKER);
  });
});

describe('ssh_exec: ответ на одиночную команду', () => {
  it('вывод отдаётся как есть, без обвязки пачки', async () => {
    respondWith([[/^hostname/, { stdout: 'debian' }]]);

    expect(await answer({ command: 'hostname' })).toBe('debian');
  });

  it('список из одной команды — тоже одиночный ответ', async () => {
    respondWith([[/^hostname/, { stdout: 'debian' }]]);

    expect(await answer({ command: ['hostname'] })).toBe('debian');
  });

  it('успех без вывода объясняется словами, а не пустотой', async () => {
    expect(await answer({ command: 'true' })).toBe('(command executed successfully, no output)');
  });

  it('нулевой код не приписывается к ответу', async () => {
    respondWith([[/^hostname/, { stdout: 'debian' }]]);

    expect(await answer({ command: 'hostname' })).not.toContain('Exit code');
  });

  it('ненулевой код называется числом', async () => {
    respondWith([[/^grep/, { exitCode: 2 }]]);

    expect(await answer({ command: 'grep x file' })).toContain('Exit code: 2');
  });

  it('чужой канал подписан и идёт после вывода', async () => {
    respondWith([[/^ls/, { stdout: 'file', stderr: 'ls: no access' }]]);

    expect(await answer({ command: 'ls /root' })).toBe('file\n\nSTDERR:\nls: no access');
  });
});

describe('ssh_exec: ответ на пачку команд', () => {
  it('пачка отвечает нумерованным разбором, а не одним выводом', async () => {
    respondWith([
      [/^hostname/, { stdout: 'debian' }],
      [/^whoami/, { stdout: 'root' }],
    ]);

    const text = await answer({ command: ['hostname', 'whoami'] });

    expect(text).toContain('Executed 2 commands:');
    expect(text).toContain('[1/2] hostname');
    expect(text).toContain('[2/2] whoami');
    expect(text).toContain('debian');
    expect(text).toContain('root');
  });

  it('код возврата называется у каждой команды, включая нулевой', async () => {
    respondWith([[/^whoami/, { exitCode: 1 }]]);

    const text = await answer({ command: ['hostname', 'whoami'] });

    // Ноль здесь нужен: в разборе пачки молчание нельзя отличить от пропуска
    expect(text).toContain('Exit code: 0');
    expect(text).toContain('Exit code: 1');
  });

  it('чужой канал подписан у своей команды', async () => {
    respondWith([[/^whoami/, { stderr: 'no user' }]]);

    const text = await answer({ command: ['hostname', 'whoami'] });

    expect(text).toContain('STDERR: no user');
    expect(text.slice(0, text.indexOf('[2/2]'))).not.toContain('STDERR');
  });

  it('команды разделены чертой', async () => {
    const text = await answer({ command: ['hostname', 'whoami'] });

    expect(text).toContain('─'.repeat(60));
  });

  /**
   * Разбор целиком, знак в знак: по кускам отступы и переводы строк
   * не проверяются никак, а именно они отделяют вывод одной команды от другой.
   */
  it('разбор собран целиком: заголовок, черта, вывод, код — у каждой команды', async () => {
    respondWith([[/^whoami/, { stdout: 'root', stderr: 'no tty', exitCode: 1 }]]);
    const line = '─'.repeat(60);

    const text = await answer({ command: ['true', 'whoami'] });

    expect(text).toBe(
      'Executed 2 commands:\n\n' +
        `[1/2] true\n${line}\nExit code: 0\n\n` +
        `[2/2] whoami\n${line}\nroot\nSTDERR: no tty\nExit code: 1\n\n`
    );
  });
});

describe('ssh_exec: опции доезжают в обеих ветках', () => {
  it.each([
    ['одиночной', 'hostname'],
    ['в пачке', ['hostname', 'whoami']],
  ])('sudo доезжает до команды %s', async (_label, command) => {
    await answer({ command, sudo: true, cwd: '/srv' });

    expect(sentOptions(/^hostname/)).toMatchObject({ sudo: true, cwd: '/srv' });
  });

  /**
   * Умолчание проверяется отдельным утверждением: `undefined` вместо `false`
   * ниже читается как «не сказано», и слой под инструментом волен решить иначе.
   */
  it.each([
    ['одиночной', 'hostname'],
    ['в пачке', ['hostname', 'whoami']],
  ])('без просьбы sudo уезжает выключенным для команды %s', async (_label, command) => {
    await answer({ command });

    expect(sentOptions(/^hostname/)?.sudo).toBe(false);
  });

  it('второй команде пачки достаются те же опции, что и первой', async () => {
    await answer({ command: ['hostname', 'whoami'], sudo: true, cwd: '/srv' });

    expect(sentOptions(/^whoami/)).toMatchObject({ sudo: true, cwd: '/srv' });
  });

  it('названный профиль доходит до резолвера — иначе команда уедет не на тот сервер', async () => {
    await answer({ command: 'hostname', profile: 'production' });

    expect(resolveMock).toHaveBeenCalledWith({ profile: 'production' });
  });
});

describe('ssh_exec: ответ подписан текстовым типом', () => {
  it.each([
    ['вывод команды', { command: 'hostname' }],
    ['разбор пачки', { command: ['hostname', 'whoami'] }],
    ['отказ по форме аргумента', { command: 42 }],
    ['отказ по опасному удалению', { command: 'rm -rf /' }],
  ])('%s отдаётся как текст', async (_label, args) => {
    const response = await new ExecTool().handleCall(call(args));

    expect(response.content[0].type).toBe('text');
  });

  it('сбой отдаётся текстом и называет причину', async () => {
    executeMock.mockRejectedValue(new Error('connection reset'));

    const response = await new ExecTool().handleCall(call({ command: 'hostname' }));

    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toBe('Error: connection reset');
  });
});

describe('ssh_exec: предупреждение об опасной команде', () => {
  it.each([
    ['chmod 777 /srv/app', 'chmod 777 detected (security risk)'],
    ['docker rm -f $(docker ps -aq)', 'docker rm all containers detected'],
    ['psql -c "DROP TABLE users;"', 'DROP TABLE detected'],
    ['psql -c "TRUNCATE users;"', 'TRUNCATE detected'],
    ['psql -c "DELETE FROM users;"', 'DELETE without WHERE detected'],
  ])('%s сопровождается предупреждением', async (command, message) => {
    const text = await answer({ command });

    expect(text).toContain('⚠️  DANGEROUS COMMAND');
    expect(text).toContain(message);
  });

  it('предупреждение не отменяет команду — она уходит и отвечает', async () => {
    respondWith([[/^chmod/, { stdout: 'mode changed' }]]);

    const text = await answer({ command: 'chmod 777 /srv/app' });

    expect(text).toContain('mode changed');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('в предупреждении видно, о какой именно команде речь', async () => {
    const text = await answer({ command: 'sudo chmod 777 /srv/app' });

    expect(text).toContain('Command: sudo chmod 777 /srv/app');
  });

  it('длинная команда в предупреждении обрезается', async () => {
    const command = `chmod 777 /srv/app # ${'x'.repeat(200)}`;

    const text = await answer({ command });

    expect(text).toContain(`Command: ${command.slice(0, 100)}\n`);
    expect(text).not.toContain(command);
  });

  it('в пачке предупреждения идут перед разбором и отделены от него чертой', async () => {
    const text = await answer({ command: ['chmod 777 /a', 'chmod 777 /b'] });

    expect(text).toContain(
      '⚠️  DANGEROUS COMMAND: chmod 777 detected (security risk)\nCommand: chmod 777 /a\n\n' +
        '⚠️  DANGEROUS COMMAND: chmod 777 detected (security risk)\nCommand: chmod 777 /b\n\n' +
        '═'.repeat(60) +
        '\n\nExecuted 2 commands:'
    );
  });

  it('безобидная команда не собирает ни предупреждений, ни черты под ними', async () => {
    respondWith([[/^uptime/, { stdout: 'up 3 days' }]]);

    const text = await answer({ command: ['uptime', 'whoami'] });

    expect(text).not.toContain('DANGEROUS');
    expect(text).not.toContain('═');
  });

  it('одиночная безобидная команда отвечает одним выводом', async () => {
    respondWith([[/^uptime/, { stdout: 'up 3 days' }]]);

    expect(await answer({ command: 'uptime' })).toBe('up 3 days');
  });
});

describe('ssh_exec: список, записанный строкой', () => {
  it('отказ называет параметр и показывает верную запись', async () => {
    const text = await answer({ command: "['uptime', 'whoami']" });

    expect(text).toContain("Malformed 'command' parameter");
    expect(text).toContain('command: ["item1", "item2", "item3"]');
  });

  it('на сервер при таком отказе ничего не уходит', async () => {
    await answer({ command: "['uptime', 'whoami']" });

    expect(executeMock).not.toHaveBeenCalled();
  });

  it('bash-проверка списком не считается и выполняется', async () => {
    respondWith([[/^\[\[/, { stdout: 'exists' }]]);

    expect(await answer({ command: '[[ -f /etc/hosts ]] && echo exists' })).toBe('exists');
  });
});
