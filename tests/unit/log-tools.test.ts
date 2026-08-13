/**
 * Unit tests: что журнальные инструменты просят у сервера и что показывают человеку
 *
 * Здесь две вещи, где ошибка не видна снаружи: строка команды (число строк,
 * набор флагов `grep`, кавычки вокруг пути) и сводка по нескольким журналам —
 * единственное, что видит агент. Сервер в тестах не заготовка: он держит
 * журналы, сам исполняет `tail` и `grep` по их содержимому, а команду, которой
 * не ждал, отклоняет.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteOptions, SSHExecuteResult } from '../../src/managers/ssh-executor.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    SSHExecutor: class {
      execute = executeMock;
      passport = passportMock;
      executeChecked = actual.SSHExecutor.prototype.executeChecked;
    },
  };
});

const { profile, resolveConfigMock } = vi.hoisted(() => ({
  profile: { config: {} as Record<string, unknown> },
  resolveConfigMock: vi.fn(),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: (...args: unknown[]) => {
    resolveConfigMock(...args);
    return profile.config;
  },
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { LogTools } = await import('../../src/tools/log-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');
const { TRUNCATED_OUTPUT_NOTE } = await import('../../src/utils/output-notes.js');

// ---------------------------------------------------------------------------
// Сервер: журналы, по которым он сам считает ответ
// ---------------------------------------------------------------------------

/** Что лежит на сервере прямо сейчас: путь → строки журнала */
let logs: Map<string, string[]>;
/** Ответы, которые сервер даёт вместо обычных: ключ — образец команды */
let overrides: Array<[RegExp, Partial<SSHExecuteResult>]>;

const ok = (stdout = ''): SSHExecuteResult =>
  ({ stdout, stderr: '', exitCode: 0, truncated: false }) as SSHExecuteResult;

const fail = (stderr: string, exitCode = 1): SSHExecuteResult =>
  ({ stdout: '', stderr, exitCode, truncated: false }) as SSHExecuteResult;

