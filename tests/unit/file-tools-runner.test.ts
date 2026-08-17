/**
 * Unit tests: бинарные чтение и запись идут через транспорт
 *
 * ssh_file_write с binary=true и ssh_file_read с binary=true раньше открывали
 * SFTP-канал прямо из пула — на бэкенде openssh пула нет. Теперь оба пути
 * знают только про CommandRunner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';

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
}));

const { FileTools } = await import('../../src/tools/file-tools.js');

function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    if (match) return { stdout: '', stderr: '', exitCode: 0, ...match[1] };
    // Разведка типа цели у установщика: по умолчанию путь свободен
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

async function textOf(request: CallToolRequest): Promise<string> {
  const response = await new FileTools().handleCall(request);
  return response.content[0].text as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
  uploadMock.mockResolvedValue(undefined);
  downloadMock.mockResolvedValue(undefined);
});

/** Содержимое выше порога, за которым запись уходит транспортом */
const BIG = Buffer.alloc(300 * 1024, 0x41);

describe('ssh_file_write: крупное содержимое идёт транспортом', () => {
  it('отдаёт содержимое транспорту и убирает локальный временный файл', async () => {
    let staged: string | undefined;
    let stagedContent: Buffer | undefined;
    uploadMock.mockImplementation(async (local: string) => {
      staged = local;
      stagedContent = readFileSync(local);
    });

    const text = await textOf(
      call('ssh_file_write', {
        files: [
          {
            path: '/srv/logo.png',
            content: BIG.toString('base64'),
            binary: true,
          },
        ],
      })
    );

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(stagedContent?.equals(BIG)).toBe(true);
    // Временный каталог убирается сразу после передачи
    expect(existsSync(staged!)).toBe(false);
    expect(text).toContain('written successfully');
  });

  it('мелкое двоичное содержимое едет байтами в stdin, без второй передачи', async () => {
    const bytes = Buffer.from([0x00, 0x1a, 0x7f, 0xff, 0x0a]);

    await textOf(
      call('ssh_file_write', {
        files: [{ path: '/srv/small.bin', content: bytes.toString('base64'), binary: true }],
      })
    );

    expect(uploadMock).not.toHaveBeenCalled();
    const write = executeMock.mock.calls.find(([, c]) => (c as string).startsWith('cat >'));
    expect((write?.[2] as { stdin?: Buffer })?.stdin?.equals(bytes)).toBe(true);
  });

  it('запись кладёт файл на временный путь и заменяет цель переименованием', async () => {
    await textOf(
      call('ssh_file_write', {
        files: [{ path: '/srv/app.bin', content: BIG.toString('base64'), binary: true, atomic: true }],
      })
    );

    const target = uploadMock.mock.calls[0][1] as string;
    expect(target).toMatch(/^\/srv\/\.upload-[0-9a-f]+\.app\.bin$/);
    // Именно `-T`: обычный `mv` при занятой цели-каталоге вложил бы файл внутрь
    expect(executeMock.mock.calls.some(([, c]) => /^mv -T --/.test(c as string))).toBe(true);
  });

  it('sudo-запись передаётся в /tmp, а рядом с целью появляется копией под правами', async () => {
    await textOf(
      call('ssh_file_write', {
        files: [
          { path: '/etc/app.conf', content: BIG.toString('base64'), binary: true, sudo: true, atomic: true },
        ],
      })
    );

    expect(uploadMock.mock.calls[0][1] as string).toMatch(/^\/tmp\//);
    const commands = executeMock.mock.calls.map(([, c]) => c as string);
    // `install` копирует поверх цели, то есть стирает старое до записи нового —
    // поэтому копия делается рядом, а на место встаёт переименованием
    expect(commands.some((c) => /^install /.test(c))).toBe(false);
    expect(commands.some((c) => /^cp -- .*\.upload-/.test(c))).toBe(true);
    expect(commands.some((c) => /^mv -T --/.test(c))).toBe(true);
  });

  it('сбой передачи не выдаётся за успешную запись', async () => {
    uploadMock.mockRejectedValue(new Error('Failed to upload: connection reset'));

    const text = await textOf(
      call('ssh_file_write', {
        files: [
          { path: '/srv/a.bin', content: BIG.toString('base64'), binary: true },
          { path: '/srv/b.bin', content: BIG.toString('base64'), binary: true },
        ],
      })
    );

    expect(text).toContain('connection reset');
    expect(text).not.toContain('✓ /srv/a.bin');
  });
});

describe('ssh_file_read: бинарное чтение', () => {
  it('получает файл через транспорт и отдаёт base64', async () => {
    downloadMock.mockImplementation(async (_remote: string, local: string) => {
      writeFileSync(local, Buffer.from([0x00, 0x01, 0xff]));
    });

    const text = await textOf(call('ssh_file_read', { path: '/srv/logo.png', binary: true }));

    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock.mock.calls[0][0]).toBe('/srv/logo.png');
    expect(text).toContain(Buffer.from([0x00, 0x01, 0xff]).toString('base64'));
  });
});
