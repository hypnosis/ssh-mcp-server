/**
 * Unit tests: сверка глазами инструментов
 *
 * Два регресса, ради которых это писалось:
 *  - сервер без sha256sum и openssl отвечал «Failed to verify» на исправной
 *    передаче, а обработчик ошибки шёл удалять только что записанный файл;
 *  - проверка каталога уходила командой с длинной опцией `--quiet`, которой
 *    нет у BusyBox, — и на Alpine исправная передача выглядела испорченной.
 *
 * Плюс третье, найденное по дороге: при sudo-загрузке несовпадение хэша
 * возвращалось как «проверку пропустили», то есть подмена выдавалась за успех.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';

const { executeMock, passportMock, uploadMock, downloadMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
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

vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ upload: uploadMock, download: downloadMock }),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

function passport(overrides: Record<string, unknown> = {}) {
  return { ...UNKNOWN_PASSPORT, known: true, sha256: 'sha256sum', coreutils: 'coreutils', ...overrides };
}

function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    if (match) return { stdout: '', stderr: '', exitCode: 0, truncated: false, ...match[1] };
    // Разведка типа цели: по умолчанию путь свободен
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

/** Все команды, ушедшие на сервер */
function sentCommands(): string[] {
  return executeMock.mock.calls.map((args) => args[1] as string);
}

let localDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  passportMock.mockResolvedValue(passport());
  respondWith([]);
  localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-verify-test-'));
  localFile = join(localDir, 'payload.txt');
  writeFileSync(localFile, 'hello', 'utf8');
});

afterEach(() => {
  rmSync(localDir, { recursive: true, force: true });
});

describe('сервер, на котором нечем считать хэши', () => {
  it('загрузка файла удаётся, а проверка честно помечена пропущенной', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'none' }));

    const response = await new TransferTool().handleCall(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.conf' })
    );

    const text = response.content[0].text;
    expect(text).toContain('Upload OK');
    expect(text).not.toContain('Failed to verify');
    expect(text).toMatch(/skipped/);
  });

  it('только что записанный файл никто не удаляет', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'none' }));

    await new TransferTool().handleCall(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.conf', atomic: false })
    );

    expect(sentCommands().some((command) => /^rm -f .*app\.conf/.test(command))).toBe(false);
  });

  it('запись файла через ssh_file_write тоже не превращается в ошибку', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'none' }));

    const response = await new FileTools().handleCall(
      call('ssh_file_write', {
        files: [{ path: '/srv/app.conf', content: 'key = value', verify: true }],
      })
    );

    expect(response.content[0].text).not.toContain('Failed to verify');
  });

  it('скачивание файла удаётся с пометкой вместо ошибки', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'none' }));
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      writeFileSync(local, 'hello', 'utf8');
    });

    const response = await new TransferTool().handleCall(
      call('ssh_download', {
        remote_path: '/srv/app.conf',
        local_path: join(localDir, 'downloaded.txt'),
      })
    );

    expect(response.content[0].text).toContain('Downloaded file');
    expect(response.content[0].text).toMatch(/skipped/);
  });
});

describe('сверка идёт командой, понятной минимальному набору утилит', () => {
  it('ни длинных опций, ни манифеста на stdin', async () => {
    respondWith([
      [/^sha256sum/, { stdout: `${'0'.repeat(64)}  /srv/app.conf` }],
    ]);

    await new TransferTool().handleCall(
      call('ssh_upload', { local_path: localFile, remote_path: '/srv/app.conf', atomic: false })
    );

    const hashing = sentCommands().find((command) => command.startsWith('sha256sum'));
    expect(hashing).toBeDefined();
    expect(hashing).not.toContain('--quiet');
    expect(executeMock.mock.calls.every((args) => !(args[2] as any)?.stdin)).toBe(true);
  });
});

describe('несовпадение хэша — это провал, а не пропуск', () => {
  it('при загрузке под sudo подмена не выдаётся за «проверку пропустили»', async () => {
    respondWith([[/^sha256sum/, { stdout: `${'f'.repeat(64)}  /srv/app.conf` }]]);

    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.conf',
        sudo: true,
      })
    );

    const text = response.content[0].text;
    expect(text).toMatch(/mismatch/i);
    expect(text).not.toContain('Upload OK');
  });
});
