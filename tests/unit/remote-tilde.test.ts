/**
 * Unit tests: `~` раскрывается одним способом во всех инструментах.
 *
 * Запись уже раскрывала тильду у нас, по домашнему каталогу из паспорта, а
 * чтение, список и журналы подставляли `$HOME` в двойных кавычках. Два правила
 * в одном инструменте — это не только неопрятно: в двойных кавычках приходилось
 * экранировать `!`, и путь `~/файл!` уезжал на сервер как `файл\!`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

function sentCommands(): string[] {
  return executeMock.mock.calls.map((args) => String(args[1]));
}

/** Сервер, который сообщил домашний каталог */
function withHome(home: string | null): void {
  passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, home });
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });
  withHome('/home/deploy');
});

describe('чтение файла', () => {
  it('раскрывает ~ у нас и отдаёт путь в одинарных кавычках', async () => {
    await new FileTools().handleCall(call('ssh_file_read', { path: '~/notes.txt' }));
    expect(sentCommands()[0]).toBe(`cat '/home/deploy/notes.txt'`);
  });

  it('не искажает имя с восклицательным знаком', async () => {
    await new FileTools().handleCall(call('ssh_file_read', { path: '~/файл!.txt' }));
    expect(sentCommands()[0]).toBe(`cat '/home/deploy/файл!.txt'`);
  });

  it('оставляет абсолютный путь как есть и не спрашивает паспорт', async () => {
    await new FileTools().handleCall(call('ssh_file_read', { path: '/etc/hosts' }));
    expect(sentCommands()[0]).toBe(`cat '/etc/hosts'`);
    expect(passportMock).not.toHaveBeenCalled();
  });

  it('отказывается гадать про чужой дом', async () => {
    const response = await new FileTools().handleCall(
      call('ssh_file_read', { path: '~postgres/data' })
    );
    expect(response.content[0].text).toMatch(/~postgres\/data/);
    expect(sentCommands()).toHaveLength(0);
  });

  it('отказывается писать наугад, если сервер не сообщил домашний каталог', async () => {
    withHome(null);
    const response = await new FileTools().handleCall(call('ssh_file_read', { path: '~/notes.txt' }));
    expect(response.content[0].text).toMatch(/home directory/);
    expect(sentCommands()).toHaveLength(0);
  });
});

describe('список файлов', () => {
  it('раскрывает ~ и оставляет шаблон рабочим', async () => {
    await new FileTools().handleCall(call('ssh_file_list', { path: '~', pattern: '*.log' }));
    expect(sentCommands()[0]).toContain(`find '/home/deploy' -mindepth 1 -maxdepth 1 -name '*.log'`);
  });
});

describe('журналы', () => {
  it('ssh_log_tail раскрывает ~ тем же способом', async () => {
    await new LogTools().handleCall(call('ssh_log_tail', { path: '~/app.log', lines: 20 }));
    expect(sentCommands()[0]).toBe(`tail -n 20 '/home/deploy/app.log'`);
  });

  it('ssh_log_search раскрывает ~ тем же способом', async () => {
    await new LogTools().handleCall(
      call('ssh_log_search', { path: '~/app.log', query: 'boot' })
    );
    expect(sentCommands()[0]).toBe(`grep -E -i -n 'boot' '/home/deploy/app.log' | tail -n 201`);
  });
});