function quotedPaths(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/**
 * Ответ сервера на команду.
 *
 * Неизвестная команда — отказ: заготовка на любой запрос скрыла бы и потерянный
 * флаг, и обращение не к тому журналу.
 */
function answer(command: string): SSHExecuteResult {
  const override = overrides.find(([pattern]) => pattern.test(command));
  if (override) return { ...ok(), ...override[1] } as SSHExecuteResult;

  // Куда ведёт путь: сервер без readlink отвечает «выяснить нечем»
  if (command.startsWith('p=')) return ok('SSH_MCP_PATH_UNRESOLVED\n');

  if (command.startsWith('tail ')) {
    const match = /^tail -n (\S+) /.exec(command);
    // Число строк разбирает сама утилита: `tail -n undefined` — отказ
    if (!match || !/^\d+$/.test(match[1])) {
      return fail(`tail: invalid number of lines: '${match?.[1]}'`);
    }
    const path = quotedPaths(command)[0];
    const lines = logs.get(path);
    if (!lines) return fail(`tail: cannot open '${path}' for reading: No such file or directory`);
    const shown = lines.slice(-Number(match[1]));
    return ok(shown.length > 0 ? `${shown.join('\n')}\n` : '');
  }

  if (command.startsWith('grep ')) {
    const flags = command.slice('grep '.length, command.indexOf("'"));
    const [query, path] = quotedPaths(command);
    const lines = logs.get(path);
    if (!lines) return fail(`grep: ${path}: No such file or directory`, 2);

    const expression = new RegExp(query, flags.includes('-i') ? 'i' : '');
    const context = /-C (\d+)/.exec(flags);
    const numbered = lines.map((line, index) => [index + 1, line] as const);
    const limit = /-m (\d+)/.exec(flags);
    const found = numbered.filter(([, line]) => expression.test(line));
    // Предел ставит сама grep: дальше него она не читает
    const hits = limit ? found.slice(0, Number(limit[1])) : found;
    if (hits.length === 0) return fail('', 1);

    const around = new Set<number>();
    for (const [number] of hits) {
      const span = context ? Number(context[1]) : 0;
      for (let n = number - span; n <= number + span; n++) around.add(n);
    }
    const matched = new Set(hits.map(([number]) => number));
    // Совпадение отделяется от номера двоеточием, строка контекста — дефисом,
    // а разрыв между группами обозначается `--`: так печатает живой grep
    const shown: string[] = [];
    let previous = 0;
    for (const [number, line] of numbered) {
      if (!around.has(number)) continue;
      if (context && previous && number > previous + 1) shown.push('--');
      previous = number;
      shown.push(flags.includes('-n') ? `${number}${matched.has(number) ? ':' : '-'}${line}` : line);
    }
    return ok(`${shown.join('\n')}\n`);
  }

  throw new Error(`the server was not asked to run this: ${command}`);
}

function fullPassport(overridden: Record<string, unknown> = {}) {
  return { ...UNKNOWN_PASSPORT, known: true, home: '/home/deploy', ...overridden };
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

const responseOf = (request: CallToolRequest) => new LogTools().handleCall(request);

async function textOf(request: CallToolRequest): Promise<string> {
  return (await responseOf(request)).content[0].text as string;
}

const tail = (args: Record<string, unknown>) => textOf(call('ssh_log_tail', args));
const search = (args: Record<string, unknown>) => textOf(call('ssh_log_search', args));

function sentCommands(): Array<[string, SSHExecuteOptions]> {
  return executeMock.mock.calls.map(([, command, options]) => [
    command as string,
    (options ?? {}) as SSHExecuteOptions,
  ]);
}

function commandFor(pattern: RegExp): [string, SSHExecuteOptions] | undefined {
  return sentCommands().find(([command]) => pattern.test(command));
}

beforeEach(() => {
  vi.clearAllMocks();
  logs = new Map([
    ['/var/log/syslog', ['boot', 'ERROR disk full', 'ready']],
    ['/var/log/nginx.log', ['GET /', 'error 500', 'GET /about']],
  ]);
  overrides = [];
  profile.config = { host: 'example.com', username: 'deploy', port: 22 };
  executeMock.mockImplementation(async (_config: unknown, command: string) => answer(command));
  passportMock.mockResolvedValue(fullPassport());
});

/** Все поля схемы, включая вложенные в варианты oneOf */
function schemaFields(node: any, trail = ''): Array<[string, any]> {
  const fields: Array<[string, any]> = [];
  for (const [name, field] of Object.entries((node?.properties ?? {}) as Record<string, any>)) {
    fields.push([`${trail}${name}`, field]);
    fields.push(...schemaFields(field, `${trail}${name}.`));
  }
  return fields;
}

describe('объявление инструментов', () => {
  const tools = new LogTools().getTools();
  const toolNamed = (name: string) => tools.find((tool) => tool.name === name)!;

  it('объявлены хвост и поиск — и ничего сверх', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['ssh_log_tail', 'ssh_log_search']);
  });

  it('у каждого инструмента есть непустое описание и объект аргументов', () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect((tool.inputSchema as any).type, tool.name).toBe('object');
    }
  });

  it('у каждого поля объявлен тип, а объявленное описание не пустует', () => {
    for (const tool of tools) {
      for (const [name, field] of schemaFields(tool.inputSchema)) {
        expect(field.type ?? field.oneOf, `${tool.name}.${name}: тип`).toBeTruthy();
        if ('description' in field) {
          expect(field.description, `${tool.name}.${name}: описание`).toBeTruthy();
        }
        for (const variant of (field.oneOf ?? []) as any[]) {
          expect(variant.type, `${tool.name}.${name}: вариант`).toBeTruthy();
          if (variant.items) expect(variant.items.type, `${tool.name}.${name}[]`).toBeTruthy();
        }
      }
    }
  });

  it('хвосту обязателен только путь, а число строк по умолчанию — сто', () => {
    const schema = toolNamed('ssh_log_tail').inputSchema as any;
    expect(schema.required).toEqual(['path']);
    expect(Object.keys(schema.properties)).toEqual(['profile', 'path', 'lines', 'sudo']);
    expect(schema.properties.lines.default).toBe(100);
    expect(schema.properties.sudo.default).toBe(false);
  });

  it('поиску обязательны путь и запрос, а контекст и регистр по умолчанию выключены', () => {
    const schema = toolNamed('ssh_log_search').inputSchema as any;
    expect(schema.required).toEqual(['path', 'query']);
    expect(Object.keys(schema.properties)).toEqual([
      'profile',
      'path',
      'query',
      'context',
      'caseSensitive',
      'maxMatches',
      'sudo',
    ]);
    expect(schema.properties.context.default).toBe(0);
    expect(schema.properties.caseSensitive.default).toBe(false);
    expect(schema.properties.maxMatches.default).toBe(200);
    expect(schema.properties.sudo.default).toBe(false);
  });

  it('путь у обоих принимается и строкой, и списком', () => {
    for (const tool of tools) {
      expect((tool.inputSchema as any).properties.path.oneOf, tool.name).toEqual([
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ]);
    }
  });
});

