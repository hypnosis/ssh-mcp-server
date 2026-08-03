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

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    SSHExecutor: class {
      execute = executeMock;
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
  getDefaultProfile: () => 'production',
}));

const { TransferTool } = await import('../../src/tools/transfer-tool.js');

/** Ответы транспорта по образцу команды; всё, что не совпало, отвечает успехом */
function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    return { stdout: '', stderr: '', exitCode: 0, ...(match?.[1] ?? {}) };
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
    expect(callFor(/^mv -f/)).toBeDefined();
  });

  it('создаёт родительский каталог до передачи', async () => {
    await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app/app.js', verify: false })
    );

    expect(callFor(/^mkdir -p '\/srv\/app'/)).toBeDefined();
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

  it('проверяет хэши всех файлов одной командой со stdin', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    const check = callFor(/sha256sum -c/);
    expect(check).toBeDefined();
    const manifest = check![2].stdin as string;
    expect(manifest).toContain(await sha256OfFile(localFile));
    expect(manifest).toContain(await sha256OfFile(join(localDir, 'conf', 'app.ini')));
    // Поштучной проверки больше нет
    expect(executeMock.mock.calls.filter(([, c]) => /sha256sum /.test(c as string))).toHaveLength(
      1
    );
    expect(text).toContain('Upload OK');
  });

  it('несовпадение хэша называет файл и отменяет загрузку', async () => {
    respondWith([
      [/sha256sum -c/, { exitCode: 1, stdout: '/srv/app.staging/conf/app.ini: FAILED\n' }],
    ]);

    const text = await textOf(
      call('ssh_upload', { local_path: localDir, remote_path: '/srv/app', recursive: true })
    );

    expect(text).not.toContain('Upload OK');
    expect(text).toContain('conf/app.ini');
  });

  it('без sha256sum на сервере загрузка идёт дальше, но проверка честно помечена пропущенной', async () => {
    respondWith([[/sha256sum -c/, { stdout: 'NO_SHA256_TOOL\n' }]]);

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

    expect(downloadMock).toHaveBeenCalledWith('/srv/app.js', target, expect.anything());
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

    const check = callFor(/sha256sum -c/);
    expect(check).toBeDefined();
    // Проверяются удалённые пути, а не локальные копии
    expect(check![2].stdin as string).toContain('/srv/app/index.js');
  });
});
