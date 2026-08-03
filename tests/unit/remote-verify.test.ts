/**
 * Unit tests: сверка переданных файлов по хэшам
 *
 * Три исхода должны быть различимы: сошлось, не сошлось, проверить нечем.
 * Раньше «нечем» приходило в stderr с кодом 127, а искали его в stdout — и
 * исправная передача на сервер без sha256sum выглядела как испорченная.
 *
 * Второе требование — работать на минимальном наборе утилит: хэши считаются
 * пачкой имён в аргументах, без длинных опций и без stdin, потому что на
 * BusyBox `sha256sum -c --quiet -` не существует.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

const { verifyRemoteFiles } = await import('../../src/managers/remote-verify.js');
const { resetPassportCache, UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

const CONFIG: SSHConfig = { host: 'example.com', port: 22, username: 'deploy' };

/** Заглушка исполнителя: паспорт и команды отвечают по отдельности */
function executor(): any {
  return { execute: executeMock, passport: passportMock };
}

function passport(overrides: Record<string, unknown> = {}) {
  return { ...UNKNOWN_PASSPORT, known: true, sha256: 'sha256sum', coreutils: 'coreutils', ...overrides };
}

/** Ответ команды: по умолчанию успех с заданным stdout */
function reply(stdout: string, overrides: Record<string, unknown> = {}) {
  return { stdout, stderr: '', exitCode: 0, truncated: false, ...overrides };
}

const HASH_ONE = 'a'.repeat(64);
const HASH_TWO = 'b'.repeat(64);

/** Команда, отправленная на сервер n-м вызовом */
function sentCommand(index = 0): string {
  return executeMock.mock.calls[index][1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPassportCache();
  passportMock.mockResolvedValue(passport());
});

describe('сверка: сошлось', () => {
  it('совпадение всех хэшей — успех', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\n${HASH_TWO}  /srv/b\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('регистр хэша не влияет на сравнение', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_ONE.toUpperCase()}  /srv/a\n`));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(outcome.status).toBe('matched');
  });
});

describe('сверка: не сошлось', () => {
  it('несовпавший файл назван поимённо', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\n${HASH_ONE}  /srv/b\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'mismatched', paths: ['/srv/b'] });
  });

  it('файл, о котором сервер промолчал, тоже не сошёлся', async () => {
    // sha256sum печатает остальные хэши и жалуется в stderr — код 1 при живой пачке
    executeMock.mockResolvedValue(
      reply(`${HASH_ONE}  /srv/a\n`, {
        exitCode: 1,
        stderr: "sha256sum: /srv/b: No such file or directory\n",
      })
    );

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'mismatched', paths: ['/srv/b'] });
  });
});

describe('сверка: проверить нечем', () => {
  it('сервер без sha256sum и openssl — честное «нечем», а не ошибка передачи', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'none' }));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(outcome.status).toBe('unavailable');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('пустой список не выдаётся за успешную проверку', async () => {
    const outcome = await verifyRemoteFiles(executor(), CONFIG, [], { profileName: 'production' });

    expect(outcome.status).toBe('unavailable');
  });

  it('обещанной паспортом утилиты не оказалось — паспорт сбрасывается, отказ честный', async () => {
    executeMock.mockResolvedValue(
      reply('', { exitCode: 127, stderr: 'sh: sha256sum: not found' })
    );
    passportMock
      .mockResolvedValueOnce(passport())
      .mockResolvedValueOnce(passport({ sha256: 'none' }));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(outcome.status).toBe('unavailable');
    expect(passportMock).toHaveBeenCalledTimes(2);
  });
});

describe('команда сверки: минимальный набор утилит', () => {
  it('имена идут аргументами — ни длинных опций, ни stdin', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\n`));

    await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(sentCommand()).toContain("'/srv/a'");
    expect(sentCommand()).not.toContain('--quiet');
    expect(executeMock.mock.calls[0][2]).not.toHaveProperty('stdin');
  });

  it('на BusyBox команда та же самая', async () => {
    passportMock.mockResolvedValue(passport({ coreutils: 'busybox' }));
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\n`));

    await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(sentCommand()).toMatch(/^sha256sum --/);
  });

  it('на сервере с одним openssl считает им и разбирает его формат', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'openssl' }));
    // OpenSSL 3 печатает SHA2-256, ранние версии — SHA256
    executeMock.mockResolvedValue(reply(`SHA2-256(/srv/a)= ${HASH_ONE}\n`));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: '/srv/a', hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(sentCommand()).toContain('openssl dgst -sha256');
    expect(outcome.status).toBe('matched');
  });

  it('длинный список разбивается на несколько команд', async () => {
    const entries = Array.from({ length: 250 }, (_, index) => ({
      path: `/srv/file-${index}`,
      hash: HASH_ONE,
    }));
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return reply(paths.map((path) => `${HASH_ONE}  ${path}`).join('\n') + '\n');
    });

    const outcome = await verifyRemoteFiles(executor(), CONFIG, entries, {
      profileName: 'production',
    });

    expect(outcome.status).toBe('matched');
    expect(executeMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('чтение под sudo передаётся дальше', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /etc/app.conf\n`));

    await verifyRemoteFiles(executor(), CONFIG, [{ path: '/etc/app.conf', hash: HASH_ONE }], {
      profileName: 'production',
      sudo: true,
    });

    expect(executeMock.mock.calls[0][2]).toMatchObject({ sudo: true, idempotent: true });
  });
});
