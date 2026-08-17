/**
 * Unit tests: правила доступа к путям и `~`
 *
 * Проверка пути шла до раскрытия тильды, а `~/…` валидатор превращал в
 * `/home/user/…` — выдуманный путь, к настоящему отношения не имеющий.
 * Отсюда два перекоса, и оба видны на сервере, где вход под root:
 *
 *  - запрет `deniedPaths: ['/root']` не срабатывал: путь `~/x` сравнивался
 *    с `/home/user/x` и проходил, хотя вёл ровно в запрещённый каталог;
 *  - разрешение `allowedPaths: ['/root']` наоборот отказывало в своём же
 *    каталоге — по той же подстановке.
 *
 * Поэтому правила применяются к тому пути, по которому операция пойдёт
 * на самом деле, — то есть после раскрытия.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const HOME = '/root';

const { executeMock, passportMock, uploadMock, downloadMock, pathSecurity } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
  pathSecurity: { current: undefined as unknown },
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
  resolveSSHConfig: () => ({
    host: 'example.com',
    username: 'root',
    port: 22,
    pathSecurity: pathSecurity.current,
  }),
  getAvailableProfiles: () => ['production'],
}));

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

async function transfer(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await new TransferTool().handleCall(call(name, args));
  return response.content[0].text as string;
}

async function files(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await new FileTools().handleCall(call(name, args));
  return response.content[0].text as string;
}

async function logs(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await new LogTools().handleCall(call(name, args));
  return response.content[0].text as string;
}

/** Команды, ушедшие на сервер, — по первому слову */
function sentCommands(starts: string): string[] {
  return executeMock.mock.calls
    .map(([, command]) => String(command))
    .filter((command) => command.startsWith(starts));
}

let localDir: string;
let localFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  pathSecurity.current = undefined;
  passportMock.mockResolvedValue({
    ...UNKNOWN_PASSPORT,
    known: true,
    sha256: 'sha256sum',
    coreutils: 'coreutils',
    home: HOME,
  });
  uploadMock.mockResolvedValue(undefined);
  downloadMock.mockImplementation(async (_remote: string, local: string) => {
    writeFileSync(local, 'данные', 'utf8');
  });
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    if (command.includes('SSH_MCP_KIND')) {
      return { stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });

  localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-pathsec-'));
  localFile = join(localDir, 'payload.txt');
  writeFileSync(localFile, 'данные', 'utf8');
});

describe('запрещённый каталог остаётся запрещённым и под тильдой', () => {
  beforeEach(() => {
    pathSecurity.current = { deniedPaths: [HOME] };
  });

  it('ssh_upload не пишет в запрещённый дом', async () => {
    const text = await transfer('ssh_upload', {
      local_path: localFile,
      remote_path: '~/secret.txt',
      verify: false,
    });

    expect(text).toMatch(/Path validation failed/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('ssh_download не читает из запрещённого дома', async () => {
    const text = await transfer('ssh_download', {
      remote_path: '~/secret.txt',
      local_path: join(localDir, 'back.txt'),
      verify: false,
    });

    expect(text).toMatch(/Path validation failed/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('ssh_file_write не пишет в запрещённый дом', async () => {
    const text = await files('ssh_file_write', {
      files: { path: '~/secret.conf', content: 'ключ = значение' },
    });

    expect(text).toMatch(/Path validation failed/);
    expect(executeMock.mock.calls.every(([, command]) => !String(command).startsWith('cat >'))).toBe(
      true
    );
  });

  it('ssh_file_read не читает из запрещённого дома', async () => {
    const text = await files('ssh_file_read', { path: '~/secret.conf' });

    expect(text).toMatch(/Path validation failed/);
    expect(executeMock.mock.calls.every(([, command]) => !String(command).startsWith('cat '))).toBe(
      true
    );
  });

  it('ssh_file_list не показывает запрещённый дом', async () => {
    const text = await files('ssh_file_list', { path: '~' });

    expect(text).toMatch(/Path validation failed/);
    expect(executeMock.mock.calls.every(([, command]) => !String(command).startsWith('ls '))).toBe(
      true
    );
  });

  // Журнальные инструменты проверяли путь ДО раскрытия, поэтому `~/secret`
  // проходил запрет и отдавал содержимое файла — замерено на обоих контейнерах.
  // У каждого инструмента две ветки, один путь и список, и обе строят команду
  // сами: покрываем обе.

  it('ssh_log_tail не читает запрещённый дом', async () => {
    const text = await logs('ssh_log_tail', { path: '~/secret' });

    expect(text).toMatch(/Path validation failed/);
    expect(sentCommands('tail ')).toHaveLength(0);
  });

  it('ssh_log_tail в списке путей отказывает только запрещённому', async () => {
    const text = await logs('ssh_log_tail', { path: ['~/secret', '/var/log/app.log'] });

    expect(text).toMatch(/Path validation failed/);
    expect(sentCommands('tail ')).toEqual([expect.stringContaining('/var/log/app.log')]);
  });

  it('ssh_log_search не ищет в запрещённом доме', async () => {
    const text = await logs('ssh_log_search', { path: '~/secret', query: 'ключ' });

    expect(text).toMatch(/Path validation failed/);
    expect(sentCommands('grep ')).toHaveLength(0);
  });

  it('ssh_log_search в списке путей отказывает только запрещённому', async () => {
    const text = await logs('ssh_log_search', {
      path: ['~/secret', '/var/log/app.log'],
      query: 'ключ',
    });

    expect(text).toMatch(/Path validation failed/);
    expect(sentCommands('grep ')).toEqual([expect.stringContaining('/var/log/app.log')]);
  });
});

describe('разрешённый каталог не отвергается из-за тильды', () => {
  beforeEach(() => {
    pathSecurity.current = { allowedPaths: [HOME] };
  });

  it('ssh_upload в собственный дом проходит', async () => {
    const text = await transfer('ssh_upload', {
      local_path: localFile,
      remote_path: '~/app.conf',
      verify: false,
    });

    expect(text).not.toMatch(/Path validation failed/);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('ssh_file_read из собственного дома проходит', async () => {
    const text = await files('ssh_file_read', { path: '~/app.conf' });

    expect(text).not.toMatch(/Path validation failed/);
    expect(executeMock.mock.calls.some(([, command]) => String(command).startsWith('cat '))).toBe(
      true
    );
  });

  it('ssh_log_tail из собственного дома проходит', async () => {
    const text = await logs('ssh_log_tail', { path: '~/app.log' });

    expect(text).not.toMatch(/Path validation failed/);
    expect(sentCommands('tail ')).toEqual([expect.stringContaining(`${HOME}/app.log`)]);
  });
});
