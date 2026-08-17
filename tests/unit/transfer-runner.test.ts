/**
 * Unit tests: передача файлов идёт через транспорт
 *
 * Раньше ssh_upload и ssh_download открывали свой SFTP-канал прямо из пула,
 * поэтому на бэкенде openssh они бы просто не работали. Теперь инструмент
 * знает только про CommandRunner, а проверка хэшей каталога делается одной
 * командой вместо запуска sha256sum на каждый файл.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteOptions, SSHExecuteResult } from '../../src/managers/ssh-executor.js';
import { sha256OfFile } from '../../src/utils/sha256.js';

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

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

/** Сервер с обычным набором утилит */
function fullPassport(overrides: Record<string, unknown> = {}) {
  return { ...UNKNOWN_PASSPORT, known: true, sha256: 'sha256sum', coreutils: 'coreutils', ...overrides };
}

/**
 * Отвечать на подсчёт хэшей настоящими значениями локальных файлов.
 * Соответствие ищется по имени файла: staging-путь и локальный отличаются
 * только каталогом.
 */
function answerHashes(files: Map<string, string>, corrupt?: string): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (!command.startsWith('sha256sum')) {
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }
    const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const lines = paths.map((path) => {
      const name = path.split('/').slice(-2).join('/');
      const hash = path.endsWith(corrupt ?? '\u0000') ? 'f'.repeat(64) : files.get(name) ?? files.get(path.split('/').pop()!);
      return `${hash}  ${path}`;
    });
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0, truncated: false };
  });
}

/** Ответы транспорта по образцу команды; всё, что не совпало, отвечает успехом */
function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    if (match) return { stdout: '', stderr: '', exitCode: 0, ...match[1] };
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

/** Вызов транспорта по образцу команды */
function callFor(pattern: RegExp): [unknown, string, SSHExecuteOptions] | undefined {
  return executeMock.mock.calls.find(([, command]) => pattern.test(command as string)) as
    | [unknown, string, SSHExecuteOptions]
    | undefined;
}

async function textOf(request: CallToolRequest): Promise<string> {
  const response = await new TransferTool().handleCall(request);
  return response.content[0].text as string;
}

let localDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
  passportMock.mockResolvedValue(fullPassport());
  uploadMock.mockResolvedValue(undefined);
  downloadMock.mockResolvedValue(undefined);

  localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-transfer-'));
  localFile = join(localDir, 'app.js');
  writeFileSync(localFile, 'run();', 'utf8');
  mkdirSync(join(localDir, 'conf'));
  writeFileSync(join(localDir, 'conf', 'app.ini'), 'key=value', 'utf8');
});

afterEach(() => {
  rmSync(localDir, { recursive: true, force: true });
});

describe('ssh_upload: файл', () => {
  it('передаёт файл через транспорт, а не через собственный SFTP-канал', async () => {
    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [source, target] = uploadMock.mock.calls[0];
    expect(source).toBe(localFile);
    // Атомарность по умолчанию: сначала временный путь рядом с целью, потом mv
    expect(target).toMatch(/^\/srv\/\.upload-[0-9a-f]+\.app\.js$/);
    // Замена только через `mv -T`: обычный `mv` при занятой цели вложил бы файл внутрь
    expect(callFor(/^mv -T --/)).toBeDefined();
  });

  it('создаёт родительский каталог до передачи, и ровно одной командой', async () => {
    // Что успело уйти на сервер к моменту, когда транспорт начал передачу
    const beforeUpload: string[] = [];
    uploadMock.mockImplementation(async () => {
      beforeUpload.push(...executeMock.mock.calls.map(([, command]) => command as string));
    });

    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app/app.js', verify: false })
    );

    const mkdirs = beforeUpload.filter((command) => command.startsWith('mkdir -p'));
    // Каталог создаёт установщик — до того, как файл поедет
    expect(mkdirs).toEqual([`mkdir -p -- '/srv/app'`]);
  });

  it('несозданный родительский каталог — ошибка загрузки, а не «Upload OK»', async () => {
    respondWith([[/^mkdir -p/, { exitCode: 1, stderr: 'mkdir: Permission denied' }]]);

    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app/app.js', verify: false })
    );

    expect(text).not.toContain('Upload OK');
    expect(text).toContain('Permission denied');
  });
});

