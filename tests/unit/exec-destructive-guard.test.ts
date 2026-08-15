/**
 * Unit tests: врезка защиты от сноса в ssh_exec.
 *
 * Разбор команды и резолв ссылок проверяются своими файлами; здесь проверяется
 * только соединение с инструментом — то, чего не поймала ни одна мутация по
 * чистым функциям: отказ должен случиться ДО первой отправки, а обычная
 * команда не должна платить за проверку, которая её не касается.
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
    // Срок по умолчанию инструмент берёт здесь; подменённый модуль обязан его отдать
    DEFAULT_TIMEOUT_MS: actual.DEFAULT_TIMEOUT_MS,
    SSHExecutor: class {
      execute = executeMock;
      passport = passportMock;
    },
  };
});

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');
const { CONFIRMATION_MARKER } = await import('../../src/utils/destructive-command.js');

function call(command: string | string[], extra: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name: 'ssh_exec', arguments: { command, ...extra } } } as CallToolRequest;
}

/** Всё, что ушло в транспорт за вызов */
function sentCommands(): string[] {
  return executeMock.mock.calls.map((args) => String(args[1]));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Мок злее сервера: резолв отвечает настоящей целью ссылки, а не именем
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    if (command.includes('readlink -f')) {
      // /srv/data ведёт туда же, куда названо, а /var/www/data — в корень
      const target = command.includes('/srv/data') ? '/srv/data\n' : '/\n';
      return { stdout: target, stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false };
  });
  passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, home: '/home/deploy' });
});

describe('ssh_exec: врезка защиты от разрушительного удаления', () => {
  it('снос корня останавливается до первой отправки', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /'));

    expect(result.content[0].text).toContain('⛔ BLOCKED');
    expect(result.content[0].text).toContain('NOT executed');
    expect(result.isError).toBe(true);
    expect(sentCommands()).toEqual([]);
  });

  it('дом из паспорта берётся и по нему решается отказ', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /home/deploy'));

    expect(result.content[0].text).toContain('the home directory');
    expect(result.isError).toBe(true);
    expect(passportMock).toHaveBeenCalled();
    expect(sentCommands()).toEqual([]);
  });

  it('ссылка на корень со слэшем резолвится и блокируется', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /var/www/data/'));

    expect(result.content[0].text).toContain('via symlink');
    expect(result.isError).toBe(true);
    // На сервер ушёл только резолв, самого удаления там нет
    expect(sentCommands()).toHaveLength(1);
    expect(sentCommands()[0]).toContain('readlink -f');
  });

  it('обычная команда не тянет паспорт: проверять в ней нечего', async () => {
    await new ExecTool().handleCall(call('uptime'));

    expect(passportMock).not.toHaveBeenCalled();
    expect(sentCommands()).toEqual(['uptime']);
  });

  it('безопасная уборка проходит и доезжает до сервера', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /tmp/build'));

    expect(sentCommands()).toEqual(['rm -rf /tmp/build']);
    // Обратная сторона пометки: выполненное удаление провалом не объявляется
    expect(result.isError).toBeUndefined();
  });

  it('маркер подтверждения пропускает команду как есть', async () => {
    const command = `rm -rf / ${CONFIRMATION_MARKER}`;
    await new ExecTool().handleCall(call(command));

    expect(sentCommands()).toEqual([command]);
  });

  it('опасная команда в конце батча отменяет весь батч, а не половину', async () => {
    const result = await new ExecTool().handleCall(call(['uptime', 'whoami', 'rm -rf /etc']));

    expect(result.content[0].text).toContain('⛔ BLOCKED');
    expect(result.isError).toBe(true);
    expect(sentCommands()).toEqual([]);
  });

  it('в батче без удаления паспорт не спрашивается ни разу', async () => {
    await new ExecTool().handleCall(call(['uptime', 'whoami']));

    expect(passportMock).not.toHaveBeenCalled();
  });

  it('дом снимается один раз на весь батч, а не на каждое удаление', async () => {
    await new ExecTool().handleCall(call(['rm -rf /tmp/one', 'rm -rf /tmp/two']));

    expect(passportMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Обратная сторона проверки ссылок: резолв, который никуда не привёл, — это
   * разрешение. Иначе отказ получала бы любая команда со слэшем на конце.
   */
  it('ссылка, ведущая туда же, где названа, удаление не отменяет', async () => {
    const result = await new ExecTool().handleCall(call('rm -rf /srv/data/'));

    expect(result.content[0].text).not.toContain('BLOCKED');
    expect(sentCommands()).toContain('rm -rf /srv/data/');
  });

  it('резолв ссылки идёт с правами вызова, иначе он её не прочтёт', async () => {
    await new ExecTool().handleCall(call('rm -rf /srv/data/', { sudo: true }));

    const resolve = executeMock.mock.calls.find(([, command]) =>
      String(command).includes('readlink -f')
    );

    expect(resolve?.[2]).toMatchObject({ sudo: true });
  });
});
