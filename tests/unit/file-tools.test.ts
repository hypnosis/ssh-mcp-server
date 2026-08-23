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

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/utils/logger.js', () => ({ logger: loggerMock }));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: (...args: unknown[]) => {
    resolveConfigMock(...args);
    return profile.config;
  },
  getAvailableProfiles: () => ['production'],
}));

import type { FilesSummary } from '../../src/tools/transfer-output.js';

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

/** Маркер записи, которым инструмент режет вывод обхода */
const LIST_MARK = '__SSH_MCP_LS__';

/** Время правки, одно на все записи: разбору важно число, а не его величина */
const LIST_MTIME = 1787503958;

/**
 * Обход каталога так, как его делает сервер.
 *
 * Дерево настоящее: пропавший `-maxdepth` покажет вложенные пути, а чужой путь
 * вернёт отказ. Заготовленный ответ на любую команду скрыл бы и то и другое.
 */
function listing(command: string, directory: string): SSHExecuteResult {
  if (!server.has(directory)) {
    return fail(`find: '${directory}': No such file or directory`, 1);
  }

  const deep = !command.includes('-maxdepth 1');
  const pattern = (command.match(/-name '([^']*)'/) || [])[1];
  const paths = (deep ? subtree(directory) : childrenOf(directory)).filter(
    (path) => path !== directory
  );
  const shown = pattern
    ? paths.filter((path) => globMatches(pattern, path.slice(path.lastIndexOf('/') + 1)))
    : paths;

  const records = shown.map((path, index) => {
    const node = server.get(path)!;
    const kind = node.kind === 'dir' ? 'directory' : 'regular file';
    const size = node.kind === 'dir' ? 4096 : node.content.length;
    const mode = node.kind === 'dir' ? '755' : '644';
    return `${LIST_MARK}${size}|${LIST_MTIME}|deploy|deploy|${mode}|${kind}|2049:${index + 1}|${path}`;
  });

  return ok(records.length > 0 ? `${records.join('\n')}\n` : '');
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

  // Обход каталога: тот же find, но со stat в -exec. Отвечает по дереву, а не
  // заготовкой — иначе пропавший из команды -maxdepth или чужой путь пройдут молча
  if (command.includes(`-exec stat -c '${LIST_MARK}`)) {
    return listing(command, paths[0]);
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

  if (command.startsWith('chown ')) {
    // Под обычным пользователем chown отказывает на чужом имени — тихого успеха тут не бывает
    if (options?.sudo !== true) return fail(`chown: ${paths[0]}: Operation not permitted`);
    const owner = command.replace(/^chown (-R )?/, '').split(' ')[0];
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/.test(owner)) {
      return fail(`chown: invalid user: '${owner}'`);
    }
    if (!server.has(paths[0])) return fail(`chown: cannot access '${paths[0]}'`);
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

  it('чтение без машины и без пути звать нечего — обязательны обе', () => {
    const schema = toolNamed('ssh_file_read').inputSchema as any;
    expect(schema.required).toEqual(['profile', 'path']);
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

  it('запись требует машину и files, а у каждой записи — путь и содержимое', () => {
    const schema = toolNamed('ssh_file_write').inputSchema as any;
    expect(schema.required).toEqual(['profile', 'files']);
    const [single, many] = schema.properties.files.oneOf;
    expect(single.required).toEqual(['path', 'content']);
    expect(many.items.required).toEqual(['path', 'content']);
  });

  it('у записи объявлены все флаги, которые инструмент умеет читать', () => {
    const [single, many] = (toolNamed('ssh_file_write').inputSchema as any).properties.files.oneOf;
    const flags = ['path', 'content', 'mode', 'sudo', 'owner', 'verify', 'binary'];
    expect(Object.keys(single.properties)).toEqual(flags);
    expect(Object.keys(many.items.properties)).toEqual(flags);
  });

  /**
   * Один файл и список описываются одним объектом. Разъехавшись, они дают
   * агенту два разных набора флагов на один и тот же инструмент.
   */
  it('одиночная запись и список описаны одинаково, до текста параметра', () => {
    const [single, many] = (toolNamed('ssh_file_write').inputSchema as any).properties.files.oneOf;
    expect(single.properties).toEqual(many.items.properties);
    expect(single.required).toEqual(many.items.required);
  });

  it('список требует машину и путь, а шаблон и рекурсию — нет', () => {
    const schema = toolNamed('ssh_file_list').inputSchema as any;
    expect(schema.required).toEqual(['profile', 'path']);
    expect(schema.properties.recursive.default).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([
      'profile',
      'path',
      'pattern',
      'recursive',
      'sudo',
    ]);
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

  it('чтение помечено безопасным для повтора и идёт с правами вызова', async () => {
    await read({ path: '/etc/hosts', profile: 'staging', sudo: true });
    const [, options] = commandFor(/hosts/)!;
    expect(options.idempotent).toBe(true);
    expect(options.sudo).toBe(true);
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

  it('без профиля работа идёт под именем default, а не под пустым', async () => {
    await read({ path: '/etc/hosts' });
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
        'Read 2/2 files:',
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
        'Read 1/2 files:',
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

  it('каждое чтение пачки помечено безопасным для повтора', async () => {
    await read({ path: ['/etc/hosts', '/etc/motd'], profile: 'staging' });
    const reads = sentCommands().filter(([command]) => command.startsWith('cat '));
    expect(reads).toHaveLength(2);
    for (const [, options] of reads) {
      expect(options.idempotent).toBe(true);
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

  it('ни один файл не прочитан — вызов помечен провалом', async () => {
    const response = await responseOf(
      call('ssh_file_read', { path: ['/etc/missing1.conf', '/etc/missing2.conf'] })
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Read 0/2 files:');
  });

  it('частичный исход провалом не объявляется: часть файлов прочитана', async () => {
    const response = await responseOf(
      call('ssh_file_read', { path: ['/etc/hosts', '/etc/missing2.conf'] })
    );

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain('Read 1/2 files:');
  });

  it('удачная пачка пометки не получает', async () => {
    const response = await responseOf(call('ssh_file_read', { path: ['/etc/hosts', '/etc/motd'] }));

    expect(response.isError).toBeUndefined();
  });
});

describe('ssh_file_write: одиночный файл', () => {
  it('в ответе стоит путь, по которому файл действительно оказался', async () => {
    const text = await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(text).toBe('File written successfully: /etc/app.conf (sha256 verified)');
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

  it('по умолчанию сверка идёт и названа в ответе', async () => {
    expect(await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } })).toBe(
      'File written successfully: /etc/app.conf (sha256 verified)'
    );
  });

  it('verify: false выключает сверку, и про неё не говорится вовсе', async () => {
    expect(
      await write({ files: { path: '/etc/app.conf', content: 'key=value\n', verify: false } })
    ).toBe('File written successfully: /etc/app.conf');
  });

  it('в сводке по пачке исход сверки стоит у каждой записи', async () => {
    const answer = await write({
      files: [
        { path: '/etc/a.conf', content: 'a\n', verify: true },
        { path: '/etc/b.conf', content: 'b\n', verify: false },
      ],
    });

    expect(answer).toContain('✓ /etc/a.conf (2 bytes) (sha256 verified)');
    expect(answer).toContain('✓ /etc/b.conf (2 bytes)\n');
  });

  it('по умолчанию сервер о хэшах спрашивают', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(commandFor(/^sha256sum /)).toBeDefined();
  });

  it('при verify: false сервер о хэшах не спрашивают вовсе', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n', verify: false } });
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
      [
        'Write 2/2 files:',
        '',
        '✓ /etc/app.conf (10 bytes) (sha256 verified)',
        '✓ /srv/app.js (6 bytes) (sha256 verified)',
        '',
      ].join('\n')
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
    expect(text).toMatch(/^Write 1\/2 files:/);
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
    expect(text).toContain('✓ /home/deploy/notes.txt (3 bytes) (sha256 verified)\n  ⚠ ');
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

  it('ни один файл не записан — вызов помечен провалом', async () => {
    overrides = [[/^cat > /, { exitCode: 1, stderr: 'Permission denied' }]];
    const response = await responseOf(
      call('ssh_file_write', {
        files: [
          { path: '/etc/app.conf', content: 'key=value\n' },
          { path: '/srv/app.js', content: 'run();' },
        ],
      })
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Write 0/2 files:');
  });

  it('частичный исход провалом не объявляется: часть файлов записана', async () => {
    overrides = [[/^cat > .*app\.conf/, { exitCode: 1, stderr: 'Permission denied' }]];
    const response = await responseOf(
      call('ssh_file_write', {
        files: [
          { path: '/etc/app.conf', content: 'key=value\n' },
          { path: '/srv/app.js', content: 'run();' },
        ],
      })
    );

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain('Write 1/2 files:');
  });

  it('удачная пачка пометки не получает', async () => {
    const response = await responseOf(
      call('ssh_file_write', {
        files: [
          { path: '/etc/app.conf', content: 'key=value\n' },
          { path: '/srv/app.js', content: 'run();' },
        ],
      })
    );

    expect(response.isError).toBeUndefined();
  });
});

describe('ssh_file_list', () => {
  beforeEach(() => {
    putFile('/var/log/nginx.log', 'GET /\n');
    putFile('/var/log/syslog', 'boot\n');
  });

  /** Разобранная сводка ответа */
  const listed = async (args: Record<string, unknown>): Promise<any> => {
    const response = await new FileTools().handleCall(call('ssh_file_list', args));
    return response.structuredContent;
  };

  it('обход идёт одной командой, а поля берутся у stat', async () => {
    await list({ path: '/var/log' });
    const [command] = commandFor(/find /)!;

    expect(command).toContain("LC_ALL=C find '/var/log' -mindepth 1 -maxdepth 1 -exec stat");
    expect(command).toContain('%s|%Y|%U|%G|%a|%F|%d:%i|%n');
  });

  /** Второй проход добирает цели ссылок: без него у каждой ссылки target пуст */
  it('за целями ссылок уходит второй обход, в той же команде', async () => {
    await list({ path: '/var/log' });

    expect(commandFor(/find /)![0]).toContain(
      "-type l -exec stat -c '__SSH_MCP_LN__%d:%i' {} \\; -exec readlink -- {} \\;"
    );
  });

  it('каталог приезжает записями, а не строками вывода', async () => {
    const summary = await listed({ path: '/var/log' });

    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['nginx.log', 'syslog']);
    expect(summary.entries[0]).toMatchObject({
      type: 'file',
      size: 6,
      mode: '644',
      owner: 'deploy',
      group: 'deploy',
      target: null,
    });
    expect(summary.path).toBe('/var/log');
  });

  /** Имя внутри каталога, а не полный путь: иначе каждое поле повторяет заголовок */
  it('рекурсивный обход называет вложенное относительно запрошенного', async () => {
    putFile('/var/log/nginx/access.log', 'x\n');

    const summary = await listed({ path: '/var/log', recursive: true });

    expect(commandFor(/find /)![0]).toContain("LC_ALL=C find '/var/log' -mindepth 1 -exec stat");
    expect(commandFor(/find /)![0]).not.toContain('-maxdepth');
    expect(summary.entries.map((entry: any) => entry.name)).toContain('nginx/access.log');
  });

  it('под sudo список идёт от root — иначе закрытый каталог не посмотреть', async () => {
    await list({ path: '/var/log', sudo: true });

    expect(commandFor(/find /)![1]).toMatchObject({ sudo: true });
  });

  it('без sudo листинг остаётся обычным — root не берётся про запас', async () => {
    await list({ path: '/var/log' });

    expect(commandFor(/find /)![1].sudo).toBeFalsy();
  });

  /**
   * Шаблон разбирает сам find, поэтому он едет закавыченным: раскрывала бы его
   * оболочка — и `*.log` в каталоге без совпадений стал бы отказом команды.
   */
  it('шаблон отбирает записи и остаётся одним словом команды', async () => {
    const summary = await listed({ path: '/var/log', pattern: '*.log' });

    expect(commandFor(/find /)![0]).toContain("-name '*.log'");
    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['nginx.log']);
  });

  it('шаблон без совпадений — пустой список, а не ошибка', async () => {
    const summary = await listed({ path: '/var/log', pattern: '*.nope' });

    expect(summary.entries).toEqual([]);
    expect(summary.unreadable).toEqual([]);
  });

  it('список помечен безопасным для повтора', async () => {
    await list({ path: '/var/log', profile: 'staging' });

    expect(commandFor(/find /)![1].idempotent).toBe(true);
  });

  it('без профиля список идёт по серверу по умолчанию', async () => {
    await list({ path: '/var/log' });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: undefined });
  });

  it('несуществующий каталог — ошибка с текстом от сервера', async () => {
    expect(await list({ path: '/var/nowhere' })).toBe(
      "Error: Failed to list files: find: '/var/nowhere': No such file or directory"
    );
  });

  it('если сервер объяснился в stdout, ошибка берёт объяснение оттуда', async () => {
    overrides = [[/find /, { exitCode: 2, stderr: '', stdout: 'find: permission denied' }]];
    expect(await list({ path: '/var/log' })).toBe(
      'Error: Failed to list files: find: permission denied'
    );
  });

  /**
   * Часть записей дошла, а часть обход потерял на отказе: это ответ, а не
   * провал, — но подписанный, иначе неполный список читается как полный.
   */
  it('отказ посреди обхода не отменяет того, что уже собрано', async () => {
    overrides = [
      [
        /find /,
        {
          exitCode: 1,
          stderr: "find: '/var/log/private': Permission denied",
          stdout: `${LIST_MARK}6|${LIST_MTIME}|deploy|deploy|644|regular file|2049:1|/var/log/syslog\n`,
        },
      ],
    ];

    const summary = await listed({ path: '/var/log' });

    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['syslog']);
    expect(summary.unreadable).toEqual(['/var/log/private: Permission denied']);
  });

  /** Обход идёт дважды — за полями и за целями ссылок — и отказ приходит дважды */
  it('одна закрытая дверь названа один раз', async () => {
    overrides = [
      [
        /find /,
        {
          exitCode: 1,
          stderr:
            "find: '/var/log/private': Permission denied\nfind: '/var/log/private': Permission denied",
          stdout: '',
        },
      ],
    ];

    const summary = await listed({ path: '/var/log' });

    expect(summary.unreadable).toEqual(['/var/log/private: Permission denied']);
  });

  /** Одна и та же жалоба пишется двумя способами, и обе формы приходят живьём */
  it.each([
    ['coreutils кавычит путь', "find: '/var/log/private': Permission denied"],
    ['BusyBox не кавычит', 'find: /var/log/private: Permission denied'],
  ])('непрочитанный каталог назван: %s', async (_what, message) => {
    overrides = [[/find /, { exitCode: 1, stderr: message, stdout: '' }]];

    const summary = await listed({ path: '/var/log' });

    expect(summary.unreadable).toEqual(['/var/log/private: Permission denied']);
  });

  it('обрезанный список подписан, а не выдан за полный', async () => {
    overrides = [
      [
        /find /,
        {
          stdout: `${LIST_MARK}6|${LIST_MTIME}|deploy|deploy|644|regular file|2049:1|/var/log/syslog\n`,
          truncated: true,
        },
      ],
    ];

    const summary = await listed({ path: '/var/log' });

    expect(summary.truncated).toBe(true);
    expect(await list({ path: '/var/log' })).toMatch(/truncated/i);
  });

  it('целый список не выдаёт себя за обрезанный', async () => {
    expect((await listed({ path: '/var/log' })).truncated).toBe(false);
  });

  it('пустой путь — отказ до обращения к серверу', async () => {
    expect(await list({ path: '   ' })).toContain('path');
    expect(sentCommands()).toHaveLength(0);
  });

  it('пустой шаблон — отказ до обращения к серверу', async () => {
    expect(await list({ path: '/var/log', pattern: '   ' })).toContain('pattern');
    expect(commandFor(/find /)).toBeUndefined();
  });

  it('команда внутри шаблона остаётся текстом шаблона', async () => {
    await list({ path: '/var/log', pattern: '$(reboot)*.log' });

    expect(commandFor(/find /)![0]).toContain("-name '$(reboot)*.log'");
  });

  /**
   * Под sudo тильда ведёт в дом того, кто вошёл, а не в /root — разбор пути об
   * этом предупреждает, и список обязан это предупреждение донести.
   */
  it('предупреждение разбора пути не теряется по дороге', async () => {
    await list({ path: '~', sudo: true });

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('the home of the login user, not root')
    );
  });

  it('без sudo предупреждать не о чем', async () => {
    await list({ path: '~' });

    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('профиль доезжает и до разбора настроек списка', async () => {
    await list({ path: '/var/log', profile: 'staging' });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

});

/**
 * Разбор ответа сервера. Имя файла — единственное поле, куда сервер пускает
 * что угодно, включая знаки, которыми разбор режет записи.
 */
describe('ssh_file_list: имена, которые ломают построчный разбор', () => {
  const listed = async (stdout: string, args: Record<string, unknown> = {}): Promise<any> => {
    overrides = [[/find /, { stdout }]];
    const response = await new FileTools().handleCall(
      call('ssh_file_list', { path: '/var/log', ...args })
    );
    return response.structuredContent;
  };

  const record = (name: string, tail = '644|regular file|2049:1') =>
    `${LIST_MARK}12|${LIST_MTIME}|deploy|deploy|${tail}|/var/log/${name}\n`;

  it('перевод строки внутри имени остаётся внутри имени', async () => {
    const summary = await listed(record('two\nlines.log') + record('plain.log', '644|regular file|2049:2'));

    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['plain.log', 'two\nlines.log']);
  });

  it('разделитель полей внутри имени не съедает имя', async () => {
    const summary = await listed(record('pipe|inside.log'));

    expect(summary.entries[0].name).toBe('pipe|inside.log');
  });

  it('ссылка приходит вместе с тем, куда ведёт', async () => {
    const summary = await listed(
      `${LIST_MARK}10|${LIST_MTIME}|deploy|deploy|777|symbolic link|2049:7|/var/log/current\n` +
        `__SSH_MCP_LN__2049:7\n/var/log/nginx.log\n`
    );

    expect(summary.entries[0]).toMatchObject({ type: 'symlink', target: '/var/log/nginx.log' });
  });

  it('ссылка без ответа readlink не выдаёт чужую цель за свою', async () => {
    const summary = await listed(
      `${LIST_MARK}10|${LIST_MTIME}|deploy|deploy|777|symbolic link|2049:7|/var/log/current\n`
    );

    expect(summary.entries[0].target).toBeNull();
  });

  /** Пустой файл coreutils называет иначе, чем непустой, — тип от этого не меняется */
  it.each([
    ['regular file', 'file'],
    ['regular empty file', 'file'],
    ['directory', 'dir'],
    ['symbolic link', 'symlink'],
    ['fifo', 'other'],
    ['socket', 'other'],
  ])('%s читается как %s', async (kind, type) => {
    const summary = await listed(record('x', `644|${kind}|2049:1`));

    expect(summary.entries[0].type).toBe(type);
  });

  /** Обход отдаёт записи в порядке каталога, и два вызова разошлись бы без сортировки */
  it('записи упорядочены по имени, а не по тому, как их нашли', async () => {
    const summary = await listed(
      record('c.log') + record('a.log', '644|regular file|2049:2') + record('b.log', '644|regular file|2049:3')
    );

    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['a.log', 'b.log', 'c.log']);
  });

  it('обрывок записи не превращается в запись с пустыми полями', async () => {
    const summary = await listed(`${LIST_MARK}12|${LIST_MTIME}|deploy\n` + record('good.log'));

    expect(summary.entries.map((entry: any) => entry.name)).toEqual(['good.log']);
  });

  it('ключ без цели не берёт цель соседа', async () => {
    const summary = await listed(
      `${LIST_MARK}10|${LIST_MTIME}|deploy|deploy|777|symbolic link|2049:7|/var/log/a\n` +
        `__SSH_MCP_LN__2049:7`
    );

    expect(summary.entries[0].target).toBeNull();
  });

  /** Ключ ссылки и ключ файла совпасть не могут, но разбор не должен на это полагаться */
  it('цель ссылки не приклеивается к обычному файлу', async () => {
    const summary = await listed(
      record('plain.log') + `__SSH_MCP_LN__2049:1\n/var/log/elsewhere\n`
    );

    expect(summary.entries[0]).toMatchObject({ type: 'file', target: null });
  });

  it('нечисловые размер и время читаются нулями, а не NaN', async () => {
    const summary = await listed(`${LIST_MARK}?|later|deploy|deploy|644|regular file|2049:1|/var/log/x\n`);

    expect(summary.entries[0]).toMatchObject({ size: 0, mtime: 0 });
  });

  /** Жалоба узнаётся по началу строки: «find: » внутри имени файла — не жалоба */
  it('строка, похожая на жалобу, но не начинающаяся с неё, не считается отказом', async () => {
    overrides = [[/find /, { exitCode: 1, stderr: 'stat: find: /var/log/x: Permission denied', stdout: '' }]];

    const response = await new FileTools().handleCall(call('ssh_file_list', { path: '/var/log' }));

    expect(response.content[0].text).toContain('Failed to list files');
  });

  /**
   * Отказ у самой двери — провал вызова, но только когда собрать нечего. Если
   * записи есть, дверь в список непрочитанного не идёт: она и есть тот каталог,
   * который назван в ответе.
   */
  it('отказ у двери при собранных записях не отменяет ответа', async () => {
    overrides = [
      [
        /find /,
        {
          exitCode: 1,
          stderr: "find: '/var/log': Permission denied",
          stdout: record('one.log'),
        },
      ],
    ];

    const response = await new FileTools().handleCall(call('ssh_file_list', { path: '/var/log' }));
    const summary: any = response.structuredContent;

    expect(summary.entries).toHaveLength(1);
    expect(summary.unreadable).toEqual([]);
  });

  /** Слова ответа объясняются тем, что в нём встретилось, а не всем словарём */
  it('легенда объясняет только встреченные виды записей', async () => {
    const summary = await listed(record('x'));

    expect(summary.legend['entries[].type=file']).toContain('regular file');
    expect(summary.legend['entries[].type=symlink']).toBeUndefined();
  });
});

/**
 * Сводка для чтения. Поля уже проверены выше; здесь — то, что человек и агент
 * видят первым: заголовок, колонки, отметка каталога и ссылки, названные двери.
 */
describe('ssh_file_list: сводка для чтения', () => {
  const shown = async (stdout: string): Promise<string> => {
    overrides = [[/find /, { stdout }]];
    return textOf(call('ssh_file_list', { path: '/var/log' }));
  };

  const entry = (name: string, tail = '644|regular file|2049:1', size = 12) =>
    `${LIST_MARK}${size}|${LIST_MTIME}|deploy|deploy|${tail}|/var/log/${name}\n`;

  it('заголовок называет каталог и счёт записей', async () => {
    expect(await shown(entry('a.log'))).toContain('/var/log — 1 entry');
    expect(await shown(entry('a.log') + entry('b.log', '644|regular file|2049:2'))).toContain(
      '/var/log — 2 entries'
    );
  });

  it('пустой каталог говорит это словом, а не пустотой', async () => {
    expect(await shown('')).toBe('/var/log — 0 entries');
  });

  it('строка записи несёт права, владельца, размер, время и имя', async () => {
    const text = await shown(entry('a.log'));

    expect(text).toContain(' 644  deploy:deploy  12  2026-08-23 16:52  a.log');
  });

  /** Каталог и ссылка отличаются от файла на глаз, иначе список читается вслепую */
  it('каталог помечен косой чертой, а ссылка — своей целью', async () => {
    const text = await shown(
      entry('sub', '755|directory|2049:2', 4096) +
        entry('current', '777|symbolic link|2049:3', 10) +
        '__SSH_MCP_LN__2049:3\n/var/log/a.log\n'
    );

    expect(text).toContain('sub/');
    expect(text).toContain('current -> /var/log/a.log');
  });

  it('колонки выровнены по самой длинной записи', async () => {
    const text = await shown(entry('a.log', '644|regular file|2049:1', 7) + entry('b.log', '644|regular file|2049:2', 1234567));

    expect(text).toContain('        7  ');
    expect(text).toContain('  1234567  ');
  });

  it('названные двери печатаются отдельным блоком, а не теряются', async () => {
    overrides = [
      [
        /find /,
        { exitCode: 1, stderr: "find: '/var/log/private': Permission denied", stdout: entry('a.log') },
      ],
    ];

    const text = await textOf(call('ssh_file_list', { path: '/var/log' }));

    expect(text).toContain('NOT READ:');
    expect(text).toContain('  - /var/log/private: Permission denied');
  });

  it('без непрочитанного блока «NOT READ» не печатается', async () => {
    expect(await shown(entry('a.log'))).not.toContain('NOT READ');
  });

  /**
   * Сводка целиком: заголовок, пустая строка, записи в колонках и блок дверей.
   * Отдельные проверки по кускам пропускают то, что между ними.
   */
  it('сводка печатается целиком и в одном виде', async () => {
    overrides = [
      [
        /find /,
        {
          exitCode: 1,
          stderr: "find: '/var/log/private': Permission denied",
          stdout:
            entry('nginx.log', '644|regular file|2049:1', 120) +
            entry('archive', '750|directory|2049:2', 4096) +
            entry('current', '777|symbolic link|2049:3', 10) +
            '__SSH_MCP_LN__2049:3\n/var/log/nginx.log\n',
        },
      ],
    ];

    const text = await textOf(call('ssh_file_list', { path: '/var/log' }));

    expect(text).toBe(
      [
        '/var/log — 3 entries',
        '',
        ' 750  deploy:deploy  4096  2026-08-23 16:52  archive/',
        ' 777  deploy:deploy    10  2026-08-23 16:52  current -> /var/log/nginx.log',
        ' 644  deploy:deploy   120  2026-08-23 16:52  nginx.log',
        '',
        'NOT READ:',
        '  - /var/log/private: Permission denied',
      ].join('\n')
    );
  });

  /** Ширина колонки владельца считается по владельцу, а не берётся наугад */
  it('владелец подпирается до самого длинного', async () => {
    const text = await shown(
      entry('a.log') + `${LIST_MARK}12|${LIST_MTIME}|verylonguser|verylonggroup|644|regular file|2049:2|/var/log/b.log\n`
    );

    expect(text).toContain('deploy:deploy               12');
    expect(text).toContain('verylonguser:verylonggroup  12');
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
    // У записи рядом с текстом едет сводка — её сторожит exec-соседний файл;
    // здесь важно, что текстовый кусок на месте и тип у него не пустой
    expect(
      await responseOf(call('ssh_file_write', { files: { path: '/srv/a.js', content: 'a' } }))
    ).toEqual({ content: [textPart], structuredContent: expect.any(Object) });
    expect(
      await responseOf(
        call('ssh_file_write', {
          files: [
            { path: '/srv/b.js', content: 'b' },
            { path: '/srv/c.js', content: 'c' },
          ],
        })
      )
    ).toEqual({ content: [textPart], structuredContent: expect.any(Object) });
    expect(await responseOf(call('ssh_file_list', { path: '/etc' }))).toEqual({
      content: [textPart],
      structuredContent: expect.any(Object),
    });
    expect(await responseOf(call('ssh_file_read', { path: '/etc/nothing' }))).toEqual({
      content: [textPart],
      isError: true,
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
    expect(staging).toMatch(/^\/etc\/\.upload-[0-9a-f]+\.app\.conf$/);
    expect(sentCommands().findIndex(([c]) => c.startsWith('chmod '))).toBeLessThan(
      sentCommands().findIndex(([c]) => c.startsWith('mv -T'))
    );
  });

  it('владелец ставится по временному пути под sudo, до замены и после прав', async () => {
    await write({
      files: { path: '/etc/app.conf', content: 'key=value\n', mode: '640', owner: 'www-data:www-data', sudo: true },
    });
    const [command, options] = commandFor(/^chown /)!;
    const staging = quotedPaths(command)[0];
    expect(command).toBe(`chown www-data:www-data -- '${staging}'`);
    expect(staging).toMatch(/^\/etc\/\.upload-[0-9a-f]+\.app\.conf$/);
    expect(options.sudo).toBe(true);

    const order = (prefix: string) => sentCommands().findIndex(([c]) => c.startsWith(prefix));
    expect(order('chmod ')).toBeLessThan(order('chown '));
    expect(order('chown ')).toBeLessThan(order('mv -T'));
  });

  it('владелец без sudo не отправляется на сервер, а называется в ответе', async () => {
    const text = await write({
      files: { path: '/srv/app.conf', content: 'key=value\n', owner: 'www-data:www-data' },
    });
    expect(commandFor(/^chown /)).toBeUndefined();
    expect(text).toContain('owner was NOT applied');
    expect(server.has('/srv/app.conf')).toBe(true);
  });

  it('без владельца команда chown не отправляется вовсе', async () => {
    const text = await write({ files: { path: '/etc/app.conf', content: 'key=value\n', sudo: true } });
    expect(commandFor(/^chown /)).toBeUndefined();
    // Предупреждение о владельце появляется только там, где владельца просили:
    // приписанное к обычной записи, оно отправит читателя чинить исправное
    expect(text).not.toContain('⚠');
  });

  it('негодное имя владельца отвергается до первой команды на сервере', async () => {
    const text = await write({
      files: { path: '/etc/app.conf', content: 'a', owner: 'root; rm -rf /', sudo: true },
    });
    expect(text).toContain('owner');
    expect(sentCommands().filter(([c]) => c.startsWith('cat > '))).toHaveLength(0);
    expect(server.has('/etc/app.conf')).toBe(false);
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
    expect(server.has(handoff)).toBe(false);
  });

  it('права под sudo ставит тот же, кто пишет файл', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'a', mode: '600', sudo: true } });
    expect(commandFor(/^chmod /)![1].sudo).toBe(true);
  });

  it('запрошенный профиль выбирает конфигурацию записи', async () => {
    await write({ profile: 'staging', files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'staging' });
  });

  it('без профиля запись идёт по серверу по умолчанию', async () => {
    await write({ files: { path: '/etc/app.conf', content: 'key=value\n' } });
    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: undefined });
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
    expect(notes[0]).toBe(
      'File written successfully: /home/deploy/notes.txt (sha256 verified)'
    );
    expect(notes[1]).toBe(
      '"~/notes.txt" points at /home/deploy/notes.txt — the home of the login user,' +
        " not root's. Pass an absolute path if you meant a different directory."
    );
    expect(notes[2]).toContain('.upload-deadbeef.notes.txt');
  });

  it('предупреждение в одиночном ответе печатается со своей строки', async () => {
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n', sudo: true } });
    expect(text).toBe(
      'File written successfully: /home/deploy/notes.txt (sha256 verified)\n⚠ "~/notes.txt" points at' +
        ' /home/deploy/notes.txt — the home of the login user, not root\'s.' +
        ' Pass an absolute path if you meant a different directory.'
    );
  });
});

describe('раскрытие пути идёт с теми же правами', () => {
  beforeEach(() => {
    putFile('/etc/hosts', '127.0.0.1 localhost\n');
    profile.config = { ...profile.config, pathSecurity: { allowedPaths: ['/etc', '/var'] } };
  });

  it('под sudo правила проверяются от имени root, а не пользователя', async () => {
    await read({ path: '/etc/hosts', sudo: true, profile: 'staging' });
    const [, options] = commandFor(/^p=/)!;
    expect(options.sudo).toBe(true);
  });

  it('список проверяет правила на том же сервере, что и читает', async () => {
    await list({ path: '/var/log', profile: 'staging' });
    expect(executeMock.mock.calls.every(([config]) => config === profile.config)).toBe(true);
  });

  it('без просьбы о sudo правила проверяются от имени пользователя', async () => {
    await read({ path: '/etc/hosts' });
    expect(commandFor(/^p=/)![1].sudo).toBeFalsy();
  });

  it('запись без sudo не жалуется на чужой домашний каталог', async () => {
    profile.config = { host: 'example.com', username: 'deploy', port: 22 };
    const text = await write({ files: { path: '~/notes.txt', content: 'hi\n' } });
    expect(text).toBe('File written successfully: /home/deploy/notes.txt (sha256 verified)');
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

/**
 * Байты, не сложившиеся в текст, приходили знаком замены — и уходили дальше как
 * содержимое: записанный обратно файл оказывался другим. Приёмка ловила это на
 * файле в 4096 случайных байт: 1736 знаков замены в ответе, ни слова о потере.
 */
describe('ssh_file_read: испорченный текст не выдаётся за содержимое', () => {
  beforeEach(() => {
    putFile('/srv/app.bin', Buffer.from([0x00, 0xff, 0xfe, 0x7f, 0x10]));
    putFile('/srv/plain.txt', 'первая строка\nвторая 🚀\n');
    putFile('/srv/other.txt', 'ещё текст\n');
  });

  it('чтение двоичного файла отказывает и советует binary', async () => {
    const text = await read({ path: '/srv/app.bin' });

    expect(text).toContain('is not valid UTF-8 text');
    expect(text).toContain('binary: true');
    expect(text).not.toContain('�');
  });

  it('кириллица и эмодзи испорченными не считаются', async () => {
    expect(await read({ path: '/srv/plain.txt' })).toBe('первая строка\nвторая 🚀\n');
  });

  it('в пачке отказ достаётся одному файлу, остальные читаются', async () => {
    const text = await read({ path: ['/srv/plain.txt', '/srv/app.bin', '/srv/other.txt'] });

    expect(text).toContain('✓ /srv/plain.txt');
    expect(text).toContain('✗ /srv/app.bin');
    expect(text).toContain('is not valid UTF-8 text');
    expect(text).toContain('✓ /srv/other.txt');
  });

  it('с флагом binary тот же файл читается по-прежнему', async () => {
    expect(await read({ path: '/srv/app.bin', binary: true })).toBe(
      Buffer.from([0x00, 0xff, 0xfe, 0x7f, 0x10]).toString('base64')
    );
  });
});

/**
 * Сводка рядом с текстом записи.
 *
 * Исход сверки уезжает в текст хвостом строки, а «не просили проверять» —
 * вообще ничем: отсутствие проверки выглядит как проверка, которая прошла.
 * Полем каждый исход назван словом, и здесь сторожатся сами слова.
 */
describe('сводка записи', () => {
  async function summaryOf(args: Record<string, unknown>): Promise<FilesSummary> {
    const response = await new FileTools().handleCall(call('ssh_file_write', args));
    return response.structuredContent as FilesSummary;
  }

  it('сверенная запись названа словом', async () => {
    const summary = await summaryOf({ files: { path: '/srv/a.js', content: 'run();', verify: true } });

    expect(summary.files).toEqual([
      { path: '/srv/a.js', written: true, verified: 'verified', reason: null, bytes: 6 },
    ]);
  });

  it('никто не просил сверять — это свой исход, а не сверка, которая прошла', async () => {
    const [file] = (
      await summaryOf({ files: { path: '/srv/a.js', content: 'run();', verify: false } })
    ).files;

    expect(file).toMatchObject({ verified: 'skipped', reason: null, written: true });
  });

  it('сверять было нечем — исход назван, причина при нём, файл на месте', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const [file] = (await summaryOf({
      files: { path: '/srv/a.js', content: 'run();', verify: true },
    })).files;

    expect(file.verified).toBe('unavailable');
    expect(file.reason).toBeTruthy();
    expect(file.written).toBe(true);
  });

  it('форма одна и та же: один файл — тоже список', async () => {
    const summary = await summaryOf({ files: { path: '/srv/a.js', content: 'a' } });

    expect(summary.files).toHaveLength(1);
  });

  it('двоичное содержимое считается после раскодирования, а не по длине base64', async () => {
    const [file] = (await summaryOf({
      files: { path: '/srv/a.bin', content: Buffer.from('run();').toString('base64'), binary: true },
    })).files;

    expect(file.bytes).toBe(6);
  });

  /** Провал одного файла из пачки — это то, ради чего сводку и читают */
  it('в пачке видно, какой файл не встал и на чём', async () => {
    overrides = [[/^cat > .*b\.js/, { exitCode: 1, stderr: 'cat: write error: No space left' }]];

    const summary = await summaryOf({
      files: [
        { path: '/srv/a.js', content: 'a' },
        { path: '/srv/b.js', content: 'b' },
      ],
    });

    expect(summary.files[0]).toMatchObject({ path: '/srv/a.js', written: true, bytes: 1 });
    expect(summary.files[1].written).toBe(false);
    expect(summary.files[1].reason).toContain('No space left');
    expect(summary.files[1].bytes).toBeNull();
  });

  /**
   * Сверять нечего там, где ничего не легло: исход `verified` у неуехавшего
   * файла прочитался бы как «данные на месте и совпали».
   */
  it('файл, который не встал, сверенным не считается', async () => {
    overrides = [[/^cat > .*b\.js/, { exitCode: 1, stderr: 'cat: write error: No space left' }]];

    const summary = await summaryOf({
      files: [
        { path: '/srv/a.js', content: 'a', verify: true },
        { path: '/srv/b.js', content: 'b', verify: true },
      ],
    });

    expect(summary.files[1]).toMatchObject({ written: false, verified: 'skipped' });
  });

  /**
   * Одиночная запись и пачка отвечают одинаково: провал единственного файла
   * раньше приходил одним текстом, и исход приходилось вычитывать из прозы.
   */
  it('провал единственного файла тоже приходит полями, а не одним текстом', async () => {
    overrides = [[/^cat > .*a\.js/, { exitCode: 1, stderr: 'cat: write error: No space left' }]];

    const response = await new FileTools().handleCall(
      call('ssh_file_write', { files: { path: '/srv/a.js', content: 'a', verify: true } })
    );
    const summary = response.structuredContent as FilesSummary;

    expect(response.isError).toBe(true);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({
      path: '/srv/a.js',
      written: false,
      verified: 'skipped',
      bytes: null,
    });
    expect(summary.files[0].reason).toContain('No space left');
    expect(summary.legend['files[].verified=skipped']).toContain('no comparison ran');
  });
});

/**
 * Легенда: слова сверки расшифрованы в самом ответе.
 *
 * `unavailable` и `skipped` решают, можно ли считать записанное проверенным,
 * а на вид отличаются одной буквой.
 */
describe('легенда записи', () => {
  async function legendOf(args: Record<string, unknown>): Promise<FilesSummary['legend']> {
    const response = await new FileTools().handleCall(call('ssh_file_write', args));
    return (response.structuredContent as FilesSummary).legend;
  }

  it('сверенная запись объясняет своё слово', async () => {
    const legend = await legendOf({ files: { path: '/srv/a.js', content: 'run();', verify: true } });

    expect(legend['files[].verified=verified']).toContain('sha256');
  });

  it('несостоявшаяся сверка объясняется отдельно от несделанной', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const legend = await legendOf({ files: { path: '/srv/a.js', content: 'run();', verify: true } });

    expect(legend['files[].verified=unavailable']).toContain('nothing to work with');
    expect(legend['files[].verified=skipped']).toBeUndefined();
  });

  it('несделанная сверка объясняет своё слово', async () => {
    const legend = await legendOf({
      files: { path: '/srv/a.js', content: 'a', verify: false },
    });

    expect(legend['files[].verified=skipped']).toContain('no comparison ran');
  });

  it('ключ называет поле внутри списка, а не голое слово', async () => {
    expect(
      Object.keys(await legendOf({ files: { path: '/srv/a.js', content: 'a', verify: false } }))
    ).toEqual(['files[].verified=skipped']);
  });

  /** Пачка из трёх файлов с одним исходом — одна расшифровка, а не три */
  it('повторяющийся исход объясняется один раз', async () => {
    const legend = await legendOf({
      files: [
        { path: '/srv/a.js', content: 'a', verify: false },
        { path: '/srv/b.js', content: 'b', verify: false },
        { path: '/srv/c.js', content: 'c', verify: true },
      ],
    });

    expect(Object.keys(legend).sort()).toEqual([
      'files[].verified=skipped',
      'files[].verified=verified',
    ]);
  });
});