describe('ssh_upload: каталог', () => {
  it('уходит одним рекурсивным вызовом транспорта', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [source, target, options] = uploadMock.mock.calls[0];
    expect(source).toBe(localDir);
    expect(target).toMatch(/^\/srv\/\.upload-[0-9a-f]+\.app$/); // staging рядом с целью
    expect(options).toMatchObject({ recursive: true });
  });

  it('проверяет хэши всех файлов одной командой, имена идут аргументами', async () => {
    answerHashes(
      new Map([
        ['app.js', await sha256OfFile(localFile)],
        ['conf/app.ini', await sha256OfFile(join(localDir, 'conf', 'app.ini'))],
      ])
    );

    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    const hashing = executeMock.mock.calls.filter(([, c]) => /^sha256sum /.test(c as string));
    // Одна команда на весь каталог, без манифеста на stdin и без длинных опций
    expect(hashing).toHaveLength(1);
    expect(hashing[0][1]).toContain('app.js');
    expect(hashing[0][1]).toContain('conf/app.ini');
    expect(hashing[0][1]).not.toContain('--quiet');
    expect((hashing[0][2] as SSHExecuteOptions).stdin).toBeUndefined();
    expect(text).toContain('Upload OK');
  });

  it('несовпадение хэша называет файл и отменяет загрузку', async () => {
    answerHashes(
      new Map([['app.js', await sha256OfFile(localFile)]]),
      'conf/app.ini' // этот файл сервер вернёт изменённым
    );

    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    expect(text).not.toContain('Upload OK');
    expect(text).toContain('conf/app.ini');
  });

  it('без sha256sum на сервере загрузка идёт дальше, но проверка честно помечена пропущенной', async () => {
    passportMock.mockResolvedValue(fullPassport({ sha256: 'none' }));

    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    expect(text).toContain('Upload OK');
    expect(text).toContain('sha256: skipped');
  });
});

describe('ssh_download', () => {
  it('файл скачивается через транспорт', async () => {
    const target = join(localDir, 'downloaded.bin');
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      writeFileSync(local, 'payload', 'utf8');
    });

    const text = await textOf(
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: target,
        verify: false,
        recursive: false,
      })
    );

    // Транспорт льёт во временный путь рядом с целью; на место файл встаёт переименованием
    const [remote, written] = downloadMock.mock.calls[0];
    expect(remote).toBe('/srv/app.js');
    expect(written).toMatch(/\/\.upload-[0-9a-f]+\.downloaded\.bin$/);
    expect(text).toContain('bytes: 7');
  });

  it('каталог скачивается одним рекурсивным вызовом, файлы считаются по факту', async () => {
    const target = join(localDir, 'pulled');
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      mkdirSync(join(local, 'conf'), { recursive: true });
      writeFileSync(join(local, 'index.js'), 'x', 'utf8');
      writeFileSync(join(local, 'conf', 'app.ini'), 'y', 'utf8');
    });

    const text = await textOf(
      call('ssh_download', {
        remote_path: '/srv/app',
        local_path: target,
        recursive: true,
        verify: false,
      })
    );

    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock.mock.calls[0][2]).toMatchObject({ recursive: true });
    expect(text).toContain('files: 2');
  });

  it('скачанный каталог проверяется тем же батчем, что и загруженный', async () => {
    const target = join(localDir, 'pulled-verified');
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, 'index.js'), 'x', 'utf8');
    });

    await textOf(
      call('ssh_download', { remote_path: '/srv/app', local_path: target, recursive: true })
    );

    const check = callFor(/^sha256sum /);
    expect(check).toBeDefined();
    // Проверяются удалённые пути, а не локальные копии
    expect(check![1]).toContain('/srv/app/index.js');
  });
});

/**
 * Раньше передача жила под скрытым потолком в 300 секунд, и назвать свой
 * инструмент не давал: параметра не было ни в одной схеме. Теперь потолок
 * ставит вызывающий, а по умолчанию его нет — большое дерево едет сколько
 * едет, а зависший канал рвёт сам ssh.
 */
