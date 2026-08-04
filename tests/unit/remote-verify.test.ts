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

  /**
   * Сторож времени убивает хеширование по-разному: coreutils возвращает 124,
   * BusyBox — 143. Замерено, что работу убивают оба. Недосчитанные хэши нельзя
   * выдавать за расхождение: по расхождению установщик сносит целое дерево.
   */
  it.each([
    ['coreutils', 124, ''],
    ['BusyBox', 143, 'Terminated'],
  ])('сверка, убитая сторожем на %s, — «проверить нечем»', async (_name, exitCode, stderr) => {
    executeMock.mockResolvedValue(reply('', { exitCode, stderr }));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('unavailable');
  });

  it('обрезанный вывод — «проверить нечем», а не «не сошлось»', async () => {
    // Буфер транспорта режет хвост: недостающие хэши выглядят как расхождение,
    // а по расхождению установщик сносит уже уехавшее дерево
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\n`, { truncated: true }));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('unavailable');
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

/**
 * Имя файла возвращается не таким, каким уехало.
 *
 * Замерено на живых серверах: coreutils для имени с обратным слэшем, переводом
 * строки или возвратом каретки ставит перед хэшем `\` и экранирует эти символы
 * внутри; BusyBox не экранирует ничего и печатает имя как есть. Оба случая
 * приводили к одному исходу — путь не находился в ответе, сверка объявляла
 * расхождение, установщик сносил уже уехавшее дерево.
 */
describe('сверка: сервер печатает имя не буквально', () => {
  it('coreutils экранирует имя с обратным слэшем — разбираем обратно', async () => {
    // Так выглядит ответ Debian на файл `a\b.txt`: ведущий слэш и удвоение внутри
    executeMock.mockResolvedValue(reply(`\\${HASH_ONE}  /srv/a\\\\b.txt\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\\b.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('без ведущего слэша имя берётся буквально', async () => {
    // У файла в имени два слэша подряд, и BusyBox печатает их как есть.
    // Раскодировать такую строку — значит испортить имя и не найти файл.
    executeMock.mockResolvedValue(reply(`${HASH_ONE}  /srv/a\\\\b.txt\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\\\\b.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('имя с переводом строки спрашивается отдельной командой', async () => {
    const awkward = '/srv/a\nb.txt';
    executeMock.mockImplementation(async (_config: unknown, command: string) =>
      command.includes(awkward)
        ? // BusyBox отвечает сырым именем: разбор по строкам его не соберёт
          reply(`${HASH_TWO}  ${awkward}\n`)
        : reply(`${HASH_ONE}  /srv/plain.txt\n`)
    );

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/plain.txt', hash: HASH_ONE },
        { path: awkward, hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
    // Обычное имя ушло своей пачкой, трудное — своей
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(sentCommand(0)).not.toContain(awkward);
    expect(sentCommand(1)).toContain(awkward);
  });

  it.each([
    ['перевод строки', '/srv/a\nb.txt', '/srv/a\\nb.txt'],
    ['возврат каретки', '/srv/a\rb.txt', '/srv/a\\rb.txt'],
  ])('трудное имя (%s): coreutils отвечает экранированной строкой', async (_name, real, printed) => {
    // Хэш берётся позиционно, поэтому годится любая форма имени в ответе
    executeMock.mockResolvedValue(reply(`\\${HASH_ONE}  ${printed}\n`));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: real, hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('отдельная команда разбирает и формат openssl', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'openssl' }));
    executeMock.mockResolvedValue(reply(`SHA2-256(/srv/a\nb.txt)= ${HASH_ONE}\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\nb.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('хэши двух трудных имён не путаются местами', async () => {
    const first = '/srv/a\nx.txt';
    const second = '/srv/b\ny.txt';
    executeMock.mockImplementation(async (_config: unknown, command: string) =>
      reply(command.includes(first) ? `${HASH_ONE}  ${first}\n` : `${HASH_TWO}  ${second}\n`)
    );

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: first, hash: HASH_ONE },
        // Хэши разные: перепутанные ответы обязаны дать несовпадение
        { path: second, hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'matched' });
  });

  it('другой хэш у трудного имени — это несовпадение, а не успех', async () => {
    executeMock.mockResolvedValue(reply(`${HASH_TWO}  /srv/a\nb.txt\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\nb.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'mismatched', paths: ['/srv/a\nb.txt'] });
  });

  it('хэш в имени файла не подменяет ответ openssl', async () => {
    // Имя повторяет форму вывода sha256sum: разбор «сначала sha256sum» брал
    // хэш из имени и объявлял испорченный файл сошедшимся
    passportMock.mockResolvedValue(passport({ sha256: 'openssl' }));
    const tricky = `/srv/x\n${HASH_ONE}  y.txt`;
    executeMock.mockResolvedValue(reply(`SHA2-256(${tricky})= ${HASH_TWO}\n`));

    const outcome = await verifyRemoteFiles(executor(), CONFIG, [{ path: tricky, hash: HASH_ONE }], {
      profileName: 'production',
    });

    expect(outcome).toEqual({ status: 'mismatched', paths: [tricky] });
  });

  it('молчание сервера о трудном имени остаётся несовпадением', async () => {
    // Хэша в ответе нет — выдать «сошлось» здесь было бы худшим из исходов
    executeMock.mockResolvedValue(
      reply('', { exitCode: 1, stderr: 'sha256sum: No such file or directory\n' })
    );

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\nb.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'mismatched', paths: ['/srv/a\nb.txt'] });
  });

  it('чужая строка ниже ответа не сходит за хэш файла', async () => {
    // Вывод про один файл начинается с хэша; всё, что ниже, — часть имени
    executeMock.mockResolvedValue(reply(`sha256sum: reading\n${HASH_ONE}  /srv/a\nb.txt\n`));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\nb.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('mismatched');
  });

  it('пропавшая утилита видна и на трудном имени', async () => {
    executeMock.mockResolvedValue(reply('', { exitCode: 127, stderr: 'sh: sha256sum: not found' }));
    passportMock
      .mockResolvedValueOnce(passport())
      .mockResolvedValueOnce(passport({ sha256: 'none' }));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a\nb.txt', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('unavailable');
  });
});