describe('обращение к инструменту, которого нет', () => {
  it('называется своим именем, а не падает молча', async () => {
    expect(await textOf(call('ssh_log_rotate', { path: '/var/log/syslog' }))).toBe(
      'Error: Unknown tool: ssh_log_rotate'
    );
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('ssh_log_tail: один журнал', () => {
  it('без числа строк берётся сотня, а путь уезжает в кавычках', async () => {
    await tail({ path: '/var/log/syslog' });
    expect(commandFor(/^tail /)![0]).toBe("tail -n 100 '/var/log/syslog'");
  });

  it('заказанное число строк доезжает до команды и до заголовка сводки', async () => {
    expect(await tail({ path: '/var/log/syslog', lines: 2 })).toBe('ERROR disk full\nready\n');
    expect(commandFor(/^tail /)![0]).toBe("tail -n 2 '/var/log/syslog'");
  });

  it('число строки — тоже число, а команда с подвохом отклоняется до сервера', async () => {
    await tail({ path: '/var/log/syslog', lines: '50' });
    expect(commandFor(/^tail /)![0]).toBe("tail -n 50 '/var/log/syslog'");

    vi.clearAllMocks();
    expect(await tail({ path: '/var/log/syslog', lines: '5; reboot' })).toContain('lines');
    expect(sentCommands()).toHaveLength(0);
  });

  it('чтение помечено безопасным для повтора и идёт по запрошенному профилю', async () => {
    await tail({ path: '/var/log/syslog', profile: 'staging', sudo: true });
    const [, options] = commandFor(/^tail /)!;
    expect(options.idempotent).toBe(true);
    expect(options.profileName).toBe('staging');
    expect(options.sudo).toBe(true);
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

  it('без профиля работа идёт под именем default, и без sudo', async () => {
    await tail({ path: '/var/log/syslog' });
    const [, options] = commandFor(/^tail /)!;
    expect(options.profileName).toBe('default');
    expect(options.sudo).toBeFalsy();
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: undefined });
  });

  it('недоступный журнал объясняется текстом от сервера', async () => {
    expect(await tail({ path: '/var/log/missing.log' })).toBe(
      "Error: Failed to read log: tail: cannot open '/var/log/missing.log' for reading:" +
        ' No such file or directory'
    );
  });

  it('если сервер объяснился в stdout, ошибка берёт объяснение оттуда', async () => {
    overrides = [[/^tail /, { exitCode: 1, stderr: '', stdout: 'tail: permission denied' }]];
    expect(await tail({ path: '/var/log/syslog' })).toBe(
      'Error: Failed to read log: tail: permission denied'
    );
  });

  it('пустой журнал так и назван — иначе пустота читается как обрыв связи', async () => {
    logs.set('/var/log/syslog', []);
    expect(await tail({ path: '/var/log/syslog' })).toBe('(empty log)');
  });

  it('обрезанный хвост подписан, а содержимое остаётся на месте', async () => {
    overrides = [[/^tail /, { stdout: 'boot\n', truncated: true }]];
    expect(await tail({ path: '/var/log/syslog' })).toBe(`boot\n\n\n${TRUNCATED_OUTPUT_NOTE}`);
  });

  it('путь списком из одного читается как одиночный, без сводки', async () => {
    expect(await tail({ path: ['/var/log/syslog'], lines: 1 })).toBe('ready\n');
  });
});

describe('ssh_log_tail: несколько журналов', () => {
  const both = ['/var/log/syslog', '/var/log/nginx.log'];

  it('сводка печатается целиком: заголовок с числом строк и раздел на журнал', async () => {
    expect(await tail({ path: both, lines: 2 })).toBe(
      [
        'Tail 2 logs (last 2 lines):',
        '',
        '=== /var/log/syslog (2 lines) ===',
        'ERROR disk full',
        'ready',
        '',
        '=== /var/log/nginx.log (2 lines) ===',
        'error 500',
        'GET /about',
        '',
        '',
      ].join('\n')
    );
  });

  it('недоступный журнал помечен ошибкой, а соседний читается', async () => {
    expect(await tail({ path: ['/var/log/missing.log', '/var/log/nginx.log'], lines: 1 })).toBe(
      [
        'Tail 2 logs (last 1 lines):',
        '',
        '=== /var/log/missing.log (ERROR) ===',
        "Error: tail: cannot open '/var/log/missing.log' for reading: No such file or directory",
        '',
        '=== /var/log/nginx.log (1 lines) ===',
        'GET /about',
        '',
        '',
      ].join('\n')
    );
  });

  it('обрезанный журнал подписан у своего раздела, а не у всей сводки', async () => {
    overrides = [[/^tail .*syslog/, { stdout: 'boot\n', truncated: true }]];
    const text = await tail({ path: both, lines: 1 });
    expect(text).toContain(`=== /var/log/syslog (1 lines) ===\nboot\n${TRUNCATED_OUTPUT_NOTE}\n`);
    expect(text.split(TRUNCATED_OUTPUT_NOTE)).toHaveLength(2);
  });

  it('пустой журнал считается нулём строк, а не одной пустой', async () => {
    logs.set('/var/log/syslog', []);
    expect(await tail({ path: both, lines: 1 })).toContain('=== /var/log/syslog (0 lines) ===');
  });

  it('запрещённый путь останавливает не всю пачку — соседний журнал всё равно читается', async () => {
    const text = await tail({ path: ['~stranger/app.log', '/var/log/nginx.log'], lines: 1 });
    expect(text).toContain('=== ~stranger/app.log (ERROR) ===\n  Error: '.replace('  ', ''));
    expect(text).toContain('=== /var/log/nginx.log (1 lines) ===');
  });

  it('каждая команда пачки идёт по своему профилю и помечена безопасной для повтора', async () => {
    await tail({ path: both, profile: 'staging', sudo: true });
    const reads = sentCommands().filter(([command]) => command.startsWith('tail '));
    expect(reads).toHaveLength(2);
    for (const [, options] of reads) {
      expect(options.profileName).toBe('staging');
      expect(options.sudo).toBe(true);
      expect(options.idempotent).toBe(true);
    }
  });
});

describe('ssh_log_search: один журнал', () => {
  it('запрос уходит в кавычках, а флаги собираются в объявленном порядке', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR' });
    expect(commandFor(/^grep /)![0]).toBe("grep -E -i -n -m 201 'ERROR' '/var/log/syslog'");
  });

  it('поиск с учётом регистра идёт без -i', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR', caseSensitive: true });
    expect(commandFor(/^grep /)![0]).toBe("grep -E -n -m 201 'ERROR' '/var/log/syslog'");
  });

  it('контекст добавляется отдельным флагом, а нулевой не добавляется вовсе', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR', context: 1 });
    expect(commandFor(/^grep /)![0]).toBe("grep -E -i -C 1 -n -m 201 'ERROR' '/var/log/syslog'");

    vi.clearAllMocks();
    await search({ path: '/var/log/syslog', query: 'ERROR', context: 0 });
    expect(commandFor(/^grep /)![0]).toBe("grep -E -i -n -m 201 'ERROR' '/var/log/syslog'");
  });

  it('строки нумеруются, и контекст приходит вместе с совпадением', async () => {
    // Двоеточие у совпадения, дефис у соседей — так их разделяет сама grep
    expect(await search({ path: '/var/log/syslog', query: 'ERROR', context: 1 })).toBe(
      '1-boot\n2:ERROR disk full\n3-ready\n'
    );
  });

  it('регистр без просьбы не различается', async () => {
    expect(await search({ path: '/var/log/syslog', query: 'error' })).toBe('2:ERROR disk full\n');
  });

  it('отсутствие совпадений — это ответ, а не ошибка', async () => {
    expect(await search({ path: '/var/log/syslog', query: 'nothing-here' })).toBe(
      'No matches found'
    );
  });

  it('настоящая ошибка grep остаётся ошибкой', async () => {
    expect(await search({ path: '/var/log/missing.log', query: 'ERROR' })).toBe(
      'Error: Failed to search log: grep: /var/log/missing.log: No such file or directory'
    );
  });

  it('если сервер объяснился в stdout, ошибка берёт объяснение оттуда', async () => {
    overrides = [[/^grep /, { exitCode: 2, stderr: '', stdout: 'grep: permission denied' }]];
    expect(await search({ path: '/var/log/syslog', query: 'ERROR' })).toBe(
      'Error: Failed to search log: grep: permission denied'
    );
  });

  it('обрезанный результат подписан, а найденное остаётся на месте', async () => {
    overrides = [[/^grep /, { stdout: '2:ERROR disk full\n', truncated: true }]];
    expect(await search({ path: '/var/log/syslog', query: 'ERROR' })).toBe(
      `2:ERROR disk full\n\n\n${TRUNCATED_OUTPUT_NOTE}`
    );
  });

  it('выдача обрывается на пределе и подписана', async () => {
    logs.set('/var/log/big.log', Array.from({ length: 12 }, (_, n) => `error ${n + 1}`));

    const text = await search({ path: '/var/log/big.log', query: 'error', maxMatches: 3 });

    expect(text.split('\n').filter((line) => /^\d+:/.test(line))).toHaveLength(3);
    expect(text).toContain('Showing the first 3 matches');
  });

  it('совпадений ровно столько, сколько разрешено, — пометки нет', async () => {
    logs.set('/var/log/big.log', Array.from({ length: 3 }, (_, n) => `error ${n + 1}`));

    const text = await search({ path: '/var/log/big.log', query: 'error', maxMatches: 3 });

    expect(text.split('\n').filter((line) => /^\d+:/.test(line))).toHaveLength(3);
    expect(text).not.toContain('Showing the first');
  });

  it('строки контекста в предел не считаются', async () => {
    logs.set('/var/log/big.log', ['тихо', 'error 1', 'тихо', 'тихо', 'error 2', 'тихо']);

    const text = await search({
      path: '/var/log/big.log',
      query: 'error',
      context: 1,
      maxMatches: 2,
    });

    expect(text).toContain('2:error 1');
    expect(text).toContain('5:error 2');
    expect(text).not.toContain('Showing the first');
  });

  it('предел просят у самой grep, а не режут хвостом конвейера', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR', maxMatches: 7 });

    expect(commandFor(/^grep /)![0]).toContain('-m 8');
    expect(commandFor(/^grep /)![0]).not.toContain('head');
  });

  it('поиск помечен безопасным для повтора и идёт по запрошенному профилю', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR', profile: 'staging', sudo: true });
    const [, options] = commandFor(/^grep /)!;
    expect(options.idempotent).toBe(true);
    expect(options.profileName).toBe('staging');
    expect(options.sudo).toBe(true);
  });

  it('без профиля поиск идёт под именем default, и без sudo', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR' });
    const [, options] = commandFor(/^grep /)!;
    expect(options.profileName).toBe('default');
    expect(options.sudo).toBeFalsy();
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: undefined });
  });

  it('запрошенный профиль доезжает и до разбора настроек поиска', async () => {
    await search({ path: '/var/log/syslog', query: 'ERROR', profile: 'staging' });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

  it('число строк контекста с подвохом отклоняется до сервера', async () => {
    expect(
      await search({ path: '/var/log/syslog', query: 'ERROR', context: '2; reboot' })
    ).toContain('context');
    expect(sentCommands()).toHaveLength(0);
  });

  it('запрос обязателен и назван своим именем', async () => {
    expect(await search({ path: '/var/log/syslog' })).toBe(
      'Error: query must be a non-empty string like "error", got nothing'
    );
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('ssh_log_search: несколько журналов', () => {
  const both = ['/var/log/syslog', '/var/log/nginx.log'];

  it('сводка печатается целиком: запрос в заголовке и число совпадений на журнал', async () => {
    expect(await search({ path: both, query: 'error' })).toBe(
      [
        'Search in 2 logs (query: "error"):',
        '',
        '=== /var/log/syslog (1 matches) ===',
        '2:ERROR disk full',
        '',
        '',
        '=== /var/log/nginx.log (1 matches) ===',
        '2:error 500',
        '',
        '',
        '',
      ].join('\n')
    );
  });

  it('журнал без совпадений так и подписан, а не выглядит пустым разделом', async () => {
    const text = await search({ path: both, query: 'disk' });
    expect(text).toContain('=== /var/log/nginx.log (0 matches) ===\n(no matches)\n');
    expect(text).toContain('=== /var/log/syslog (1 matches) ===');
  });

  it('недоступный журнал помечен ошибкой, а соседний ищется', async () => {
    const text = await search({ path: ['/var/log/missing.log', '/var/log/nginx.log'], query: 'GET' });
    expect(text).toContain(
      '=== /var/log/missing.log (ERROR) ===\nError: grep: /var/log/missing.log:'
    );
    expect(text).toContain('=== /var/log/nginx.log (2 matches) ===');
  });

  it('обрезанный результат подписан у своего раздела', async () => {
    overrides = [[/^grep .*syslog/, { stdout: '2:ERROR disk full\n', truncated: true }]];
    const text = await search({ path: both, query: 'error' });
    expect(text).toContain(
      `=== /var/log/syslog (1 matches) ===\n2:ERROR disk full\n\n${TRUNCATED_OUTPUT_NOTE}\n`
    );
    expect(text.split(TRUNCATED_OUTPUT_NOTE)).toHaveLength(2);
  });

  it('каждая команда пачки собрана целиком и помечена безопасной для повтора', async () => {
    await search({ path: both, query: 'error', profile: 'staging', context: 2, sudo: true });
    const searches = sentCommands().filter(([command]) => command.startsWith('grep '));
    expect(searches.map(([command]) => command)).toEqual([
      "grep -E -i -C 2 -n -m 201 'error' '/var/log/syslog'",
      "grep -E -i -C 2 -n -m 201 'error' '/var/log/nginx.log'",
    ]);
    for (const [, options] of searches) {
      expect(options.profileName).toBe('staging');
      expect(options.sudo).toBe(true);
      expect(options.idempotent).toBe(true);
    }
  });

  it('предел считается на каждый журнал, и подписан тот, где он сработал', async () => {
    logs.set('/var/log/syslog', Array.from({ length: 6 }, (_, n) => `error ${n + 1}`));
    logs.set('/var/log/nginx.log', ['error once']);

    const text = await search({ path: both, query: 'error', maxMatches: 2 });

    expect(text).toContain('=== /var/log/syslog (2 matches) ===');
    expect(text).toContain('=== /var/log/nginx.log (1 matches) ===');
    expect(text.match(/Showing the first 2 matches/g)).toHaveLength(1);
  });
});

describe('форма ответа и отказы до первой команды', () => {
  const textPart = { type: 'text', text: expect.any(String) };

  it('текстом отвечают оба инструмента и все их пути', async () => {
    const both = ['/var/log/syslog', '/var/log/nginx.log'];
    expect(await responseOf(call('ssh_log_tail', { path: '/var/log/syslog' }))).toEqual({
      content: [textPart],
    });
    expect(await responseOf(call('ssh_log_tail', { path: both }))).toEqual({ content: [textPart] });
    expect(
      await responseOf(call('ssh_log_search', { path: '/var/log/syslog', query: 'ERROR' }))
    ).toEqual({ content: [textPart] });
    expect(await responseOf(call('ssh_log_search', { path: both, query: 'ERROR' }))).toEqual({
      content: [textPart],
    });
    expect(await responseOf(call('ssh_log_tail', { path: '/var/log/missing.log' }))).toEqual({
      content: [textPart],
    });
    expect(
      await responseOf(call('ssh_log_search', { path: '/var/log/syslog', query: 'nothing-here' }))
    ).toEqual({ content: [textPart] });
  });

  it('путь называет поле, значение и пример', async () => {
    expect(await tail({ path: 42 })).toBe(
      'Error: path must be a string like "/var/log/syslog" or an array of such strings, got 42'
    );
    expect(await search({ path: 42, query: 'ERROR' })).toBe(
      'Error: path must be a string like "/var/log/syslog" or an array of such strings, got 42'
    );
    expect(await search({ path: [], query: 'ERROR' })).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });

  it('строка, притворяющаяся списком, отклоняется до обращения к серверу', async () => {
    expect(await tail({ path: '["/var/log/syslog"]' })).toContain('path');
    expect(await search({ path: '["/var/log/syslog"]', query: 'ERROR' })).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('раскрытие пути и правила профиля', () => {
  beforeEach(() => logs.set('/home/deploy/app.log', ['started', 'ERROR boom']));

  it('тильда раскрывается у нас, а на сервер уезжает абсолютный путь', async () => {
    expect(await tail({ path: '~/app.log', lines: 1 })).toBe('ERROR boom\n');
    expect(commandFor(/^tail /)![0]).toBe("tail -n 1 '/home/deploy/app.log'");
  });

  it('поиск раскрывает тильду тем же способом', async () => {
    await search({ path: '~/app.log', query: 'ERROR' });
    expect(commandFor(/^grep /)![0]).toBe("grep -E -i -n -m 201 'ERROR' '/home/deploy/app.log'");
  });

  it('чужой домашний каталог — отказ, а не догадка', async () => {
    expect(await tail({ path: '~stranger/app.log' })).toMatch(/^Error: /);
    expect(commandFor(/^tail /)).toBeUndefined();
  });

  it('правила профиля проверяются под теми же правами и тем же профилем', async () => {
    profile.config = { ...profile.config, pathSecurity: { allowedPaths: ['/var/log'] } };
    await tail({ path: '/var/log/syslog', profile: 'staging', sudo: true });
    const [, options] = commandFor(/^p=/)!;
    expect(options.profileName).toBe('staging');
    expect(options.sudo).toBe(true);
  });

  it('запрещённый правилами журнал не читается вовсе', async () => {
    profile.config = { ...profile.config, pathSecurity: { deniedPaths: ['/var/log'] } };
    expect(await tail({ path: '/var/log/syslog' })).toMatch(/^Error: /);
    expect(commandFor(/^tail /)).toBeUndefined();
  });
});