describe('таймаут передачи задаёт вызывающий', () => {
  const timeoutOf = (mock: typeof uploadMock): unknown =>
    (mock.mock.calls[0][2] as { timeoutMs?: number } | undefined)?.timeoutMs;

  it('файл вверх: значение доезжает до транспорта', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: 900_000,
      })
    );

    expect(timeoutOf(uploadMock)).toBe(900_000);
  });

  it('каталог вверх: значение доезжает до транспорта', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
        timeout: 900_000,
      })
    );

    expect(timeoutOf(uploadMock)).toBe(900_000);
  });

  it('файл вниз: значение доезжает до транспорта', async () => {
    const target = join(localDir, 'downloaded.bin');
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      writeFileSync(local, 'payload', 'utf8');
    });

    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app.js',
        local_path: target,
        recursive: false,
        verify: false,
        timeout: 900_000,
      })
    );

    expect(timeoutOf(downloadMock)).toBe(900_000);
  });

  it('каталог вниз: значение доезжает до транспорта', async () => {
    const target = join(localDir, 'pulled-timeout');
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, 'index.js'), 'x', 'utf8');
    });

    await textOf(
      call('ssh_download', {
        remote_path: '/srv/app',
        local_path: target,
        recursive: true,
        verify: false,
        timeout: 900_000,
      })
    );

    expect(timeoutOf(downloadMock)).toBe(900_000);
  });

  it('не назвали таймаут — транспорт не получает никакого', async () => {
    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false })
    );

    expect(timeoutOf(uploadMock)).toBeUndefined();
  });

  /**
   * Таймер Node не умеет ждать дольше 2^31−1 мс: большее значение он
   * отрабатывает немедленно. «Поставлю побольше, чтобы точно хватило»
   * оборачивалось бы мгновенным обрывом — читаем это как «без потолка».
   */
  it('значение сверх предела таймера означает «без потолка», а не мгновенный обрыв', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: 3_000_000_000,
      })
    );

    expect(timeoutOf(uploadMock)).toBeUndefined();
  });

  /**
   * У `ssh_exec` ноль читается как «значение по умолчанию». Принимать его
   * здесь в противоположном смысле — ловушка для того, кто зовёт оба
   * инструмента; способ сказать «не ограничивай» один: не называть параметр.
   */
  it('ноль отклоняется с подсказкой, как просить отсутствие потолка', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', verify: false, timeout: 0 })
    );

    expect(text).toContain('Omit the parameter');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('число строкой принимается: часть клиентов шлёт его так', async () => {
    await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: '900000',
      })
    );

    expect(timeoutOf(uploadMock)).toBe(900_000);
  });

  /**
   * Потолок стоит на операции, а не на одной её части. Иначе стена просто
   * переезжает: дерево на гигабайты доедет, а сверка хэшей упрётся в общие
   * для команд 30 секунд — и это при том, что verify включён по умолчанию.
   */
  it('сверка хэшей идёт без потолка, если его не называли', async () => {
    answerHashes(
      new Map([
        ['app.js', await sha256OfFile(localFile)],
        ['conf/app.ini', await sha256OfFile(join(localDir, 'conf', 'app.ini'))],
      ])
    );

    await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    const hashing = callFor(/^sha256sum /);
    expect(hashing![2].timeout).toBe(0);
  });

  it('названный таймаут распространяется и на сверку', async () => {
    answerHashes(new Map([['app.js', await sha256OfFile(localFile)]]));

    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.js', timeout: 900_000 })
    );

    // Сверке достаётся остаток названного срока: сколько минуло до неё, столько
    // и вычтено. Проверяем, что срок тот же самый, а не начат заново
    const hashing = callFor(/^sha256sum /);
    expect(hashing![2].timeout).toBeLessThanOrEqual(900_000);
    expect(hashing![2].timeout).toBeGreaterThan(895_000);
  });

  it('мусор вместо числа отклоняется до первой команды на сервере', async () => {
    const text = await textOf(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.js',
        verify: false,
        timeout: '300; id',
      })
    );

    expect(text).toContain('Error');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
