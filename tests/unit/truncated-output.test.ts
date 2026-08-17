/**
 * Unit tests: частичный вывод не выдаётся за полный
 *
 * Транспорт честно ставит флаг обрезки, но до ответа инструмента флаг не
 * доезжал: кусок файла в 10 МиБ выглядел как весь файл, и заметить подмену
 * было нечем. Здесь проверяется обратное — обрезка видна человеку, а чтение
 * файла в таком случае отказывает с готовым обходным путём вместо огрызка.
 *
 * Сюда же — код 124: срабатывание сторожа объясняется словами, а не числом.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');

/** Ответы транспорта по образцу команды; всё, что не совпало, отвечает успехом */
function respondWith(table: Array<[RegExp, Partial<SSHExecuteResult>]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(command));
    return { stdout: '', stderr: '', exitCode: 0, truncated: false, ...(match?.[1] ?? {}) };
  });
}

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith([]);
});

describe('ssh_exec: обрезанный вывод помечен', () => {
  it('пометка приходит вместе с куском вывода', async () => {
    respondWith([[/^du /, { stdout: 'первая часть', truncated: true }]]);

    const response = await new ExecTool().handleCall(call('ssh_exec', { command: 'du -a /' }));

    expect(response.content[0].text).toContain('первая часть');
    expect(response.content[0].text).toMatch(/truncated/i);
  });

  it('целый вывод пометки не получает', async () => {
    respondWith([[/^uptime/, { stdout: 'up 3 days' }]]);

    const response = await new ExecTool().handleCall(call('ssh_exec', { command: 'uptime' }));

    expect(response.content[0].text).not.toMatch(/truncated/i);
  });

  it('в пачке команд обрезка отмечается у той команды, где случилась', async () => {
    respondWith([[/^du /, { stdout: 'много', truncated: true }]]);

    const response = await new ExecTool().handleCall(
      call('ssh_exec', { command: ['uptime', 'du -a /'] })
    );

    const text = response.content[0].text;
    const beforeSecond = text.slice(0, text.indexOf('du -a /'));
    expect(text).toMatch(/truncated/i);
    expect(beforeSecond).not.toMatch(/truncated/i);
  });
});

describe('ssh_exec: убитая сторожем команда объясняется словами', () => {
  /**
   * Кодов у сторожа два: coreutils отвечает 124, BusyBox — 143 (128 + SIGTERM).
   * Проверяются оба — лаборатория стоит на BusyBox, и пока в наборе был только
   * 124, выпадение 143 из списка не замечал ни один тест.
   */
  it.each([
    ['coreutils', 124],
    ['BusyBox', 143],
  ])('код сторожа %s (%i) сопровождается пояснением про таймаут', async (_name, exitCode) => {
    respondWith([[/^sleep /, { exitCode }]]);

    const response = await new ExecTool().handleCall(call('ssh_exec', { command: 'sleep 600' }));

    expect(response.content[0].text).toContain(String(exitCode));
    expect(response.content[0].text).toMatch(/timeout/i);
  });

  it('обычный ненулевой код лишних пояснений не получает', async () => {
    respondWith([[/^grep /, { exitCode: 1 }]]);

    const response = await new ExecTool().handleCall(call('ssh_exec', { command: 'grep x file' }));

    expect(response.content[0].text).toContain('Exit code: 1');
    expect(response.content[0].text).not.toMatch(/timeout/i);
  });
});

describe('ssh_file_read: обрезка — отказ, а не тихий огрызок', () => {
  it('обрезанное содержимое не выдаётся за файл', async () => {
    respondWith([[/^cat /, { stdout: 'начало огромного файла', truncated: true }]]);

    const response = await new FileTools().handleCall(
      call('ssh_file_read', { path: '/var/log/huge.log' })
    );

    expect(response.content[0].text).not.toContain('начало огромного файла');
    expect(response.content[0].text).toContain('ssh_download');
  });

  it('при чтении нескольких файлов обрезанный помечен неудачным, остальные читаются', async () => {
    respondWith([[/huge\.log/, { stdout: 'огрызок', truncated: true }]]);

    const response = await new FileTools().handleCall(
      call('ssh_file_read', { path: ['/etc/hostname', '/var/log/huge.log'] })
    );

    const text = response.content[0].text;

    expect(text).toContain('✓ /etc/hostname');
    expect(text).toContain('✗ /var/log/huge.log');
    expect(text).toContain('ssh_download');
    expect(text).not.toContain('огрызок');
  });
});

describe('списки и логи: неполный вывод подписан', () => {
  it('обрезанный список файлов помечен', async () => {
    respondWith([[/^ls /, { stdout: 'file1\nfile2', truncated: true }]]);

    const response = await new FileTools().handleCall(call('ssh_file_list', { path: '/srv' }));

    expect(response.content[0].text).toMatch(/truncated/i);
  });

  it('обрезанный хвост лога помечен', async () => {
    respondWith([[/^tail /, { stdout: 'строки лога', truncated: true }]]);

    const response = await new LogTools().handleCall(
      call('ssh_log_tail', { path: '/var/log/syslog' })
    );

    expect(response.content[0].text).toMatch(/truncated/i);
  });

  it('обрезанный результат поиска помечен', async () => {
    respondWith([[/^grep /, { stdout: 'совпадения', truncated: true }]]);

    const response = await new LogTools().handleCall(
      call('ssh_log_search', { path: '/var/log/syslog', query: 'boom' })
    );

    expect(response.content[0].text).toMatch(/truncated/i);
  });
});
