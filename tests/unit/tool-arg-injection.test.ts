/**
 * Unit tests: значение параметра не становится командой на сервере.
 *
 * Восемь мест, найденных аудитом CORE_10 (пункт 1.1). Проверяется не только
 * отказ, но и то, что до транспорта не ушла ни одна команда с подставленным
 * значением: отказать нужно раньше, чем на сервере что-то произойдёт.
 *
 * Обратная сторона тоже под тестом: `*.log` обязан доехать шаблоном, иначе
 * инструмент лишится заявленной функции.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

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

const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { AuditTool } = await import('../../src/tools/audit-tool.js');
const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

/** Значение, которое хочет исполниться */
const PAYLOAD = '; id';

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

/** Все команды, ушедшие в транспорт за вызов */
function sentCommands(): string[] {
  return executeMock.mock.calls.map((args) => String(args[1]));
}

let workDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });
  passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, sha256: 'sha256sum' });
  uploadMock.mockResolvedValue(undefined);
  downloadMock.mockResolvedValue(undefined);

  workDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-injection-'));
  localFile = join(workDir, 'payload.txt');
  writeFileSync(localFile, 'x');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Отказ назвал параметр, и на сервер ничего не ушло */
function expectRefused(text: string, param: string): void {
  expect(text).toContain(param);
  expect(text).toMatch(/must be/);
  for (const command of sentCommands()) {
    expect(command).not.toContain(PAYLOAD);
  }
}

describe('ssh_file_list', () => {
  /**
   * Шаблон разбирает `find`, а не оболочка, поэтому он едет одним словом в
   * кавычках: точка с запятой внутри остаётся знаком имени, а не команды.
   */
  it('команда внутри шаблона остаётся именем файла', async () => {
    await new FileTools().handleCall(
      call('ssh_file_list', { path: '/tmp', pattern: `*${PAYLOAD}` })
    );

    expect(sentCommands()[0]).toContain(`-name '*; id'`);
    // Вне кавычек полезной нагрузки нет: закавыченное вырезается и проверяется остаток
    expect(sentCommands()[0].replace(/'[^']*'/g, "''")).not.toContain(PAYLOAD);
  });

  it('шаблон с дефисом уезжает шаблоном, а не опцией find', async () => {
    await new FileTools().handleCall(call('ssh_file_list', { path: '/tmp', pattern: '-la' }));

    expect(sentCommands()[0]).toContain(`-name '-la'`);
  });

  it('одинарная кавычка в шаблоне не разрывает команду', async () => {
    await new FileTools().handleCall(
      call('ssh_file_list', { path: '/tmp', pattern: `a'${PAYLOAD}` })
    );

    expect(sentCommands()[0]).toContain(String.raw`-name 'a'\''; id'`);
  });

  it('оставляет обычный шаблон живым: отбор на сервере — это функция', async () => {
    await new FileTools().handleCall(call('ssh_file_list', { path: '/tmp', pattern: '*.log' }));

    expect(sentCommands()[0]).toContain(`-name '*.log'`);
  });
});

describe('ssh_file_write', () => {
  it('отказывает на правах с командой', async () => {
    const response = await new FileTools().handleCall(
      call('ssh_file_write', {
        files: { path: '/tmp/f', content: 'data', mode: `644${PAYLOAD}` },
      })
    );
    expectRefused(response.content[0].text as string, 'mode');
  });

  it('пропускает обычные права', async () => {
    await new FileTools().handleCall(
      call('ssh_file_write', { files: { path: '/tmp/f', content: 'data', mode: '644' } })
    );
    expect(sentCommands().some((command) => /^chmod 644 -- /.test(command))).toBe(true);
  });
});

describe('ssh_log_tail', () => {
  it('отказывает на количестве строк с командой', async () => {
    const response = await new LogTools().handleCall(
      call('ssh_log_tail', { path: '/var/log/syslog', lines: `100${PAYLOAD}` })
    );
    expectRefused(response.content[0].text as string, 'lines');
  });

  it('пропускает число, пришедшее строкой', async () => {
    await new LogTools().handleCall(call('ssh_log_tail', { path: '/var/log/syslog', lines: '50' }));
    expect(sentCommands()[0]).toBe(`tail -n 50 '/var/log/syslog'`);
  });
});

describe('ssh_log_search', () => {
  it('отказывает на числе строк контекста с командой', async () => {
    const response = await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/syslog', query: 'boot', context: `2${PAYLOAD}` })
    );
    expectRefused(response.content[0].text as string, 'context');
  });
});

describe('ssh_disk_breakdown', () => {
  it('отказывает на размере выборки с командой', async () => {
    const response = await new AuditTool().handleCall(
      call('ssh_disk_breakdown', { top_n: `20${PAYLOAD}` })
    );
    expectRefused(response.content[0].text as string, 'top_n');
  });

  it('не подставляет путь в разделитель секций: там он раскрылся бы командой', async () => {
    await new AuditTool().handleCall(call('ssh_disk_breakdown', { paths: ['/$(id)'] }));
    const command = sentCommands()[0];
    // Единственное вхождение — внутри одинарных кавычек у `du`; в заголовке
    // секции стоит номер
    expect(command).toContain(`du -shx '/$(id)'/*`);
    expect(command.match(/\$\(id\)/g)).toHaveLength(1);
    expect(command).toContain('du_0');
  });
});

describe('ssh_service_status', () => {
  it('отказывает на числе строк журнала с командой', async () => {
    const response = await new AuditTool().handleCall(
      call('ssh_service_status', { unit: 'nginx', log_lines: `50${PAYLOAD}` })
    );
    expectRefused(response.content[0].text as string, 'log_lines');
  });
});

describe('ssh_upload', () => {
  it('отказывает на правах с командой', async () => {
    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/tmp/f',
        mode: `644${PAYLOAD}`,
        verify: false,
      })
    );
    expectRefused(response.content[0].text as string, 'mode');
  });

  it('отказывает на владельце с командой', async () => {
    const response = await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/tmp/f',
        sudo: true,
        owner: `root${PAYLOAD}`,
        verify: false,
      })
    );
    expectRefused(response.content[0].text as string, 'owner');
  });

  it('отказывает до того, как что-то уедет на сервер', async () => {
    await new TransferTool().handleCall(
      call('ssh_upload', {
        local_path: localFile,
        remote_path: '/tmp/f',
        mode: `644${PAYLOAD}`,
        verify: false,
      })
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
