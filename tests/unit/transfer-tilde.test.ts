/**
 * Unit tests: `~` в remote_path у передачи
 *
 * Регресс, ради которого это писалось, уносил данные. Путь уезжает на сервер
 * в одинарных кавычках, где `~` — обычная буква, но саму передачу делает scp,
 * а он отдаёт путь shell-у и тильду раскрывает. Дальше расходились две
 * стороны одной операции:
 *
 *  - при скачивании файл приезжал, а сверка искала на сервере файл с именем
 *    «~» и не находила — расхождение уносило уже скачанное, и у человека не
 *    оставалось ничего (замерено на BusyBox и coreutils);
 *  - при загрузке файл ложился в дом, сверка его там не находила, ответ врал
 *    расхождением, staging оставался на сервере, а рядом появлялся каталог
 *    с именем «~» — его создавал `mkdir -p`.
 *
 * Поэтому тильда раскрывается у нас, до первой команды.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';
import { sha256OfFile } from '../../src/utils/sha256.js';

const HOME = '/home/deploy';

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
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

function passport(overrides: Record<string, unknown> = {}) {
  return {
    ...UNKNOWN_PASSPORT,
    known: true,
    sha256: 'sha256sum',
    coreutils: 'coreutils',
    home: HOME,
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

async function textOf(request: CallToolRequest): Promise<string> {
  const response = await new TransferTool().handleCall(request);
  return response.content[0].text as string;
}

/** Что ушло на сервер отдельными командами */
function sentCommands(): string[] {
  return executeMock.mock.calls.map(([, command]) => command as string);
}

let localDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  passportMock.mockResolvedValue(passport());
  uploadMock.mockResolvedValue(undefined);

  localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tilde-'));
  localFile = join(localDir, 'app.conf');
  writeFileSync(localFile, 'key = value', 'utf8');

  // Сервер ведёт себя как настоящий: путь в одинарных кавычках он НЕ раскрывает,
  // поэтому файла с именем «~» у него нет и хэша по такому пути не будет.
  // Без этого мок отвечал бы хэшем на несуществующий путь и прятал весь регресс.
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (command.startsWith('sha256sum')) {
      const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const known = paths.filter((path) => path.startsWith('/'));
      const missing = paths.filter((path) => !path.startsWith('/'));
      const hash = await sha256OfFile(localFile);
      return {
        stdout: known.map((path) => `${hash}  ${path}`).join('\n') + (known.length ? '\n' : ''),
        stderr: missing.map((path) => `sha256sum: ${path}: No such file or directory`).join('\n'),
        exitCode: missing.length > 0 ? 1 : 0,
        truncated: false,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });

  // Скачивание кладёт на диск ровно то же содержимое, что лежит локально
  downloadMock.mockImplementation(async (_remote: string, local: string) => {
    writeFileSync(local, 'key = value', 'utf8');
  });
});

afterEach(() => {
  rmSync(localDir, { recursive: true, force: true });
});

describe('загрузка по пути с `~`', () => {
  it('на сервер не уходит ни одной команды с неразвёрнутой тильдой', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '~/app.conf' })
    );

    // Ни `~` в путях команд, ни каталога с таким именем
    expect(sentCommands().filter((command) => command.includes('~'))).toEqual([]);
    expect(sentCommands().some((command) => command.startsWith(`mkdir -p -- '${HOME}'`))).toBe(true);
    expect(text).toContain(`✓ Upload OK: ${HOME}/app.conf`);
  });

  it('сверка спрашивает тот же файл, который положил транспорт', async () => {
    await textOf(call('ssh_upload', { local_path: localFile, remote_path: '~/app.conf' }));

    const [, staging] = uploadMock.mock.calls[0];
    const hashing = sentCommands().find((command) => command.startsWith('sha256sum'));

    expect(staging).toMatch(new RegExp(`^${HOME}/\\.upload-[0-9a-f]+\\.app\\.conf$`));
    expect(hashing).toContain(`'${staging}'`);
  });

  it('под sudo человек узнаёт, в чей дом на самом деле попал файл', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '~/app.conf', sudo: true })
    );

    expect(text).toContain(`${HOME}/app.conf`);
    expect(text).toMatch(/home of the login user, not root/);
  });
});

describe('скачивание по пути с `~`', () => {
  it('скачанное остаётся у человека, а не уносится сверкой', async () => {
    const target = join(localDir, 'back.conf');

    const text = await textOf(
      call('ssh_download', { remote_path: '~/app.conf', local_path: target })
    );

    // Главное: файл на месте и целый — раньше здесь был ENOENT
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('key = value');
    expect(text).toContain('sha256: verified');
    expect(text).toContain(`${HOME}/app.conf`);
  });

  it('транспорт и сверка идут по одному и тому же раскрытому пути', async () => {
    await textOf(
      call('ssh_download', { remote_path: '~/app.conf', local_path: join(localDir, 'back.conf') })
    );

    const [remote] = downloadMock.mock.calls[0];
    expect(remote).toBe(`${HOME}/app.conf`);
    expect(sentCommands().find((command) => command.startsWith('sha256sum'))).toContain(
      `'${HOME}/app.conf'`
    );
    expect(sentCommands().filter((command) => command.includes('~'))).toEqual([]);
  });
});

describe('когда раскрыть нельзя — отказ до передачи', () => {
  it('чужой дом не угадывается', async () => {
    const text = await textOf(
      call('ssh_upload', { local_path: localFile, remote_path: '~someone/app.conf' })
    );

    expect(text).toMatch(/another user's home directory is not known/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('сервер не назвал дом — передача не начинается', async () => {
    passportMock.mockResolvedValue(passport({ home: '' }));
    const target = join(localDir, 'back.conf');

    const text = await textOf(
      call('ssh_download', { remote_path: '~/app.conf', local_path: target })
    );

    expect(text).toMatch(/did not report a home directory/);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(existsSync(target)).toBe(false);
  });
});
