/**
 * Unit tests: куда ведёт путь на самом деле
 *
 * Мок здесь злее сервера намеренно. Сервер в лаборатории всегда отвечает
 * `readlink`, а в жизни бывает и машина без него, и путь, который не
 * резолвится: именно эти ответы обязаны давать отказ, а не молчаливое «ну
 * ладно». Добрый мок, отвечающий на любой путь чем-то осмысленным, спрятал бы
 * ровно тот случай, ради которого проверка написана.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';
import type { RemovalTarget } from '../../src/utils/destructive-command.js';
import { resolveRemovalTargets } from '../../src/managers/removal-guard.js';

const config = { host: 'example.com', username: 'deploy', port: 22 } as SSHConfig;

const executeMock = vi.fn();
const passportMock = vi.fn();

/** Транспорт подменён целиком: до сети тесту дела нет */
const executor = {
  execute: executeMock,
  passport: passportMock,
} as never;

const target = (path: string, overrides: Partial<RemovalTarget> = {}): RemovalTarget => ({
  raw: `${path}/`,
  path,
  followsLink: true,
  expandable: false,
  ...overrides,
});

const serverAnswers = (stdout: string) =>
  executeMock.mockResolvedValue({ stdout, stderr: '', exitCode: 0, truncated: false });

const resolve = (targets: RemovalTarget[]) =>
  resolveRemovalTargets(executor, config, targets, { profileName: 'test' });

beforeEach(() => {
  vi.clearAllMocks();
  passportMock.mockResolvedValue({ home: '/home/deploy', known: true });
});

describe('resolveRemovalTargets', () => {
  it('без целей на сервер не ходит вовсе', async () => {
    const verdict = await resolve([]);

    expect(verdict.blocked).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('обычный каталог пропускается', async () => {
    serverAnswers('/srv/app/data\n');

    expect((await resolve([target('/srv/app/data')])).blocked).toBe(false);
  });

  it('ссылка на корень останавливает команду', async () => {
    serverAnswers('/\n');

    const verdict = await resolve([target('/srv/app/data')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('filesystem root');
    expect(verdict.reason).toContain('via symlink');
  });

  it('ссылка в дом останавливает команду', async () => {
    serverAnswers('/home/deploy\n');

    const verdict = await resolve([target('/srv/link')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('home directory');
  });

  it('ссылка в системное дерево останавливает команду', async () => {
    serverAnswers('/etc\n');

    expect((await resolve([target('/srv/link')])).blocked).toBe(true);
  });

  it('ссылка в системное дерево называет причину системным каталогом', async () => {
    serverAnswers('/etc\n');

    expect((await resolve([target('/srv/link')])).reason).toContain('a system directory');
  });

  it('путь, ведущий сам в себя, ссылкой не объявляется', async () => {
    // Сюда inspectCommand не пускает, но текст отказа не должен врать про
    // ссылку там, где её нет: `/etc/` резолвится в `/etc`
    serverAnswers('/etc\n');

    const verdict = await resolve([target('/etc')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe('"/etc/" is a system directory');
  });

  it('сервер без readlink — это отказ, а не разрешение', async () => {
    serverAnswers('SSH_MCP_NO_READLINK\n');

    const verdict = await resolve([target('/srv/app/data')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('no readlink');
    expect(verdict.reason).toContain('symlink into the root or a system directory');
  });

  it('возврат каретки в ответе не попадает в текст отказа', async () => {
    // Ответ с \r даёт не тот сервер, что в лаборатории, — а тот, до которого
    // мы ещё не доехали. Вердикт от него не меняется, но путь в сообщении
    // должен остаться читаемым, без мусора внутри строки
    serverAnswers('/\r\n');

    const verdict = await resolve([target('/srv/link')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe('"/srv/link/" is the filesystem root (via symlink → /)');
  });

  it('пустой ответ на путь — тоже отказ', async () => {
    serverAnswers('\n');

    const verdict = await resolve([target('/srv/app/data')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('could not be resolved');
  });

  it('опасная цель находится и во второй строке ответа', async () => {
    // Первый путь безопасен: проверка обязана дочитать список до конца
    serverAnswers('/srv/app/data\n/\n');

    const verdict = await resolve([target('/srv/app/data'), target('/srv/other')]);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain('/srv/other');
  });

  it('несколько безопасных целей проходят все', async () => {
    serverAnswers('/srv/a\n/srv/b\n');

    expect((await resolve([target('/srv/a'), target('/srv/b')])).blocked).toBe(false);
  });

  it('пути уходят на сервер закавыченными, а не голыми', async () => {
    serverAnswers('/srv/с пробелом\n');

    await resolve([target('/srv/с пробелом')]);

    const command = executeMock.mock.calls[0][1] as string;
    expect(command).toContain("'/srv/с пробелом'");
    expect(command).toContain('readlink -f');
  });

  it('несколько путей идут разными командами, а не склеиваются в одну', async () => {
    serverAnswers('/srv/a\n/srv/b\n');

    await resolve([target('/srv/a'), target('/srv/b')]);

    const command = executeMock.mock.calls[0][1] as string;
    expect(command).toContain("; readlink -f -- '/srv/b'");
  });

  it('дом берётся из паспорта, а не угадывается', async () => {
    passportMock.mockResolvedValue({ home: '/var/lib/app-home', known: true });
    serverAnswers('/var/lib/app-home\n');

    expect((await resolve([target('/srv/link')])).blocked).toBe(true);
  });

  it('проверка помечена безопасной для повтора', async () => {
    serverAnswers('/srv/app\n');

    await resolve([target('/srv/app')]);

    expect(executeMock.mock.calls[0][2]).toMatchObject({ idempotent: true });
  });
});
