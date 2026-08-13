/**
 * Unit tests: что файловые инструменты говорят серверу и что отвечают человеку
 *
 * Три места, где ошибка не видна снаружи: команда чтения (`cat` против
 * `base64`), сводка по пачке файлов — единственное, что видит агент, — и
 * список файлов, где путь и шаблон собираются в одну строку. Сервер здесь не
 * заготовка: он ведёт своё дерево, отвечает по состоянию и отказывается
 * выполнять команду, которой не ждал.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

const { uploadMock, downloadMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ upload: uploadMock, download: downloadMock }),
}));

/** Профиль, с которым работает инструмент; правила путей ставит отдельный тест */
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

const { FileTools } = await import('../../src/tools/file-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

// ---------------------------------------------------------------------------
// Сервер: дерево путей, отвечающее по своему состоянию
// ---------------------------------------------------------------------------

type Node = { kind: 'file'; content: Buffer } | { kind: 'dir' };

/** Что лежит на сервере прямо сейчас */
let server: Map<string, Node>;
/** Ответы, которые сервер даёт вместо обычных: ключ — образец команды */
let overrides: Array<[RegExp, Partial<SSHExecuteResult>]>;

function putFile(path: string, content: string | Buffer): void {
  putDir(parentOf(path));
  server.set(path, { kind: 'file', content: Buffer.from(content as never) });
}

function putDir(path: string): void {
  for (let current = path; current && current !== '/'; current = parentOf(current)) {
    if (!server.has(current)) server.set(current, { kind: 'dir' });
  }
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '/';
}

function subtree(path: string): string[] {
  return [...server.keys()].filter((key) => key === path || key.startsWith(`${path}/`));
}

function childrenOf(path: string): string[] {
  return [...server.keys()].filter((key) => parentOf(key) === path);
}

function removeTree(path: string): void {
  for (const key of subtree(path)) server.delete(key);
}

function moveTree(from: string, to: string): void {
  for (const key of subtree(from)) {
    const node = server.get(key)!;
    server.delete(key);
    server.set(to + key.slice(from.length), node);
  }
}

const ok = (stdout = ''): SSHExecuteResult =>
  ({ stdout, stderr: '', exitCode: 0, truncated: false }) as SSHExecuteResult;

const fail = (stderr: string, exitCode = 1): SSHExecuteResult =>
  ({ stdout: '', stderr, exitCode, truncated: false }) as SSHExecuteResult;

/** Имена в командах закавычены нашим же shellQuote */
function quotedPaths(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Шаблон раскрывает сам сервер: обратный слэш перед знаком снимает с него смысл */
function globMatches(pattern: string, name: string): boolean {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      expression += pattern[++i]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`).test(name);
}

/**
 * Ответ сервера на команду.
 *
 * Неизвестная команда — отказ, а не успех: молчаливое «ок» на всё подряд
 * скрывает ровно то, ради чего эти тесты и написаны — потерянный кусок
 * команды или обращение не к тому пути.
 */
function answer(command: string, options?: SSHExecuteOptions): SSHExecuteResult {
  const override = overrides.find(([pattern]) => pattern.test(command));
  if (override) return { ...ok(), ...override[1] } as SSHExecuteResult;

  const paths = quotedPaths(command);

  if (command.startsWith('if [ -L ')) {
    const node = server.get(paths[0]);
    const kind = !node ? 'ABSENT' : node.kind === 'dir' ? 'DIR' : 'FILE';
    return ok(`SSH_MCP_KIND_${kind}\n`);
  }

  // Точка монтирования: у нас всё дерево на одном устройстве
  if (command.startsWith('stat -c %d')) return ok('2049 2049\n');

  // Куда ведёт путь: сервер без readlink отвечает «выяснить нечем»
  if (command.startsWith('p=')) return ok('SSH_MCP_PATH_UNRESOLVED\n');

  if (command.startsWith('mkdir -p')) {
    putDir(paths[0]);
    return ok();
  }

  if (command.startsWith('mv -T --')) {
    const [from, to] = paths;
    if (!server.has(from)) return fail(`mv: cannot stat '${from}': No such file or directory`);
    removeTree(to);
    moveTree(from, to);
    return ok();
  }

  if (command.startsWith('rm -rf --') || command.startsWith('rm -f ')) {
    removeTree(paths[0]);
    return ok();
  }

  if (command.startsWith('find ')) {
    const leftovers = childrenOf(paths[0]).filter((path) => /\/\.(upload|bak)-/.test(path));
    return ok(leftovers.length > 0 ? `${leftovers.join('\n')}\n` : '');
  }

  if (command.startsWith('sha256sum -- ')) {
    const lines = paths
      .map((path) => {
        const node = server.get(path);
        return node && node.kind === 'file' ? `${sha256Of(node.content)}  ${path}` : null;
      })
      .filter((line): line is string => line !== null);
    return lines.length === paths.length
      ? ok(`${lines.join('\n')}\n`)
      : ({
          stdout: lines.join('\n'),
          stderr: 'sha256sum: No such file or directory',
          exitCode: 1,
          truncated: false,
        } as SSHExecuteResult);
  }

  if (command.startsWith('test -e ') || command.startsWith('test -d ')) {
    const node = server.get(paths[0]);
    const present = command.startsWith('test -d ') ? node?.kind === 'dir' : !!node;
    return ok(present ? 'YES\n' : 'NO\n');
  }

  if (command.startsWith('chmod ')) {
    // Режим разбирает сама утилита: `chmod undefined` — отказ, а не тихий успех
    const mode = command.replace(/^chmod (-R )?/, '').split(' ')[0];
    if (!/^[0-7]{3,4}$/.test(mode)) return fail(`chmod: invalid mode: '${mode}'`);
    if (!server.has(paths[0])) return fail(`chmod: cannot access '${paths[0]}'`);
    return ok();
  }

  // Наполнение файла: содержимое приходит байтами на вход команды
  if (command.startsWith('cat > ')) {
    if (!server.has(parentOf(paths[0]))) {
      return fail(`sh: can't create ${paths[0]}: nonexistent directory`, 2);
    }
    putFile(paths[0], (options?.stdin ?? '') as Buffer);
    return ok();
  }

  if (command.startsWith('cp -- ')) {
    const [from, to] = paths;
    const node = server.get(from);
    if (!node || node.kind !== 'file') return fail(`cp: cannot stat '${from}'`);
    server.set(to, node);
    return ok();
  }

  if (command.startsWith('cat ') || command.startsWith('base64 ')) {
    const node = server.get(paths[0]);
    const utility = command.startsWith('cat ') ? 'cat' : 'base64';
    if (!node) return fail(`${utility}: ${paths[0]}: No such file or directory`);
    if (node.kind === 'dir') return fail(`${utility}: ${paths[0]}: Is a directory`);
    return ok(utility === 'cat' ? node.content.toString('utf8') : node.content.toString('base64'));
  }

  if (command.startsWith('ls -l')) {
    const directory = paths[0];
    if (!server.has(directory)) return fail(`ls: ${directory}: No such file or directory`, 2);
    const names = childrenOf(directory).map((path) => path.slice(directory.length + 1));
    const pattern = command.slice(command.lastIndexOf("'") + 1).replace(/^\//, '');
    const shown = pattern ? names.filter((name) => globMatches(pattern, name)) : names;
    if (pattern && shown.length === 0) {
      return fail(`ls: ${directory}/${pattern}: No such file or directory`, 2);
    }
    return ok(`${shown.map((name) => `-rw-r--r-- 1 deploy deploy 12 Aug  8 01:00 ${name}`).join('\n')}\n`);
  }

  throw new Error(`the server was not asked to run this: ${command}`);
}

/** Сервер с обычным набором утилит */
function fullPassport(overridden: Record<string, unknown> = {}) {
  return {
    ...UNKNOWN_PASSPORT,
    known: true,
    sha256: 'sha256sum',
    coreutils: 'coreutils',
    home: '/home/deploy',
    ...overridden,
  };
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

async function textOf(request: CallToolRequest): Promise<string> {
  const response = await new FileTools().handleCall(request);
  return response.content[0].text as string;
}

const responseOf = (request: CallToolRequest) => new FileTools().handleCall(request);

const read = (args: Record<string, unknown>) => textOf(call('ssh_file_read', args));
const write = (args: Record<string, unknown>) => textOf(call('ssh_file_write', args));
const list = (args: Record<string, unknown>) => textOf(call('ssh_file_list', args));

/** Команды, ушедшие на сервер, вместе с их параметрами */
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
  server = new Map<string, Node>([['/', { kind: 'dir' }]]);
  putDir('/etc');
  putDir('/srv');
  putDir('/tmp');
  putDir('/var/log');
  putDir('/home/deploy');
  overrides = [];
  profile.config = { host: 'example.com', username: 'deploy', port: 22 };

  executeMock.mockImplementation(
    async (_config: unknown, command: string, options?: SSHExecuteOptions) =>
      answer(command, options)
  );
  passportMock.mockResolvedValue(fullPassport());

  uploadMock.mockImplementation(async (source: string, target: string) => {
    putFile(target, readFileSync(source));
  });
  downloadMock.mockImplementation(async (source: string, target: string) => {
    const node = server.get(source);
    if (!node || node.kind !== 'file') throw new Error(`scp: ${source}: No such file or directory`);
    writeFileSync(target, node.content);
  });
});

