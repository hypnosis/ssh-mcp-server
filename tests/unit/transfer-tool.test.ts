/**
 * Unit tests: что инструмент передачи говорит серверу и что отвечает человеку
 *
 * Три места, где ошибка стоит данных: команда под root (`install`), решение
 * «файл или каталог» по ответу `test`, и сам текст ответа — единственное, что
 * видит агент. Поэтому сервер здесь не заготовка: он ведёт своё дерево, отвечает
 * по состоянию и отказывается выполнять команду, которой не ждал.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
}));

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { listTreeFiles } = await import('../../src/utils/local-tree.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

// ---------------------------------------------------------------------------
// Сервер: дерево путей, отвечающее по своему состоянию
// ---------------------------------------------------------------------------

type Node = { kind: 'file'; content: string } | { kind: 'dir' } | { kind: 'symlink' };

/** Что лежит на сервере прямо сейчас */
let server: Map<string, Node>;
/** Пути, на которых сервер отказывает; ключ — начало команды и путь */
let refusals: Array<[RegExp, Partial<SSHExecuteResult>]>;

function putFile(path: string, content: string): void {
  putDir(parentOf(path));
  server.set(path, { kind: 'file', content });
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

/** Путь и всё, что под ним */
function subtree(path: string): string[] {
  return [...server.keys()].filter((key) => key === path || key.startsWith(`${path}/`));
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

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Ответ сервера на команду.
 *
 * Неизвестная команда — отказ, а не успех: молчаливое «ок» на всё подряд
 * скрывает ровно то, ради чего эти тесты и написаны — потерянный кусок
 * команды или обращение не к тому пути.
 */
function answer(command: string): SSHExecuteResult {
  const refusal = refusals.find(([pattern]) => pattern.test(command));
  if (refusal) return { ...fail('refused'), ...refusal[1] } as SSHExecuteResult;

  const paths = quotedPaths(command);

  if (command.startsWith('if [ -L ')) {
    const node = server.get(paths[0]);
    const kind = !node
      ? 'ABSENT'
      : node.kind === 'symlink'
        ? 'SYMLINK'
        : node.kind === 'dir'
          ? 'DIR'
          : 'FILE';
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
    const source = server.get(from);
    if (!source) return fail(`mv: cannot stat '${from}': No such file or directory`);
    const target = server.get(to);
    // `mv -T` в занятую цель ничего не вкладывает: каталог поверх каталога — отказ
    if (target && (target.kind === 'dir' || source.kind === 'dir')) {
      return fail(`mv: cannot overwrite '${to}': Directory not empty`);
    }
    removeTree(to);
    moveTree(from, to);
    return ok();
  }

  if (command.startsWith('rm -rf --') || command.startsWith('rm -f ')) {
    removeTree(paths[0]);
    return ok();
  }

  if (command.startsWith('find ')) {
    const inside = subtree(paths[0]).filter(
      (path) => parentOf(path) === paths[0] && /\/\.(upload|bak)-/.test(path)
    );
    return ok(inside.length > 0 ? `${inside.join('\n')}\n` : '');
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
      : ({ stdout: lines.join('\n'), stderr: 'sha256sum: No such file or directory', exitCode: 1, truncated: false } as SSHExecuteResult);
  }

  if (command.startsWith('test -e ') || command.startsWith('test -d ')) {
    const node = server.get(paths[0]);
    const present = command.startsWith('test -d ') ? node?.kind === 'dir' : !!node;
    // Сервер отвечает строкой с переводом строки, а не голым словом
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
    // Владельца разбирает сама утилита: пустая группа — отказ, а не тихий успех
    const spec = command.slice('chown '.length).split(' ')[0];
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/.test(spec)) {
      return fail(`chown: invalid spec: '${spec}'`);
    }
    if (!server.has(paths[0])) return fail(`chown: cannot access '${paths[0]}'`);
    return ok();
  }

  if (command.startsWith('cp -- ')) {
    const [source, target] = paths;
    const node = server.get(source);
    if (!node || node.kind !== 'file') return fail(`cp: cannot stat '${source}'`);
    if (!server.has(parentOf(target))) return fail(`cp: cannot create '${target}'`);
    server.set(target, { ...node });
    return ok();
  }

  throw new Error(`the server was not asked to run this: ${command}`);
}

/** Сервер с обычным набором утилит */
function fullPassport(overrides: Record<string, unknown> = {}) {
  return {
    ...UNKNOWN_PASSPORT,
    known: true,
    sha256: 'sha256sum',
    coreutils: 'coreutils',
    home: '/home/deploy',
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

async function textOf(request: CallToolRequest): Promise<string> {
  const response = await new TransferTool().handleCall(request);
  return response.content[0].text as string;
}

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

let localDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  server = new Map([['/', { kind: 'dir' }]]);
  putDir('/srv');
  putDir('/tmp');
  putDir('/etc');
  putDir('/home/deploy');
  refusals = [];
  profile.config = { host: 'example.com', username: 'deploy', port: 22 };

  executeMock.mockImplementation(async (_config: unknown, command: string) => answer(command));
  passportMock.mockResolvedValue(fullPassport());

  // Транспорт кладёт на сервер то, что ему дали, — как настоящий scp
  uploadMock.mockImplementation(
    async (source: string, target: string, options?: { recursive?: boolean }) => {
      if (!options?.recursive) {
        putFile(target, readFileSync(source, 'utf8'));
        return;
      }
      putDir(target);
      for (const rel of await listTreeFiles(source)) {
        putFile(join(target, rel), readFileSync(join(source, rel), 'utf8'));
      }
    }
  );
  downloadMock.mockImplementation(
    async (source: string, target: string, options?: { recursive?: boolean }) => {
      if (!options?.recursive) {
        const node = server.get(source);
        writeFileSync(target, node && node.kind === 'file' ? node.content : '', 'utf8');
        return;
      }
      for (const path of subtree(source)) {
        const node = server.get(path)!;
        const local = join(target, path.slice(source.length));
        if (node.kind === 'dir') mkdirSync(local, { recursive: true });
        else writeFileSync(local, node.content, 'utf8');
      }
    }
  );

  localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-transfer-tool-'));
  localFile = join(localDir, 'app.js');
  writeFileSync(localFile, 'run();', 'utf8');
  mkdirSync(join(localDir, 'conf'));
  writeFileSync(join(localDir, 'conf', 'app.ini'), 'key=value', 'utf8');
});

afterEach(() => {
  rmSync(localDir, { recursive: true, force: true });
});

/**
 * Запись под root идёт через установщик: файл уезжает в /tmp от имени
 * пользователя, рядом с целью появляется копией уже под root и встаёт на место
 * переименованием. Боевой путь не переписывается поверх ни на одном шаге —
 * иначе обрыв посреди записи оставлял бы от прежнего файла огрызок.
 */
describe('ssh_upload под sudo: как данные встают на место', () => {
  const sudoUpload = (args: Record<string, unknown> = {}) =>
    textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/etc/app.conf',
        sudo: true,
        verify: false,
        ...args,
      })
    );

  /** Временный путь рядом с целью — тот, который назван в переименовании */
  const staging = (): string => quotedPaths(commandFor(/^mv -T -- /)![0])[0];

  it('передача идёт в /tmp, а рядом с целью появляется копия под sudo', async () => {
    const text = await sudoUpload();

    expect(uploadMock.mock.calls[0][0]).toBe(localFile);
    const handoff = uploadMock.mock.calls[0][1] as string;
    expect(handoff).toMatch(/^\/tmp\/\.ssh-mcp-upload-[0-9a-f]{16}$/);

    const copy = commandFor(/^cp -- /)!;
    expect(copy[0]).toBe(`cp -- '${handoff}' '${staging()}'`);
    expect(copy[1]).toMatchObject({ sudo: true });
    expect(text).toContain('Upload OK');
  });

  it('на место файл встаёт переименованием, а не копией поверх цели', async () => {
    await sudoUpload();

    const rename = commandFor(/^mv -T -- /)!;
    expect(rename[0]).toMatch(
      /^mv -T -- '\/etc\/\.upload-[0-9a-f]+\.app\.conf' '\/etc\/app\.conf'$/
    );
    expect(rename[1]).toMatchObject({ sudo: true });
    expect(commandFor(/^install /)).toBeUndefined();
    expect(server.get('/etc/app.conf')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('обрыв записи не оставляет от прежнего файла огрызка', async () => {
    putFile('/etc/app.conf', 'old config');
    // `install` копирует поверх: цель обрезается до того, как записано новое.
    // Сторож времени убивает команду на полпути — 124 у coreutils, 143 у BusyBox
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (/^install /.test(command)) {
        server.set(quotedPaths(command)[1], { kind: 'file', content: '' });
        return fail('terminated', 124);
      }
      if (/^cp -- /.test(command)) return fail('terminated', 124);
      return answer(command);
    });

    const text = await sudoUpload();

    expect(text).not.toContain('Upload OK');
    expect(server.get('/etc/app.conf')).toEqual({ kind: 'file', content: 'old config' });
  });

  it('расхождение не доходит до боевого пути — там остаётся прежний файл', async () => {
    putFile('/etc/app.conf', 'old config');
    uploadMock.mockImplementation(async (_source: string, target: string) => {
      putFile(target, 'corrupted');
    });

    const text = await sudoUpload({ verify: true });

    expect(text).toContain('sha256 mismatch after upload');
    expect(server.get('/etc/app.conf')).toEqual({ kind: 'file', content: 'old config' });
  });

  it('сверяется копия рядом с целью, под sudo и до замены', async () => {
    const text = await sudoUpload({ verify: true });

    const hashing = commandFor(/^sha256sum /)!;
    expect(hashing[0]).toBe(`sha256sum -- '${staging()}'`);
    // Читать копию рядом с целью иначе нечем: правами она уже не наша
    expect(hashing[1]).toMatchObject({ sudo: true });
    expect(text).toContain(`sha256: ${sha256Of('run();')} (verified)`);

    const order = sentCommands().map(([command]) => command);
    expect(order.findIndex((command) => command.startsWith('sha256sum'))).toBeLessThan(
      order.findIndex((command) => command.startsWith('mv -T'))
    );
  });

  it('сверять было нечем — файл всё равно встаёт на место, причина названа', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const text = await sudoUpload({ verify: true });

    expect(text).toContain('sha256: skipped — neither sha256sum nor openssl');
    expect(server.get('/etc/app.conf')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('права и владелец применяются к копии до замены', async () => {
    await sudoUpload({ mode: '644', owner: 'root:root' });

    expect(commandFor(/^chmod /)![0]).toBe(`chmod 644 -- '${staging()}'`);
    expect(commandFor(/^chmod /)![1]).toMatchObject({ sudo: true });
    expect(commandFor(/^chown /)![0]).toBe(`chown root:root -- '${staging()}'`);
    expect(commandFor(/^chown /)![1]).toMatchObject({ sudo: true });

    const order = sentCommands().map(([command]) => command.split(' ')[0]);
    expect(order.indexOf('chmod')).toBeLessThan(order.indexOf('mv'));
    expect(order.indexOf('chown')).toBeLessThan(order.indexOf('mv'));
  });

  it('владелец без группы уезжает целым словом, без пустой группы', async () => {
    await sudoUpload({ mode: '600', owner: 'nginx' });

    expect(commandFor(/^chown /)![0]).toBe(`chown nginx -- '${staging()}'`);
  });

  it('без прав и владельца лишних команд на сервер не уходит', async () => {
    await sudoUpload();

    expect(commandFor(/^chmod /)).toBeUndefined();
    expect(commandFor(/^chown /)).toBeUndefined();
  });

  it('под sudo про потерянного владельца не предупреждают: он применён', async () => {
    const text = await sudoUpload({ owner: 'root:root' });

    expect(text).not.toContain('owner was NOT applied');
  });

  it('родительский каталог создаётся под sudo, до передачи', async () => {
    await sudoUpload({ remote_path: '/etc/app/app.conf' });

    const order = sentCommands().map(([command]) => command.split(' ')[0]);
    expect(order.indexOf('mkdir')).toBeLessThan(order.indexOf('cp'));
    expect(commandFor(/^mkdir /)![0]).toBe(`mkdir -p -- '/etc/app'`);
    expect(commandFor(/^mkdir /)![1]).toMatchObject({ sudo: true });
  });

  it('корень родителем не считается — лишней команды нет', async () => {
    await sudoUpload({ remote_path: '/app.conf' });

    expect(commandFor(/^mkdir /)).toBeUndefined();
  });

  it('относительная цель не заставляет создавать каталог «.»', async () => {
    await sudoUpload({ remote_path: 'app.conf' });

    expect(commandFor(/^mkdir /)).toBeUndefined();
  });

  it('промежуточный файл в /tmp убирается после удачной установки', async () => {
    await sudoUpload();
    const handoff = uploadMock.mock.calls[0][1] as string;

    expect(commandFor(/^rm -f /)![0]).toBe(`rm -f -- '${handoff}'`);
    expect(server.has(handoff)).toBe(false);
  });

  it('промежуточный файл убирается и тогда, когда копия не удалась', async () => {
    refusals = [[/^cp -- /, { stderr: 'cp: Permission denied' }]];

    const text = await sudoUpload();
    const handoff = uploadMock.mock.calls[0][1] as string;

    expect(text).not.toContain('Upload OK');
    expect(commandFor(/^rm -f -- /)![0]).toBe(`rm -f -- '${handoff}'`);
    expect(server.has(handoff)).toBe(false);
  });

  it('атомарность в ответе описывает то, что произошло, а не просьбу', async () => {
    const text = await sudoUpload({ atomic: false });

    expect(text).toContain('  atomic: true');
  });
});

/**
 * Профиль выбирает и сервер, и ключ. Потеряться он может в любой отдельной
 * команде: конфигурация передаётся каждой отдельно, и мимо профиля уйдёт
 * только она одна.
 */
describe('конфигурация выбранного профиля доезжает до каждой команды', () => {
  const configsOf = () => [...new Set(executeMock.mock.calls.map(([config]) => config))];

  it('по имени профиля выбирается и сам сервер', async () => {
    await textOf(
      call('ssh_upload', {
        profile: 'production',
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
      })
    );

    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'production' });
  });

  it('скачивание спрашивает сервер по тому же имени', async () => {
    putFile('/srv/app.js', 'payload');

    await textOf(
      call('ssh_download', {
        profile: 'production',
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
        verify: false,
      })
    );

    expect(resolveConfigMock).toHaveBeenCalledWith({ profile: 'production' });
  });

  it('профиль не назван — команды идут с конфигурацией сервера по умолчанию', async () => {
    putFile('/srv/app.js', 'payload');

    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );
    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
        verify: false,
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });

  it('проба существования цели идёт с той же конфигурацией', async () => {
    await textOf(
      call('ssh_upload', {
        profile: 'production',
        local_path: localFile,
        remote_path: '/srv/app.js',
        overwrite: false,
        verify: false,
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });

  it('загрузка файла: сверка и замена идут на один сервер', async () => {
    await textOf(
      call('ssh_upload', {
        profile: 'production',
        local_path: localFile,
        remote_path: '/srv/app.js',
        mode: '644',
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });

  it('загрузка под sudo: уборка промежуточного файла идёт туда же', async () => {
    await textOf(
      call('ssh_upload', {
        profile: 'production',
        local_path: localFile,
        remote_path: '/etc/app.conf',
        sudo: true,
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });

  it('скачивание файла: та же конфигурация у пробы вида и у сверки', async () => {
    putFile('/srv/app.js', 'payload');

    await textOf(
      call('ssh_download', {
        profile: 'production',
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });

  it('загрузка каталога: уборка, сверка и замена идут на один сервер', async () => {
    putFile('/srv/app/old.js', 'old');

    await textOf(
      call('ssh_upload', {
        profile: 'production',
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        mode: '750',
      })
    );

    expect(sentCommands().length).toBeGreaterThan(4);
    expect(configsOf()).toEqual([profile.config]);
  });

  it('скачивание каталога: то же самое на обратном пути', async () => {
    putFile('/srv/app/index.js', 'x');

    await textOf(
      call('ssh_download', {
        profile: 'production',
        remote_path: '/srv/app',
        local_path: join(localDir, 'pulled'),
      })
    );

    expect(configsOf()).toEqual([profile.config]);
  });
});

/**
 * По умолчанию путь перезаписывается — и это тоже проверка: молчаливый отказ
 * «уже существует» на каждой второй загрузке ломал бы обычную работу.
 */
describe('перезапись по умолчанию', () => {
  it('занятый файл заменяется новым содержимым', async () => {
    putFile('/srv/app.js', 'old');

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(text).toContain('Upload OK');
    expect(server.get('/srv/app.js')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('занятый каталог заменяется целиком, старого файла в нём не остаётся', async () => {
    putFile('/srv/app/old.js', 'old');

    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    expect(text).toContain('Upload OK');
    expect(server.has('/srv/app/old.js')).toBe(false);
    expect(server.get('/srv/app/app.js')).toEqual({ kind: 'file', content: 'run();' });
  });
});

/**
 * Расхождение — единственный исход, по которому установщик сносит уже уехавшее.
 * Значит и назван он должен быть точно: что за операция и какие файлы.
 */
describe('сверка не сошлась', () => {
  /** Транспорт довозит не то, что взял */
  function corruptOnUpload(names: string[]): void {
    uploadMock.mockImplementation(async (source: string, target: string) => {
      putDir(target);
      for (const rel of await listTreeFiles(source)) {
        const content = names.includes(rel) ? 'corrupted' : readFileSync(join(source, rel), 'utf8');
        putFile(join(target, rel), content);
      }
    });
  }

  it('названы операция и оба файла — склейка списка не теряет второй', async () => {
    corruptOnUpload(['app.js', 'conf/app.ini']);

    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    const staged = uploadMock.mock.calls[0][1] as string;
    expect(text).toBe(
      `Error: sha256 mismatch after upload: 2 file(s) differ — ` +
        `${staged}/app.js, ${staged}/conf/app.ini`
    );
    // Целого дерева на боевом пути не появилось, временное убрано
    expect(server.has('/srv/app')).toBe(false);
    expect(server.has(staged)).toBe(false);
  });

  it('шесть расхождений: число честное, перечислены первые пять', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}.txt`);
    const wide = join(localDir, 'wide');
    mkdirSync(wide);
    for (const name of names) writeFileSync(join(wide, name), name, 'utf8');
    corruptOnUpload(names);

    const text = await textOf(
      call('ssh_upload', { local_path: wide, remote_path: '/srv/wide', recursive: true })
    );

    expect(text).toContain('6 file(s) differ');
    expect(text).toContain('e.txt');
    expect(text).not.toContain('f.txt');
  });

  it('скачивание: прежний файл у человека остаётся на месте', async () => {
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'existing.js');
    writeFileSync(target, 'mine', 'utf8');
    downloadMock.mockImplementation(async (_source: string, local: string) => {
      writeFileSync(local, 'truncated', 'utf8');
    });

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app.js', local_path: target })
    );

    expect(text).toContain('sha256 mismatch after download');
    expect(readFileSync(target, 'utf8')).toBe('mine');
  });

  it('одиночный файл: названа операция и сам путь', async () => {
    uploadMock.mockImplementation(async (_source: string, target: string) => {
      putFile(target, 'corrupted');
    });

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js' })
    );

    const staged = uploadMock.mock.calls[0][1] as string;
    expect(text).toBe(`Error: sha256 mismatch after upload: 1 file(s) differ — ${staged}`);
    expect(server.has('/srv/app.js')).toBe(false);
  });

  it('под sudo расхождение тоже названо загрузкой', async () => {
    uploadMock.mockImplementation(async (_source: string, target: string) => {
      putFile(target, 'corrupted');
    });

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/etc/app.conf', sudo: true })
    );

    expect(text).toContain('sha256 mismatch after upload');
  });

  it('скачивание каталога называет свою операцию, а не чужую', async () => {
    putFile('/srv/app/index.js', 'x');
    downloadMock.mockImplementation(async (_source: string, local: string) => {
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, 'index.js'), 'truncated', 'utf8');
    });

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: join(localDir, 'pulled') })
    );

    expect(text).toContain('sha256 mismatch after download');
  });

  it('обычная загрузка сверяется без sudo — лишний sudo спрашивал бы пароль', async () => {
    await textOf(call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js' }));

    expect(commandFor(/^sha256sum /)![1].sudo).toBeFalsy();
  });
});

/**
 * Тип цели обязан совпасть с тем, что ставим: иначе переименование вложит одно
 * в другое и отчитается успехом.
 */
describe('на пути лежит не то, что ставим', () => {
  it('файл поверх каталога — отказ с названием обоих видов', async () => {
    putDir('/srv/app.js');

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(text).toBe('Error: cannot install file over an existing directory: /srv/app.js');
  });

  it('каталог поверх файла — тоже отказ', async () => {
    putFile('/srv/app', 'occupied');

    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    expect(text).toBe('Error: cannot install directory over an existing file: /srv/app');
  });

  it('скачанный каталог поверх локального файла — отказ, файл цел', async () => {
    putFile('/srv/app/index.js', 'x');
    const target = join(localDir, 'occupied');
    writeFileSync(target, 'mine', 'utf8');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: target, verify: false })
    );

    expect(text).toBe(`Error: cannot install directory over an existing file: ${target}`);
    expect(readFileSync(target, 'utf8')).toBe('mine');
  });
});

/**
 * Потолок принадлежит операции целиком. Названный один раз, он обязан дойти до
 * каждой её части — иначе стена просто переезжает на сверку.
 *
 * Сверке достаётся остаток: сколько минуло до неё, столько и вычтено. Поэтому
 * сверяется не точное число, а что срок тот же самый и не начат заново.
 */
function expectRemainderOf(actual: number | undefined, named: number): void {
  expect(actual).toBeLessThanOrEqual(named);
  expect(actual).toBeGreaterThan(named - 5_000);
}

describe('названный потолок доезжает до сверки', () => {
  it('каталог вверх', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        timeout: 900_000,
      })
    );

    expectRemainderOf(commandFor(/^sha256sum /)![1].timeout, 900_000);
  });

  it('файл вниз', async () => {
    putFile('/srv/app.js', 'payload');

    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
        timeout: 900_000,
      })
    );

    expectRemainderOf(commandFor(/^sha256sum /)![1].timeout, 900_000);
  });

  it('каталог вниз', async () => {
    putFile('/srv/app/index.js', 'x');

    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app',
        local_path: join(localDir, 'pulled'),
        timeout: 900_000,
      })
    );

    expectRemainderOf(commandFor(/^sha256sum /)![1].timeout, 900_000);
  });
});

describe('форма ответа и отказы до первой команды', () => {
  it('каждый маршрут отвечает одним текстовым блоком, и отказ тоже', async () => {
    putFile('/srv/pull/index.js', 'x');
    const requests = [
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false }),
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      }),
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
        verify: false,
      }),
      call('ssh_download', {
        remote_path: '/srv/pull',
        local_path: join(localDir, 'pulled'),
        verify: false,
      }),
      call('ssh_upload', {}),
    ];

    for (const request of requests) {
      const answer = await new TransferTool().handleCall(request);
      expect(answer.content).toHaveLength(1);
      expect(answer.content[0].type).toBe('text');
    }
  });

  it('чужое имя инструмента называется в отказе', async () => {
    const text = await textOf(call('ssh_transfer', { local_path: localFile }));

    expect(text).toBe('Error: Unknown transfer tool: ssh_transfer');
  });

  it('отказ без remote_path показывает, как выглядит нужное значение', async () => {
    const text = await textOf(call('ssh_upload', { local_path: localFile }));

    expect(text).toBe(
      'Error: remote_path must be a non-empty string like "/opt/app", got nothing'
    );
  });

  it('у скачивания в примере свой путь — файл, а не каталог', async () => {
    const text = await textOf(call('ssh_download', { remote_path: '/srv/app.js' }));

    expect(text).toBe(
      'Error: local_path must be a non-empty string like "./app.conf", got nothing'
    );
  });

  it('второй путь загрузки объясняется своим примером', async () => {
    const text = await textOf(call('ssh_upload', { remote_path: '/opt/app' }));

    expect(text).toBe('Error: local_path must be a non-empty string like "./dist", got nothing');
  });

  it('второй путь скачивания — тоже', async () => {
    const text = await textOf(call('ssh_download', { local_path: './app.conf' }));

    expect(text).toBe(
      'Error: remote_path must be a non-empty string like "/opt/app/app.conf", got nothing'
    );
  });

  /**
   * Сырое исключение узла читается как поломка инструмента, хотя это обычный
   * ответ: файла по названному пути нет.
   */
  it('отсутствующий локальный файл объясняется словами, а не кодом ENOENT', async () => {
    const missing = join(localDir, 'no-such.txt');

    const text = await textOf(
      call('ssh_upload', { local_path: missing, remote_path: '/srv/app.js', verify: false })
    );

    expect(text).toBe(`Error: local_path does not exist: ${missing}`);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  /**
   * Таймер Node ждёт не дольше 2^31−1 мс. Само это значение он ещё умеет
   * отсчитать, а всё, что больше, срабатывает немедленно — и такое читается
   * как «без потолка», а не как мгновенный обрыв.
   */
  it('предельное для таймера значение ещё принимается', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: 2_147_483_647,
      })
    );

    expect(uploadMock.mock.calls[0][2]?.timeoutMs).toBe(2_147_483_647);
  });

  it('на единицу больше предела означает «без потолка»', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: 2_147_483_648,
      })
    );

    expect(uploadMock.mock.calls[0][2]?.timeoutMs).toBeUndefined();
  });

  it('потолок объектом отклоняется целым сообщением', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: {},
      })
    );

    expect(text).toBe(
      'Error: timeout must be a positive number of milliseconds, got {}. ' +
        'Omit the parameter to run without a limit.'
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('пустое значение потолка читается как «не называли»', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: null,
      })
    );

    expect(uploadMock.mock.calls[0][2]?.timeoutMs).toBeUndefined();
  });

  /**
   * Сорванная проверка раньше отвечала «файла нет», и запрет перезаписи
   * пропускал запись поверх цели, которую не сумел разглядеть.
   */
  it('сорванная проверка существования не выдаётся за «файла нет»', async () => {
    refusals = [[/^test -e /, { stderr: 'test: command not found', exitCode: 127 }]];
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (/^test -e /.test(command)) throw new Error('connection reset');
      return answer(command);
    });

    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        overwrite: false,
        verify: false,
      })
    );

    expect(text).toContain('cannot tell whether /srv/app.js already exists');
    expect(text).not.toContain('Upload OK');
  });

  it('с разрешённой перезаписью та же неудача загрузку не останавливает', async () => {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (/^test -e /.test(command)) throw new Error('connection reset');
      return answer(command);
    });

    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        overwrite: true,
        verify: false,
      })
    );

    expect(text).toContain('Upload OK');
  });
});

/** Имена инструментов и обязательные поля — граница совместимости с npm */
describe('объявление инструментов', () => {
  const tools = new TransferTool().getTools();
  const propertiesOf = (tool: (typeof tools)[number]) =>
    Object.entries(tool.inputSchema.properties as Record<string, { type?: string; description?: string }>);

  it('инструмента ровно два, и имена у них прежние', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['ssh_upload', 'ssh_download']);
  });

  it('оба требуют пару путей и ничего сверх того', () => {
    expect(tools.map((tool) => tool.inputSchema.required)).toEqual([
      ['local_path', 'remote_path'],
      ['remote_path', 'local_path'],
    ]);
  });

  it('умолчания названы у обоих — по ним вызывающий судит, что будет без параметра', () => {
    const [upload, download] = tools.map(
      (tool) => tool.inputSchema.properties as Record<string, { default?: unknown }>
    );

    expect(upload.atomic.default).toBe(true);
    expect(upload.verify.default).toBe(true);
    expect(upload.sudo.default).toBe(false);
    expect(upload.overwrite.default).toBe(true);
    expect(download.verify.default).toBe(true);
  });

  /**
   * Схему читает не человек, а клиент: безымянный тип и пустое описание
   * означают, что параметр для агента не существует.
   */
  it('у каждого параметра назван тип и сказано, что он делает', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');

      for (const [name, field] of propertiesOf(tool)) {
        expect(`${tool.name}.${name}: ${field.type}`).toMatch(/: (string|number|boolean)$/);
        expect(`${tool.name}.${name}: ${field.description ?? ''}`.length).toBeGreaterThan(
          `${tool.name}.${name}: `.length
        );
      }
    }
  });

  it('оба знают про потолок передачи и про отменённую настройку параллельности', () => {
    for (const tool of tools) {
      const names = propertiesOf(tool).map(([name]) => name);
      expect(names).toContain('timeout');
      expect(names).toContain('concurrency');
    }
  });
});

/**
 * Ответ `test` — это две буквы, по которым принимается решение о чужих данных:
 * перезаписывать ли путь и что именно с него качать.
 */
describe('разбор ответа о том, что лежит на пути', () => {
  it('overwrite=false над занятым путём отказывает до передачи', async () => {
    putFile('/srv/app.js', 'old');

    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        overwrite: false,
        verify: false,
      })
    );

    expect(text).toContain('already exists and overwrite=false');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(commandFor(/^test -e /)![0]).toBe(`test -e '/srv/app.js' && echo YES || echo NO`);
    // Старое содержимое не тронуто
    expect(server.get('/srv/app.js')).toEqual({ kind: 'file', content: 'old' });
  });

  it('overwrite=false над свободным путём передаче не мешает', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        overwrite: false,
        verify: false,
      })
    );

    expect(text).toContain('Upload OK');
    expect(server.get('/srv/app.js')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('занятый каталог под overwrite=false назван каталогом, а не файлом', async () => {
    putDir('/srv/app');

    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        overwrite: false,
        verify: false,
      })
    );

    expect(text).toContain('remote directory already exists and overwrite=false');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('overwrite=false над свободным каталогом передаче не мешает', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        overwrite: false,
        verify: false,
      })
    );

    expect(text).toContain('Upload OK');
    expect(server.get('/srv/app/app.js')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('каталог на сервере скачивается рекурсивно без подсказки от вызывающего', async () => {
    putFile('/srv/app/index.js', 'x');
    const target = join(localDir, 'pulled');

    await textOf(call('ssh_download', { remote_path: '/srv/app', local_path: target, verify: false }));

    expect(commandFor(/^test -d /)![0]).toBe(`test -d '/srv/app' && echo YES || echo NO`);
    expect(downloadMock.mock.calls[0][2]).toMatchObject({ recursive: true });
  });

  it('файл на сервере скачивается как файл', async () => {
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'pulled.js');

    await textOf(call('ssh_download', { remote_path: '/srv/app.js', local_path: target, verify: false }));

    expect(downloadMock.mock.calls[0][2]?.recursive).toBeUndefined();
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });

  it('названный вид пути сервер не переспрашивает', async () => {
    putFile('/srv/app.js', 'payload');

    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: join(localDir, 'pulled.js'),
        recursive: false,
        verify: false,
      })
    );

    expect(commandFor(/^test -d /)).toBeUndefined();
  });
});

describe('отказы, которые случаются до первой команды', () => {
  it('рекурсивная загрузка под sudo не поддержана и ничего не делает', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/etc/app',
        recursive: true,
        sudo: true,
      })
    );

    expect(text).toContain('Recursive sudo upload is not yet supported');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('пустой каталог не уезжает на сервер', async () => {
    const empty = join(localDir, 'empty');
    mkdirSync(empty);

    const text = await textOf(
      call('ssh_upload', { local_path: empty, remote_path: '/srv/empty', recursive: true })
    );

    expect(text).toContain('local directory is empty');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('recursive над обычным файлом — ошибка, а не тихая загрузка файла', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app', recursive: true })
    );

    expect(text).toContain('local_path is not a directory but recursive=true');
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

/**
 * Права ставятся до замены — на временный путь. Иначе дерево какое-то время
 * живёт на боевом пути с чужим доступом.
 */
describe('права применяются к временному пути', () => {
  it('файл: chmod идёт по staging и до переименования', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        mode: '640',
        verify: false,
      })
    );

    const staged = uploadMock.mock.calls[0][1] as string;
    expect(commandFor(/^chmod /)![0]).toBe(`chmod 640 -- '${staged}'`);

    const order = sentCommands().map(([command]) => command);
    expect(order.findIndex((c) => c.startsWith('chmod'))).toBeLessThan(
      order.findIndex((c) => c.startsWith('mv -T'))
    );
  });

  it('каталог: обход дерева идёт без потолка, пока его не назвали', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        mode: '750',
        verify: false,
      })
    );

    const staged = uploadMock.mock.calls[0][1] as string;
    expect(commandFor(/^chmod /)![0]).toBe(`chmod -R 750 -- '${staged}'`);
    expect(commandFor(/^chmod /)![1].timeout).toBe(0);
  });

  it('каталог: названный потолок доезжает и до обхода дерева', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        mode: '750',
        verify: false,
        timeout: 900_000,
      })
    );

    expect(commandFor(/^chmod /)![1].timeout).toBe(900_000);
  });
});

/**
 * Текст ответа — единственное, что видит агент, и сверяется он целиком:
 * по кускам ни отступы, ни порядок строк не проверяет никто.
 */
describe('текст ответа', () => {
  it('файл без сверки', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(text).toBe(
      [
        '✓ Upload OK: /srv/app.js',
        '  bytes: 6',
        '  sha256: skipped',
        '  atomic: true',
        '  sudo: false',
      ].join('\n')
    );
  });

  it('файл со сверкой называет хэш', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js' })
    );

    expect(text).toBe(
      [
        '✓ Upload OK: /srv/app.js',
        '  bytes: 6',
        `  sha256: ${sha256Of('run();')} (verified)`,
        '  atomic: true',
        '  sudo: false',
      ].join('\n')
    );
  });

  it('каталог считает файлы и байты, общего хэша у него нет', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    expect(text).toBe(
      [
        '✓ Upload OK: /srv/app',
        '  files: 2',
        '  bytes: 15',
        '  sha256: verified (2 files)',
        '  atomic: true',
        '  sudo: false',
      ].join('\n')
    );
  });

  it('сверять было нечем — это успех с названной причиной', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js' })
    );

    expect(text).toBe(
      [
        '✓ Upload OK: /srv/app.js',
        '  bytes: 6',
        '  sha256: skipped — neither sha256sum nor openssl is available on the server',
        '  atomic: true',
        '  sudo: false',
      ].join('\n')
    );
  });

  it('предупреждение о чужом доме печатается отдельным блоком', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '~/app.conf',
        sudo: true,
        verify: false,
      })
    );

    expect(text).toBe(
      [
        '✓ Upload OK: /home/deploy/app.conf',
        '  bytes: 6',
        '  sha256: skipped',
        '  atomic: true',
        '  sudo: true',
        '  warnings:',
        '    - "~/app.conf" points at /home/deploy/app.conf — the home of the login user, ' +
          "not root's. Pass an absolute path if you meant a different directory.",
      ].join('\n')
    );
  });

  it('неубранная старая копия названа адресом — данные на месте, но диск занят', async () => {
    putFile('/srv/app/old.js', 'old');
    refusals = [[/^rm -rf -- '\/srv\/\.bak-/, { stderr: 'rm: Permission denied' }]];

    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    expect(text.replace(/\.bak-[0-9a-f]+\./g, '.bak-<rand>.')).toBe(
      [
        '✓ Upload OK: /srv/app',
        '  files: 2',
        '  bytes: 15',
        '  sha256: skipped',
        '  atomic: true',
        '  sudo: false',
        '  warnings:',
        "    - the previous copy is still on the server at /srv/.bak-<rand>.app: " +
          "Command failed (exit 1): rm -rf -- '/srv/.bak-<rand>.app' — rm: Permission denied",
      ].join('\n')
    );
    // Новое дерево стоит на месте, старое рядом — целых копий две, а не ноль
    expect(server.get('/srv/app/app.js')).toEqual({ kind: 'file', content: 'run();' });
  });

  it('скачанный файл', async () => {
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'pulled.js');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app.js', local_path: target })
    );

    expect(text).toBe(
      [`✓ Downloaded file: /srv/app.js -> ${target}`, '  bytes: 7', '  sha256: verified'].join('\n')
    );
  });

  it('скачанный каталог', async () => {
    putFile('/srv/app/index.js', 'x');
    putFile('/srv/app/conf/app.ini', 'y');
    const target = join(localDir, 'pulled');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: target })
    );

    expect(text).toBe(
      [`✓ Downloaded directory: /srv/app -> ${target}`, '  files: 2', '  sha256: verified (2 files)'].join(
        '\n'
      )
    );
  });

  it('скачивание без сверки не выдаёт себя за проверенное', async () => {
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'pulled.js');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app.js', local_path: target, verify: false })
    );

    expect(text).toBe(
      [`✓ Downloaded file: /srv/app.js -> ${target}`, '  bytes: 7', '  sha256: skipped'].join('\n')
    );
  });

  it('скачанный каталог без сверки не выдаёт себя за проверенный', async () => {
    putFile('/srv/app/index.js', 'x');
    const target = join(localDir, 'pulled');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: target, verify: false })
    );

    expect(text).toBe(
      [`✓ Downloaded directory: /srv/app -> ${target}`, '  files: 1', '  sha256: skipped'].join('\n')
    );
  });

  it('двух предупреждений — две строки, а не одна склеенная', async () => {
    putFile('/srv/app/old.js', 'old');
    putFile('/srv/.upload-abc123.app/leftover.js', 'stale');
    refusals = [[/^rm -rf -- '\/srv\/\.bak-/, { stderr: 'rm: Permission denied' }]];

    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    const warnings = text.split('\n  warnings:\n')[1].split('\n');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("leftovers from an interrupted operation");
    expect(warnings[0]).toContain("'/srv/.upload-abc123.app'");
    expect(warnings[1]).toContain('the previous copy is still on the server');
  });

  it('непроверенный путь при скачивании назван человеку, а не забыт', async () => {
    profile.config = {
      host: 'example.com',
      username: 'deploy',
      port: 22,
      pathSecurity: { allowedPaths: ['/srv'] },
    };
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'pulled.js');

    const text = await textOf(
      call('ssh_download', {
        profile: 'production',
        remote_path: '/srv/app.js',
        local_path: target,
        verify: false,
      })
    );

    expect(text).toBe(
      [
        `✓ Downloaded file: /srv/app.js -> ${target}`,
        '  bytes: 7',
        '  sha256: skipped',
        '  warnings:',
        '    - "/srv/app.js" was checked by name only: the server could not resolve it, ' +
          'so a symlink pointing elsewhere would go unnoticed.',
      ].join('\n')
    );
    // Куда ведёт путь, спрашивают на том же сервере, что и качают
    expect(executeMock.mock.calls.every(([config]) => config === profile.config)).toBe(true);
  });

  it('непроверенный путь называется и при скачивании каталога', async () => {
    profile.config = {
      host: 'example.com',
      username: 'deploy',
      port: 22,
      pathSecurity: { allowedPaths: ['/srv'] },
    };
    putFile('/srv/app/index.js', 'x');
    const target = join(localDir, 'pulled');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: target, verify: false })
    );

    expect(text).toBe(
      [
        `✓ Downloaded directory: /srv/app -> ${target}`,
        '  files: 1',
        '  sha256: skipped',
        '  warnings:',
        '    - "/srv/app" was checked by name only: the server could not resolve it, ' +
          'so a symlink pointing elsewhere would go unnoticed.',
      ].join('\n')
    );
  });

  it('скачанное остаётся у человека, даже когда сверять было нечем', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));
    putFile('/srv/app.js', 'payload');
    const target = join(localDir, 'pulled.js');

    const text = await textOf(
      call('ssh_download', { remote_path: '/srv/app.js', local_path: target })
    );

    expect(text).toBe(
      [
        `✓ Downloaded file: /srv/app.js -> ${target}`,
        '  bytes: 7',
        '  sha256: skipped — neither sha256sum nor openssl is available on the server',
      ].join('\n')
    );
    expect(readFileSync(target, 'utf8')).toBe('payload');
  });
});

/**
 * Названного владельца нельзя терять молча: `chown` работает только под sudo,
 * а без него файл остаётся за тем, кто подключился. У каталога `chown` не
 * вызывается вовсе — рекурсивная отправка под sudo не поддерживается.
 */
describe('ssh_upload: владелец без sudo', () => {
  it('файл: ответ говорит, что владелец не применён', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        owner: 'daemon:daemon',
        verify: false,
      })
    );

    expect(text).toContain('✓ Upload OK: /srv/app.js');
    expect(text).toContain('owner was NOT applied: chown needs sudo');
    expect(commandFor(/^chown /)).toBeUndefined();
  });

  it('каталог: ответ говорит то же самое', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        owner: 'daemon:daemon',
        mode: '700',
      })
    );

    expect(text).toContain('owner was NOT applied: chown needs sudo');
    expect(commandFor(/^chmod -R /)![0]).toContain('chmod -R 700');
    expect(commandFor(/^chown /)).toBeUndefined();
  });

  it('без владельца предупреждения нет', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(text).not.toContain('owner was NOT applied');
  });
});
