/**
 * Unit tests: инструменты и честный код возврата
 *
 * Раньше транспорт бросал исключение на любом ненулевом коде, поэтому ветки
 * обработки кода в инструментах не выполнялись ни разу. Теперь код доезжает,
 * и проверяется главное: неудача одной команды не роняет весь ответ, а `grep`
 * без совпадений остаётся нормальным ответом, а не ошибкой.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteOptions, SSHExecuteResult } from '../../src/managers/ssh-executor.js';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    SSHExecutor: class {
      execute = executeMock;
      // Проверяющая обёртка тестируется настоящая: инструменты рассчитывают
      // именно на её решение, считать ли ненулевой код провалом
      executeChecked = actual.SSHExecutor.prototype.executeChecked;
    },
  };
});

// Передача файлов идёт через транспорт; здесь проверяются только команды вокруг неё
vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ upload: vi.fn(), download: vi.fn() }),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { SnapshotTool } = await import('../../src/tools/snapshot-tool.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { AuditTool } = await import('../../src/tools/audit-tool.js');
const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');

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

/** Опции, с которыми звали транспорт для команды по образцу */
function optionsFor(pattern: RegExp): SSHExecuteOptions | undefined {
  const call = executeMock.mock.calls.find(([, command]) => pattern.test(command as string));
  return call?.[2] as SSHExecuteOptions | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
});

describe('ssh_snapshot: неудачная команда не роняет снимок', () => {
  it('без docker на сервере секция просто отсутствует', async () => {
    respondWith([[/which docker/, { exitCode: 1 }]]);

    const response = await new SnapshotTool().handleCall(call('ssh_snapshot'));

    expect(response.content[0].text).not.toContain('DOCKER');
    expect(response.content[0].text).toContain('SYSTEM SNAPSHOT');
  });

  it('недоступный nproc не превращает число ядер в NaN', async () => {
    respondWith([[/nproc/, { exitCode: 1 }]]);

    const response = await new SnapshotTool().handleCall(call('ssh_snapshot'));

    expect(response.content[0].text).not.toContain('NaN');
  });

  it('недоступный hostname подписывается как unknown', async () => {
    respondWith([[/hostname/, { exitCode: 1, stderr: 'command not found' }]]);

    const response = await new SnapshotTool().handleCall(call('ssh_snapshot'));

    expect(response.content[0].text).toContain('Hostname: unknown');
  });

  it('команды снимка помечены как безопасные для повтора', async () => {
    await new SnapshotTool().handleCall(call('ssh_snapshot'));

    expect(optionsFor(/hostname/)?.idempotent).toBe(true);
  });
});

describe('ssh_log_search: отсутствие совпадений — это ответ, а не ошибка', () => {
  it('grep с кодом 1 отвечает «совпадений нет»', async () => {
    respondWith([[/grep/, { exitCode: 1, stdout: '' }]]);

    const response = await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/syslog', query: 'boom' })
    );

    expect(response.content[0].text).toBe('No matches found');
  });

  it('настоящая ошибка grep остаётся ошибкой', async () => {
    respondWith([[/grep/, { exitCode: 2, stderr: 'grep: /var/log/secure: Permission denied' }]]);

    const response = await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/secure', query: 'boom' })
    );

    expect(response.content[0].text).toContain('Permission denied');
  });

  it('поиск идёт по запрошенному профилю, а не по «default»', async () => {
    await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/syslog', query: 'boom', profile: 'production' })
    );

    expect(optionsFor(/grep/)?.profileName).toBe('production');
  });

  it('чтение логов помечено как безопасное для повтора', async () => {
    await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/syslog', query: 'boom' })
    );

    expect(optionsFor(/grep/)?.idempotent).toBe(true);
  });
});

describe('ssh_log_tail: ненулевой код объясняется человеку', () => {
  it('недоступный файл даёт понятную ошибку с текстом от сервера', async () => {
    respondWith([[/tail/, { exitCode: 1, stderr: 'tail: /var/log/secure: Permission denied' }]]);

    const response = await new LogTools().handleCall(
      call('ssh_log_tail', { path: '/var/log/secure' })
    );

    expect(response.content[0].text).toContain('Permission denied');
  });
});

describe('ssh_audit_baseline: составная команда переживает ненулевой код', () => {
  it('последняя подкоманда с ненулевым кодом не отменяет разбор вывода', async () => {
    respondWith([[/__SSH_MCP/, { exitCode: 1, stdout: '' }]]);

    const response = await new AuditTool().handleCall(call('ssh_audit_baseline'));

    expect(response.content[0].text).not.toMatch(/^Error:/);
  });

  it('команды аудита помечены как безопасные для повтора', async () => {
    await new AuditTool().handleCall(call('ssh_audit_baseline'));

    expect(optionsFor(/__SSH_MCP/)?.idempotent).toBe(true);
  });
});

describe('передача файлов: неудачный шаг не выдаётся за успех', () => {
  let localDir: string;
  let localFile: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tools-test-'));
    localFile = join(localDir, 'payload.txt');
    writeFileSync(localFile, 'hello', 'utf8');
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  it('sudo install без прав — это ошибка загрузки, а не «Upload OK»', async () => {
    respondWith([
      [/^install /, { exitCode: 1, stderr: "install: cannot create '/etc/app.conf': Permission denied" }],
    ]);

    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/etc/app.conf',
        sudo: true,
        verify: false,
      })
    );

    expect(response.content[0].text).not.toContain('Upload OK');
    expect(response.content[0].text).toContain('Permission denied');
  });

  it('несостоявшееся атомарное переименование — это ошибка загрузки', async () => {
    respondWith([[/^mv -f/, { exitCode: 1, stderr: 'mv: cannot move: Read-only file system' }]]);

    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/srv/app.conf',
        verify: false,
      })
    );

    expect(response.content[0].text).not.toContain('Upload OK');
    expect(response.content[0].text).toContain('Read-only file system');
  });

  it('несозданный каталог назначения останавливает загрузку каталога', async () => {
    respondWith([[/^mkdir -p/, { exitCode: 1, stderr: 'mkdir: cannot create directory: No space left' }]]);

    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localDir,
        remote_path: '/srv/app',
        recursive: true,
        verify: false,
      })
    );

    expect(response.content[0].text).not.toContain('Upload OK');
    expect(response.content[0].text).toContain('No space left');
  });

  it('несостоявшийся sudo install при записи файла тоже ошибка', async () => {
    respondWith([
      [/^install /, { exitCode: 1, stderr: "install: cannot create '/etc/app.conf': Permission denied" }],
    ]);

    const response = await new FileTools().handleCall(
      call('ssh_file_write', {
        files: [{ path: '/etc/app.conf', content: 'key = value', sudo: true, atomic: true }],
      })
    );

    expect(response.content[0].text).toContain('Permission denied');
  });
});

describe('чтение файлов: пометка о безопасности повтора', () => {
  it('чтение файла помечено как безопасное для повтора', async () => {
    await new FileTools().handleCall(call('ssh_file_read', { path: '/etc/hostname' }));

    expect(optionsFor(/cat /)?.idempotent).toBe(true);
  });

  it('список файлов помечен как безопасный для повтора', async () => {
    await new FileTools().handleCall(call('ssh_file_list', { path: '/srv' }));

    expect(optionsFor(/^ls /)?.idempotent).toBe(true);
  });
});