/** Все поля схемы, включая вложенные в список записей и в варианты oneOf */
function schemaFields(node: any, trail = ''): Array<[string, any]> {
  const fields: Array<[string, any]> = [];
  for (const [name, field] of Object.entries((node?.properties ?? {}) as Record<string, any>)) {
    fields.push([`${trail}${name}`, field]);
    fields.push(...schemaFields(field, `${trail}${name}.`));
    fields.push(...schemaFields(field.items, `${trail}${name}[].`));
    for (const variant of field.oneOf ?? []) {
      fields.push(...schemaFields(variant, `${trail}${name}.`));
      fields.push(...schemaFields(variant.items, `${trail}${name}[].`));
    }
  }
  return fields;
}

describe('объявление инструментов', () => {
  const tools = new FileTools().getTools();
  const toolNamed = (name: string) => tools.find((tool) => tool.name === name)!;

  it('у каждого инструмента есть непустое описание — по нему его и выбирают', () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect((tool.inputSchema as any).type, tool.name).toBe('object');
    }
  });

  it('у каждого варианта «строка или список» тоже объявлен свой тип', () => {
    for (const tool of tools) {
      for (const [name, field] of schemaFields(tool.inputSchema)) {
        for (const variant of (field.oneOf ?? []) as any[]) {
          expect(variant.type, `${tool.name}.${name}: вариант`).toBeTruthy();
          if (variant.items) expect(variant.items.type, `${tool.name}.${name}[]`).toBeTruthy();
        }
      }
    }
  });

  it('у каждого поля объявлен тип, а объявленное описание не пустует', () => {
    for (const tool of tools) {
      for (const [name, field] of schemaFields(tool.inputSchema)) {
        expect(field.type ?? field.oneOf, `${tool.name}.${name}: тип`).toBeTruthy();
        if ('description' in field) {
          expect(field.description, `${tool.name}.${name}: описание`).toBeTruthy();
        }
      }
    }
  });

  it('объявлены чтение, запись и список — и ничего сверх', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'ssh_file_read',
      'ssh_file_write',
      'ssh_file_list',
    ]);
  });

  it('чтение требует только путь, а профиль остаётся необязательным', () => {
    const schema = toolNamed('ssh_file_read').inputSchema as any;
    expect(schema.required).toEqual(['path']);
    expect(Object.keys(schema.properties)).toEqual([
      'profile',
      'path',
      'encoding',
      'binary',
      'sudo',
    ]);
  });

  it('путь для чтения принимается и строкой, и списком', () => {
    const schema = toolNamed('ssh_file_read').inputSchema as any;
    expect(schema.properties.path.oneOf).toEqual([
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ]);
  });

  it('кодировка ограничена двумя значениями, по умолчанию utf8', () => {
    const encoding = (toolNamed('ssh_file_read').inputSchema as any).properties.encoding;
    expect(encoding.enum).toEqual(['utf8', 'base64']);
    expect(encoding.default).toBe('utf8');
  });

  it('двоичное чтение и sudo по умолчанию выключены', () => {
    const properties = (toolNamed('ssh_file_read').inputSchema as any).properties;
    expect(properties.binary.default).toBe(false);
    expect(properties.sudo.default).toBe(false);
  });

  it('запись требует files, а у каждой записи обязательны путь и содержимое', () => {
    const schema = toolNamed('ssh_file_write').inputSchema as any;
    expect(schema.required).toEqual(['files']);
    const [single, many] = schema.properties.files.oneOf;
    expect(single.required).toEqual(['path', 'content']);
    expect(many.items.required).toEqual(['path', 'content']);
  });

  it('у записи объявлены все флаги, которые инструмент умеет читать', () => {
    const [single, many] = (toolNamed('ssh_file_write').inputSchema as any).properties.files.oneOf;
    const flags = ['path', 'content', 'mode', 'sudo', 'verify', 'atomic', 'binary'];
    expect(Object.keys(single.properties)).toEqual(flags);
    expect(Object.keys(many.items.properties)).toEqual(flags);
  });

  it('список требует путь, а шаблон и рекурсию — нет', () => {
    const schema = toolNamed('ssh_file_list').inputSchema as any;
    expect(schema.required).toEqual(['path']);
    expect(schema.properties.recursive.default).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['profile', 'path', 'pattern', 'recursive']);
  });
});

describe('обращение к инструменту, которого нет', () => {
  it('называется своим именем, а не падает молча', async () => {
    expect(await textOf(call('ssh_file_delete', { path: '/etc/hosts' }))).toBe(
      'Error: Unknown tool: ssh_file_delete'
    );
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('ssh_file_read: одиночный файл', () => {
  beforeEach(() => putFile('/etc/hosts', '127.0.0.1 localhost\n'));

  it('содержимое отдаётся как есть, без единого лишнего знака', async () => {
    expect(await read({ path: '/etc/hosts' })).toBe('127.0.0.1 localhost\n');
  });

  it('текст читается `cat`, а base64 — своей утилитой', async () => {
    await read({ path: '/etc/hosts' });
    expect(commandFor(/hosts/)![0]).toBe("cat '/etc/hosts'");

    vi.clearAllMocks();
    const text = await read({ path: '/etc/hosts', encoding: 'base64' });
    expect(commandFor(/hosts/)![0]).toBe("base64 '/etc/hosts'");
    expect(Buffer.from(text, 'base64').toString('utf8')).toBe('127.0.0.1 localhost\n');
  });

  it('неизвестная кодировка читается как текст, а не превращается в base64', async () => {
    await read({ path: '/etc/hosts', encoding: 'latin1' });
    expect(commandFor(/hosts/)![0]).toBe("cat '/etc/hosts'");
  });

  it('чтение помечено безопасным для повтора и идёт по запрошенному профилю', async () => {
    await read({ path: '/etc/hosts', profile: 'staging', sudo: true });
    const [, options] = commandFor(/hosts/)!;
    expect(options.idempotent).toBe(true);
    expect(options.profileName).toBe('staging');
    expect(options.sudo).toBe(true);
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

  it('без профиля работа идёт под именем default, а не под пустым', async () => {
    await read({ path: '/etc/hosts' });
    expect(commandFor(/hosts/)![1].profileName).toBe('default');
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: undefined });
  });

  it('без просьбы о sudo команда уходит без него', async () => {
    await read({ path: '/etc/hosts' });
    expect(commandFor(/hosts/)![1].sudo).toBeFalsy();
  });

  it('отсутствующий файл — ошибка с текстом от сервера, а не пустое содержимое', async () => {
    expect(await read({ path: '/etc/missing.conf' })).toBe(
      'Error: Failed to read file: cat: /etc/missing.conf: No such file or directory'
    );
  });

  it('если сервер объяснился в stdout, ошибка берёт объяснение оттуда', async () => {
    overrides = [[/^cat /, { exitCode: 1, stderr: '', stdout: 'permission denied' }]];
    expect(await read({ path: '/etc/hosts' })).toBe('Error: Failed to read file: permission denied');
  });

  it('путь списком из одного файла читается как одиночный, без сводки', async () => {
    expect(await read({ path: ['/etc/hosts'] })).toBe('127.0.0.1 localhost\n');
  });

  it('пустой список путей — отказ, а не «прочитано ноль файлов»', async () => {
    expect(await read({ path: [] })).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });

  it('строка, притворяющаяся списком, отклоняется до обращения к серверу', async () => {
    const text = await read({ path: '["/etc/hosts", "/etc/fstab"]' });
    expect(text).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('ssh_file_read: пачка файлов', () => {
  beforeEach(() => {
    putFile('/etc/hosts', '127.0.0.1 localhost\n');
    putFile('/etc/motd', 'welcome\n');
  });

  it('сводка печатается целиком: заголовок, размеры и разделитель', async () => {
    expect(await read({ path: ['/etc/hosts', '/etc/motd'] })).toBe(
      [
        'Read 2 files:',
        '',
        '✓ /etc/hosts (20 bytes)',
        '─'.repeat(60),
        '127.0.0.1 localhost',
        '',
        '',
        '✓ /etc/motd (8 bytes)',
        '─'.repeat(60),
        'welcome',
        '',
        '',
        '',
      ].join('\n')
    );
  });

  it('размер считается в байтах, а не в знаках', async () => {
    putFile('/etc/motd', 'привет\n');
    expect(await read({ path: ['/etc/hosts', '/etc/motd'] })).toContain('/etc/motd (13 bytes)');
  });

  it('нечитаемый файл помечен крестом, а остальные читаются', async () => {
    expect(await read({ path: ['/etc/missing.conf', '/etc/motd'] })).toBe(
      [
        'Read 2 files:',
        '',
        '✗ /etc/missing.conf',
        '  Error: cat: /etc/missing.conf: No such file or directory',
        '',
        '✓ /etc/motd (8 bytes)',
        '─'.repeat(60),
        'welcome',
        '',
        '',
        '',
      ].join('\n')
    );
  });

  it('сорвавшееся чтение объясняется своей ошибкой, а не общим отказом', async () => {
    downloadMock.mockRejectedValueOnce(new Error('scp: connection closed'));
    const text = await read({ path: ['/etc/hosts', '/etc/motd'], binary: true });
    expect(text).toContain('✗ /etc/hosts\n  Error: scp: connection closed');
    expect(text).toContain('✓ /etc/motd');
  });

  it('двоичное чтение отдаёт base64, а размер считает по исходным байтам', async () => {
    putFile('/etc/hosts', Buffer.from([0x00, 0xff, 0x10]));
    const text = await read({ path: ['/etc/hosts', '/etc/motd'], binary: true });
    expect(text).toContain('✓ /etc/hosts (3 bytes)');
    expect(text).toContain(Buffer.from([0x00, 0xff, 0x10]).toString('base64'));
  });

  it('под sudo пачка читается с sudo у каждой команды', async () => {
    await read({ path: ['/etc/hosts', '/etc/motd'], sudo: true });
    expect(sentCommands().filter(([command]) => command.startsWith('cat '))).toHaveLength(2);
    for (const [, options] of sentCommands().filter(([command]) => command.startsWith('cat '))) {
      expect(options.sudo).toBe(true);
    }
  });

  it('каждое чтение пачки помечено безопасным для повтора и идёт по своему профилю', async () => {
    await read({ path: ['/etc/hosts', '/etc/motd'], profile: 'staging' });
    const reads = sentCommands().filter(([command]) => command.startsWith('cat '));
    expect(reads).toHaveLength(2);
    for (const [, options] of reads) {
      expect(options.idempotent).toBe(true);
      expect(options.profileName).toBe('staging');
    }
  });

  it('обрезанное содержимое в пачке помечено неудачей и нулевым размером', async () => {
    overrides = [[/^cat .*hosts/, { stdout: '127.0.0.1 loc', truncated: true }]];
    const text = await read({ path: ['/etc/hosts', '/etc/motd'] });
    expect(text).toContain('✗ /etc/hosts\n  Error: ');
    expect(text).not.toContain('127.0.0.1 loc');
    expect(text).toContain('✓ /etc/motd (8 bytes)');
  });

  it('оборванное чтение с ненулевым кодом остаётся ошибкой сервера, а не обрезкой', async () => {
    overrides = [
      [/^cat .*hosts/, { exitCode: 1, stderr: 'cat: read error', stdout: '', truncated: true }],
    ];
    const text = await read({ path: ['/etc/hosts', '/etc/motd'] });
    expect(text).toContain('✗ /etc/hosts\n  Error: cat: read error');
  });

  it('пачка читается base64, если так попросили', async () => {
    await read({ path: ['/etc/hosts', '/etc/motd'], encoding: 'base64' });
    expect(sentCommands().filter(([command]) => command.startsWith('base64 '))).toHaveLength(2);
  });

  it('запрещённый путь останавливает всю пачку до первого чтения', async () => {
    const text = await read({ path: ['/etc/hosts', '~stranger/notes.txt'] });
    expect(text).toMatch(/^Error: /);
    expect(commandFor(/^cat /)).toBeUndefined();
  });
});

describe('ssh_file_write: одиночный файл', () => {
  it('в ответе стоит путь, по которому файл действительно оказался', async () => {
    const text = await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(text).toBe('File written successfully: /etc/app.conf');
    expect((server.get('/etc/app.conf') as { content: Buffer }).content.toString()).toBe(
      'key=value\n'
    );
  });

  it('раскрытая тильда попадает и в путь ответа, и в предупреждение', async () => {
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n' } });
    expect(text).toMatch(/^File written successfully: \/home\/deploy\/notes\.txt/);
  });

  it('несовпадение хэша называет и путь, и то, с чем не сошлось', async () => {
    overrides = [[/^sha256sum /, { stdout: `${'0'.repeat(64)}  x\n` }]];
    const expected = createHash('sha256').update('key=value\n').digest('hex');
    expect(
      await write({ files: { path: '/etc/app.conf', content: 'key=value\n', verify: true } })
    ).toBe(`Error: verification failed for /etc/app.conf: local=${expected}, remote differs`);
  });

  it('сервер без счётчика хэшей не превращает исправную запись в ошибку', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const answer = await write({
      files: { path: '/etc/app.conf', content: 'key=value\n', verify: true },
    });

    expect(answer).toContain('File written successfully: /etc/app.conf');
    expect(server.has('/etc/app.conf')).toBe(true);
  });

  /**
   * Три исхода сверки различимы по самому ответу: клиент видит только его,
   * а «сверить было нечем» уходило одной строкой в журнал сервера.
   */
  it('сошедшийся хэш назван в ответе', async () => {
    expect(
      await write({ files: { path: '/etc/app.conf', content: 'key=value\n', verify: true } })
    ).toBe('File written successfully: /etc/app.conf (sha256 verified)');
  });

  it('«сверить нечем» отличается от «сошлось»', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const answer = await write({
      files: { path: '/etc/app.conf', content: 'key=value\n', verify: true },
    });

    expect(answer).toContain('NOT verified');
    expect(answer).not.toContain('sha256 verified');
  });

  it('без флага verify про сверку не говорится вовсе', async () => {
    expect(await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } })).toBe(
      'File written successfully: /etc/app.conf'
    );
  });

  it('в сводке по пачке исход сверки стоит у каждой записи', async () => {
    const answer = await write({
      files: [
        { path: '/etc/a.conf', content: 'a\n', verify: true },
        { path: '/etc/b.conf', content: 'b\n' },
      ],
    });

    expect(answer).toContain('✓ /etc/a.conf (2 bytes) (sha256 verified)');
    expect(answer).toContain('✓ /etc/b.conf (2 bytes)\n');
  });

  it('без флага verify сервер о хэшах не спрашивают вовсе', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(commandFor(/^sha256sum /)).toBeUndefined();
  });

  it('пустой список файлов — отказ, а не «записано ноль файлов»', async () => {
    expect(await write({ files: [] })).toContain('files');
    expect(commandFor(/^cat > /)).toBeUndefined();
  });
});

describe('ssh_file_write: пачка файлов', () => {
  it('сводка печатается целиком, с размером каждой записи', async () => {
    expect(
      await write({
        files: [
          { path: '/etc/app.conf', content: 'key=value\n' },
          { path: '/srv/app.js', content: 'run();' },
        ],
      })
    ).toBe(
      ['Write 2 files:', '', '✓ /etc/app.conf (10 bytes)', '✓ /srv/app.js (6 bytes)', ''].join('\n')
    );
  });

  it('размер двоичной записи считается по декодированным байтам', async () => {
    const text = await write({
      files: [
        { path: '/etc/app.conf', content: 'key=value\n' },
        { path: '/srv/app.bin', content: Buffer.from([1, 2, 3, 4]).toString('base64'), binary: true },
      ],
    });
    expect(text).toContain('✓ /srv/app.bin (4 bytes)');
  });

  it('неудача одного файла не отменяет остальные и печатается с его путём', async () => {
    overrides = [[/^cat > .*app\.conf/, { exitCode: 1, stderr: 'cat: write error: No space left' }]];
    const text = await write({
      files: [
        { path: '/etc/app.conf', content: 'key=value\n' },
        { path: '/srv/app.js', content: 'run();' },
      ],
    });
    expect(text).toMatch(/^Write 2 files:/);
    expect(text).toContain('✗ /etc/app.conf\n  Error:');
    expect(text).toContain('✓ /srv/app.js (6 bytes)');
    expect(server.has('/srv/app.js')).toBe(true);
  });

  it('предупреждение печатается под своей записью, с отступом', async () => {
    const text = await write({
      files: [
        { path: '~/notes.txt', content: 'hi\n', sudo: true },
        { path: '/srv/app.js', content: 'run();' },
      ],
    });
    expect(text).toContain('✓ /home/deploy/notes.txt (3 bytes)\n  ⚠ ');
  });

  it('запрещённый путь останавливает пачку до первой записи', async () => {
    const text = await write({
      files: [
        { path: '/srv/app.js', content: 'run();' },
        { path: '~stranger/notes.txt', content: 'hi\n' },
      ],
    });
    expect(text).toMatch(/^Error: /);
    expect(commandFor(/^cat > /)).toBeUndefined();
    expect(server.has('/srv/app.js')).toBe(false);
  });
});

describe('ssh_file_list', () => {
  beforeEach(() => {
    putFile('/var/log/nginx.log', 'GET /\n');
    putFile('/var/log/syslog', 'boot\n');
  });

  it('обычный список идёт одной командой и печатается как пришёл', async () => {
    const text = await list({ path: '/var/log' });
    expect(commandFor(/^ls /)![0]).toBe("ls -lah '/var/log'");
    expect(text).toContain('nginx.log');
    expect(text).toContain('syslog');
  });

  it('рекурсивный обход просит у сервера другой набор флагов', async () => {
    await list({ path: '/var/log', recursive: true });
    expect(commandFor(/^ls /)![0]).toBe("ls -lRah '/var/log'");
  });

  it('шаблон приклеивается к пути и остаётся рабочим', async () => {
    const text = await list({ path: '/var/log', pattern: '*.log' });
    expect(commandFor(/^ls /)![0]).toBe("ls -lah '/var/log'/*.log");
    expect(text).toContain('nginx.log');
    expect(text).not.toContain('syslog');
  });

  it('список помечен безопасным для повтора и идёт по запрошенному профилю', async () => {
    await list({ path: '/var/log', profile: 'staging' });
    const [, options] = commandFor(/^ls /)!;
    expect(options.idempotent).toBe(true);
    expect(options.profileName).toBe('staging');
  });

  it('без профиля список идёт под именем default, а не под пустым', async () => {
    await list({ path: '/var/log' });
    expect(commandFor(/^ls /)![1].profileName).toBe('default');
  });

  it('несуществующий каталог — ошибка с текстом от сервера', async () => {
    expect(await list({ path: '/var/nowhere' })).toBe(
      'Error: Failed to list files: ls: /var/nowhere: No such file or directory'
    );
  });

  it('если сервер объяснился в stdout, ошибка берёт объяснение оттуда', async () => {
    overrides = [[/^ls /, { exitCode: 2, stderr: '', stdout: 'ls: permission denied' }]];
    expect(await list({ path: '/var/log' })).toBe(
      'Error: Failed to list files: ls: permission denied'
    );
  });

  it('обрезанный список подписан, а не выдан за полный', async () => {
    overrides = [[/^ls /, { stdout: 'nginx.log\n', truncated: true }]];
    const text = await list({ path: '/var/log' });
    expect(text).toContain('nginx.log');
    expect(text.length).toBeGreaterThan('nginx.log\n'.length);
  });

  it('пустой путь — отказ до обращения к серверу', async () => {
    expect(await list({ path: '   ' })).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });

  it('команда внутри шаблона обезврежена, а сам шаблон остаётся шаблоном', async () => {
    await list({ path: '/var/log', pattern: '$(reboot)*.log' });
    expect(commandFor(/^ls /)![0]).toBe("ls -lah '/var/log'/\\$\\(reboot\\)*.log");
  });

  it('шаблон, который команду не переживёт, назван своим именем', async () => {
    const text = await list({ path: '/var/log', pattern: '*.log\nreboot' });
    expect(text).toContain('pattern');
    expect(commandFor(/^ls /)).toBeUndefined();
  });

  it('профиль доезжает и до разбора настроек списка', async () => {
    await list({ path: '/var/log', profile: 'staging' });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });
});

/**
 * Ответ инструмента читает агент, и читает он его как текст. Кусок с пустым
 * типом до него доедет молча — на любом из путей, включая отказ.
 */
describe('форма ответа', () => {
  beforeEach(() => {
    putFile('/etc/hosts', '127.0.0.1 localhost\n');
    putFile('/etc/motd', 'welcome\n');
  });

  const textPart = { type: 'text', text: expect.any(String) };

  it('текстом отвечают все три инструмента и все их пути', async () => {
    expect(await responseOf(call('ssh_file_read', { path: '/etc/hosts' }))).toEqual({
      content: [textPart],
    });
    expect(
      await responseOf(call('ssh_file_read', { path: ['/etc/hosts', '/etc/motd'] }))
    ).toEqual({ content: [textPart] });
    expect(await responseOf(call('ssh_file_read', { path: '/etc/hosts', binary: true }))).toEqual({
      content: [textPart],
    });
    expect(
      await responseOf(call('ssh_file_write', { files: { path: '/srv/a.js', content: 'a' } }))
    ).toEqual({ content: [textPart] });
    expect(
      await responseOf(
        call('ssh_file_write', {
          files: [
            { path: '/srv/b.js', content: 'b' },
            { path: '/srv/c.js', content: 'c' },
          ],
        })
      )
    ).toEqual({ content: [textPart] });
    expect(await responseOf(call('ssh_file_list', { path: '/etc' }))).toEqual({
      content: [textPart],
    });
    expect(await responseOf(call('ssh_file_read', { path: '/etc/nothing' }))).toEqual({
      content: [textPart],
    });
  });

  it('отказ до первой команды называет поле, значение и пример', async () => {
    expect(await read({ path: 42 })).toBe(
      'Error: path must be a string like "/etc/hosts" or an array of such strings, got 42'
    );
    expect(await write({ files: [{ path: '/srv/a.js' }] })).toBe(
      'Error: files[0].content must be a string, got nothing'
    );
    expect(await write({ files: 42 })).toContain('{"path": "/etc/app.conf", "content": "..."}');
    expect(await list({ path: 42 })).toBe(
      'Error: path must be a non-empty string like "/var/log", got 42'
    );
  });
});

describe('ssh_file_write: что именно уезжает на сервер', () => {
  /** Ровно на границе содержимое ещё идёт байтами в канале команды */
  const INLINE_LIMIT = 256 * 1024;

  it('содержимое на границе едет в stdin, а первый лишний байт — транспортом', async () => {
    await write({ files: { path: '/srv/edge.bin', content: 'x'.repeat(INLINE_LIMIT) } });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(commandFor(/^cat > /)![1].stdin).toHaveLength(INLINE_LIMIT);

    vi.clearAllMocks();
    await write({ files: { path: '/srv/over.bin', content: 'x'.repeat(INLINE_LIMIT + 1) } });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(commandFor(/^cat > /)).toBeUndefined();
  });

  it('права ставятся по временному пути одной командой, до замены', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n', mode: '640' } });
    const [command, options] = commandFor(/^chmod /)!;
    const staging = quotedPaths(command)[0];
    expect(command).toBe(`chmod 640 -- '${staging}'`);
    expect(options.profileName).toBe('default');
    expect(staging).toMatch(/^\/etc\/\.upload-[0-9a-f]+\.app\.conf$/);
    expect(sentCommands().findIndex(([c]) => c.startsWith('chmod '))).toBeLessThan(
      sentCommands().findIndex(([c]) => c.startsWith('mv -T'))
    );
  });

  it('пустое содержимое даёт пустой файл, а не ошибку и не выдумку', async () => {
    const text = await write({
      files: [
        { path: '/srv/empty.txt', content: '' },
        { path: '/srv/empty.bin', content: '', binary: true },
      ],
    });
    expect(text).toContain('✓ /srv/empty.txt (0 bytes)');
    expect(text).toContain('✓ /srv/empty.bin (0 bytes)');
    expect((server.get('/srv/empty.txt') as { content: Buffer }).content).toHaveLength(0);
    expect((server.get('/srv/empty.bin') as { content: Buffer }).content).toHaveLength(0);
  });

  it('без прав команда chmod не отправляется вовсе', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(commandFor(/^chmod /)).toBeUndefined();
  });

  it('сверка идёт по временному пути и с теми же правами, что и запись', async () => {
    await write({
      files: { path: '/etc/app.conf', content: 'key=value\n', verify: true, sudo: true },
    });
    const [command, options] = commandFor(/^sha256sum /)!;
    expect(quotedPaths(command)[0]).toMatch(/^\/etc\/\.upload-[0-9a-f]+\.app\.conf$/);
    expect(options.sudo).toBe(true);
    expect(options.profileName).toBe('default');
  });

  it('крупная запись под sudo идёт в /tmp, оттуда копией, и след за собой убирает', async () => {
    await write({
      files: { path: '/etc/big.conf', content: 'x'.repeat(300 * 1024), sudo: true },
    });

    const handoff = uploadMock.mock.calls[0][1] as string;
    expect(handoff).toMatch(/^\/tmp\/\.ssh-mcp-upload-[0-9a-f]{16}$/);

    const [copy, copyOptions] = commandFor(/^cp /)!;
    const staging = quotedPaths(copy)[1];
    expect(copy).toBe(`cp -- '${handoff}' '${staging}'`);
    expect(copyOptions.sudo).toBe(true);

    const [remove, removeOptions] = commandFor(/^rm -f /)!;
    expect(remove).toBe(`rm -f -- '${handoff}'`);
    expect(removeOptions.profileName).toBe('default');
    expect(server.has(handoff)).toBe(false);
  });

  it('права под sudo ставит тот же, кто пишет файл', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'a', mode: '600', sudo: true } });
    expect(commandFor(/^chmod /)![1].sudo).toBe(true);
  });

  it('профиль записи доезжает и до настроек, и до каждой команды', async () => {
    await write({ profile: 'staging', files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
    for (const [, options] of sentCommands()) expect(options.profileName).toBe('staging');
  });

  it('без профиля запись идёт под именем default, а не под пустым', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    for (const [, options] of sentCommands()) expect(options.profileName).toBe('default');
  });

  it('sudo объявляется только тем файлом, который его просил', async () => {
    await write({
      files: [
        { path: '/etc/root.conf', content: 'a', sudo: true },
        { path: '/srv/user.js', content: 'b' },
      ],
    });
    expect(commandFor(/^cat > .*root\.conf/)![1].sudo).toBe(true);
    expect(commandFor(/^cat > .*user\.js/)![1].sudo).toBeFalsy();
  });

  it('размер текстовой записи считается в байтах, а не в знаках', async () => {
    const text = await write({
      files: [
        { path: '/srv/ru.txt', content: 'привет' },
        { path: '/srv/en.txt', content: 'hello' },
      ],
    });
    expect(text).toContain('✓ /srv/ru.txt (12 bytes)');
    expect(text).toContain('✓ /srv/en.txt (5 bytes)');
  });

  it('второе предупреждение печатается со своей строки, а не приклеивается к первому', async () => {
    putFile('/home/deploy/.upload-deadbeef.notes.txt', 'обломок прошлой попытки');
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n', sudo: true } });
    const notes = text.split('\n⚠ ');
    expect(notes).toHaveLength(3);
    expect(notes[0]).toBe('File written successfully: /home/deploy/notes.txt');
    expect(notes[1]).toBe(
      '"~/notes.txt" points at /home/deploy/notes.txt — the home of the login user,' +
        " not root's. Pass an absolute path if you meant a different directory."
    );
    expect(notes[2]).toContain('.upload-deadbeef.notes.txt');
  });

  it('предупреждение в одиночном ответе печатается со своей строки', async () => {
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n', sudo: true } });
    expect(text).toBe(
      'File written successfully: /home/deploy/notes.txt\n⚠ "~/notes.txt" points at' +
        ' /home/deploy/notes.txt — the home of the login user, not root\'s.' +
        ' Pass an absolute path if you meant a different directory.'
    );
  });
});

describe('раскрытие пути идёт с теми же правами и под тем же профилем', () => {
  beforeEach(() => {
    putFile('/etc/hosts', '127.0.0.1 localhost\n');
    profile.config = { ...profile.config, pathSecurity: { allowedPaths: ['/etc', '/var'] } };
  });

  it('под sudo правила проверяются от имени root, а не пользователя', async () => {
    await read({ path: '/etc/hosts', sudo: true, profile: 'staging' });
    const [, options] = commandFor(/^p=/)!;
    expect(options.sudo).toBe(true);
    expect(options.profileName).toBe('staging');
  });

  it('список проверяет правила по своему профилю', async () => {
    await list({ path: '/var/log', profile: 'staging' });
    expect(commandFor(/^p=/)![1].profileName).toBe('staging');
  });

  it('без просьбы о sudo правила проверяются от имени пользователя', async () => {
    await read({ path: '/etc/hosts' });
    expect(commandFor(/^p=/)![1].sudo).toBeFalsy();
  });

  it('запись без sudo не жалуется на чужой домашний каталог', async () => {
    profile.config = { host: 'example.com', username: 'deploy', port: 22 };
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n' } });
    expect(text).toBe('File written successfully: /home/deploy/notes.txt');
  });
});

describe('ssh_file_read: двоичное чтение', () => {
  const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x10]);

  beforeEach(() => putFile('/srv/app.bin', bytes));

  it('отдаёт ровно base64 файла, без переводов строки и обёрток', async () => {
    expect(await read({ path: '/srv/app.bin', binary: true })).toBe(bytes.toString('base64'));
  });

  it('идёт транспортом, а не командой чтения', async () => {
    await read({ path: '/srv/app.bin', binary: true });
    expect(downloadMock.mock.calls[0][0]).toBe('/srv/app.bin');
    expect(commandFor(/^cat |^base64 /)).toBeUndefined();
  });

  it('заказанная кодировка двоичному чтению не мешает', async () => {
    expect(await read({ path: '/srv/app.bin', binary: true, encoding: 'utf8' })).toBe(
      bytes.toString('base64')
    );
  });

  it('локальный временный каталог не остаётся ни после чтения, ни после записи', async () => {
    // Свой временный корень: у общего каталога системы есть и другие жильцы
    const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-tools-test-'));
    vi.stubEnv('TMPDIR', root);
    try {
      await read({ path: '/srv/app.bin', binary: true });
      await write({ files: { path: '/srv/big.bin', content: 'x'.repeat(300 * 1024) } });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
