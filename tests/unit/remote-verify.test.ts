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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    // Причина названа своя: три беды «проверить нечем» лечатся по-разному, и
    // пользователю уходит именно та, что случилась
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('killed by the timeout guard'),
    });
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

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('did not fit the transport buffer'),
    });
  });

  it('успешная команда без единого хэша — «проверить нечем», а не «не сошлось»', async () => {
    // Код 0 и пустой вывод: сервер ни на что не пожаловался и ничего не назвал.
    // По расхождению установщик сносит целую копию, которой ничего не грозило
    executeMock.mockResolvedValue(reply(''));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/a', hash: HASH_ONE },
        { path: '/srv/b', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('named no hash at all'),
    });
  });

  it('пожаловался и не назвал ни одного — файла нет, это расхождение', async () => {
    // Тот же пустой вывод, но с жалобой: единственный запрошенный файл не найден
    executeMock.mockResolvedValue(
      reply('', { exitCode: 1, stderr: 'sha256sum: /srv/a: No such file or directory\n' })
    );

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [{ path: '/srv/a', hash: HASH_ONE }],
      { profileName: 'production' }
    );

    expect(outcome).toEqual({ status: 'mismatched', paths: ['/srv/a'] });
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
 * Длина команды: предел у сервера в байтах, а имя приходит знаками.
 *
 * Замерено на обоих серверах лаборатории: строка длиннее 128 KiB не доезжает
 * вовсе — `Argument list too long` с пустым выводом, а сверх четверти мегабайта
 * сервер рвёт соединение. Пустой вывод читается как расхождение, по которому
 * установщик сносит уже уехавшее дерево, поэтому команда обязана влезать
 * заведомо.
 *
 * Границ две — по числу имён и по длине, — и каждая проверяется своим тестом.
 */
describe('команда сверки: длина считается в байтах', () => {
  /** Предел из кода назван здесь заново: тест не должен ехать вслед за правкой константы */
  const LIMIT_BYTES = 32 * 1024;

  const treeOf = (name: (index: number) => string, count: number) =>
    Array.from({ length: count }, (_, index) => ({ path: name(index), hash: HASH_ONE }));

  /** Сервер молчит: разбиение проверяется по отправленному, а не по ответу */
  const silentServer = () => executeMock.mockResolvedValue(reply(''));

  const verify = (entries: { path: string; hash: string }[], sudo = false) =>
    verifyRemoteFiles(executor(), CONFIG, entries, { profileName: 'production', sudo });

  /**
   * Сколько байт уедет на сервер. Под sudo исполнитель заворачивает всю
   * команду в `sudo bash -c '…'`; счёт здесь свой, независимый от кода.
   */
  function sentBytes(index: number, sudo = false): number {
    const command = sentCommand(index);
    return Buffer.byteLength(sudo ? `sudo bash -c '${command.replace(/'/g, "'\\''")}'` : command);
  }

  const commandCount = () => executeMock.mock.calls.length;
  const allSentBytes = (sudo = false) =>
    executeMock.mock.calls.map((_call, index) => sentBytes(index, sudo));

  it('граница по числу имён: короткие имена дробятся ровно сотнями', async () => {
    // 202 имени: по сотне в двух командах и остаток в третьей. Сдвиг границы на
    // одно имя виден сразу — команд станет две
    silentServer();

    await verify(treeOf((index) => `/srv/file-${index}`, 202));

    expect(commandCount()).toBe(3);
  });

  it('в командах ровно те имена, что просили, и каждое по одному разу', async () => {
    silentServer();
    const entries = treeOf((index) => `/srv/file-${index}`, 202);

    await verify(entries);

    const asked = executeMock.mock.calls.flatMap((_call, index) =>
      [...sentCommand(index).matchAll(/'([^']*)'/g)].map((match) => match[1])
    );
    expect(asked).toEqual(entries.map((entry) => entry.path));
  });

  it('граница по длине: длинные имена дробятся раньше, чем набежит сотня', async () => {
    silentServer();

    await verify(treeOf((index) => `/srv/${String(index).padStart(4, '0')}/${'a'.repeat(600)}`, 200));

    expect(commandCount()).toBeGreaterThan(2);
    expect(Math.max(...allSentBytes())).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('русское имя весит вдвое — команд выходит больше, чем на латинском той же длины', async () => {
    silentServer();
    await verify(treeOf((index) => `/srv/${index}/${'a'.repeat(320)}`, 300));
    const latin = commandCount();

    vi.clearAllMocks();
    passportMock.mockResolvedValue(passport());
    silentServer();
    await verify(treeOf((index) => `/srv/${index}/${'я'.repeat(320)}`, 300));

    expect(commandCount()).toBeGreaterThan(latin);
    expect(Math.max(...allSentBytes())).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('апостроф в имени считается по экранированной длине, а не по одному знаку', async () => {
    silentServer();

    await verify(treeOf((index) => `/srv/${index}/${"'".repeat(300)}.txt`, 200));

    expect(Math.max(...allSentBytes())).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('под sudo имя закавычивается второй раз — команда влезает и после этого', async () => {
    silentServer();

    await verify(treeOf((index) => `/srv/${index}/${"'".repeat(300)}.txt`, 200), true);

    expect(Math.max(...allSentBytes(true))).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('sudo дробит те же имена мельче, чем работа без него', async () => {
    silentServer();
    await verify(treeOf((index) => `/srv/${index}/${"'".repeat(300)}.txt`, 200));
    const plain = commandCount();

    vi.clearAllMocks();
    passportMock.mockResolvedValue(passport());
    silentServer();
    await verify(treeOf((index) => `/srv/${index}/${"'".repeat(300)}.txt`, 200), true);

    expect(commandCount()).toBeGreaterThan(plain);
  });

  it('начало команды занимает место наравне с именами', async () => {
    // Имя подобрано так, что без учёта начала команды в предел влезали бы
    // ровно 32 имени по 1024 байта: с ним помещается 31, и хвост уезжает
    // третьей командой
    silentServer();

    await verify(treeOf((index) => `/srv/${String(index).padStart(4, '0')}/${'a'.repeat(1011)}`, 64));

    expect(commandCount()).toBe(3);
  });

  it('длинное начало команды тоже занимает место: openssl считается своей строкой', async () => {
    passportMock.mockResolvedValue(passport({ sha256: 'openssl' }));
    silentServer();

    await verify(treeOf((index) => `/srv/${index}/${'я'.repeat(400)}`, 200));

    expect(sentCommand()).toMatch(/^openssl dgst -sha256 /);
    expect(Math.max(...allSentBytes())).toBeLessThanOrEqual(LIMIT_BYTES);
  });
});

/**
 * Обещанный срок принадлежит всей сверке, а не каждой её команде.
 *
 * Список дробится на команды, и их число задаёт длина списка: тот же потолок
 * на каждой означал бы, что названные пользователем секунды множатся на число
 * команд. Второе требование сильнее первого: исчерпанный срок — это «проверить
 * нечем», никогда не «не сошлось». По расхождению установщик сносит уже
 * уехавшее дерево, а здесь недостача хэшей объясняется временем, а не файлами.
 */
describe('сверка: срок стоит на всей операции', () => {
  /** Часы под управлением теста: время двигается только тем, что мы велим */
  function fakeClock() {
    let now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    return { advance: (ms: number) => void (now += ms), restore: () => spy.mockRestore() };
  }

  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    clock = fakeClock();
  });

  afterEach(() => {
    clock.restore();
  });

  const treeOf = (count: number, name = (index: number) => `/srv/file-${index}`) =>
    Array.from({ length: count }, (_, index) => ({ path: name(index), hash: HASH_ONE }));

  /** Сервер отвечает честными хэшами и тратит на это заданное время */
  const serverSpending = (ms: number) =>
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      clock.advance(ms);
      const paths = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      return reply(paths.map((path) => `${HASH_ONE}  ${path}`).join('\n') + '\n');
    });

  const verify = (entries: { path: string; hash: string }[], timeoutMs?: number) =>
    verifyRemoteFiles(executor(), CONFIG, entries, { profileName: 'production', timeoutMs });

  /** Срок, доставшийся каждой отправленной команде */
  const timeoutsSent = () =>
    executeMock.mock.calls.map((call) => (call[2] as { timeout: number }).timeout);

  it('каждая следующая команда получает остаток, а не полный срок заново', async () => {
    serverSpending(1000);

    await verify(treeOf(202), 10_000);

    expect(timeoutsSent()).toEqual([10_000, 9000, 8000]);
  });

  it('исчерпанный срок — «проверить нечем», а не «не сошлось»', async () => {
    // Хэши первых двух сотен уже собраны и сошлись, а на остаток списка времени
    // не хватило: старый счёт объявил бы недостающие файлы испорченными
    serverSpending(3000);

    const outcome = await verify(treeOf(202), 5000);

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('time allowed for verification'),
    });
    expect(timeoutsSent()).toEqual([5000, 2000]);
  });

  it('остаток, съеденный ровно в ноль, — уже исчерпанный срок', async () => {
    serverSpending(3000);

    const outcome = await verify(treeOf(202), 3000);

    expect(outcome.status).toBe('unavailable');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Имена с переводом строки спрашиваются по одному во втором цикле — он обязан
   * следить за сроком наравне с первым.
   */
  it('второй цикл, где трудные имена идут по одному, тоже следит за сроком', async () => {
    serverSpending(2000);
    const entries = [
      { path: '/srv/plain.txt', hash: HASH_ONE },
      { path: '/srv/one\nline.txt', hash: HASH_ONE },
      { path: '/srv/two\nline.txt', hash: HASH_ONE },
    ];

    const outcome = await verify(entries, 4000);

    // Одна команда на обычное имя, одна на первое трудное — на второе трудное
    // времени уже нет
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe('unavailable');
  });

  it('проба паспорта тратит тот же срок — после неё спрашивать может быть уже нечего', async () => {
    passportMock.mockImplementation(async () => {
      clock.advance(20_000);
      return passport();
    });
    serverSpending(0);

    const outcome = await verify(treeOf(2), 5000);

    expect(executeMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('unavailable');
  });

  /**
   * На исходе срока команде достаются последние миллисекунды, и убивает её наш
   * собственный сторож — исключением. Наружу оно уйти не должно: сверка обязана
   * отвечать исходом, а ошибка здесь читается как провал передачи.
   */
  it('команда, убитая своим же сроком, — «проверить нечем», а не ошибка наверх', async () => {
    executeMock.mockImplementation(async () => {
      clock.advance(6000);
      throw new Error('Command timed out after 5000ms on example.com');
    });

    const outcome = await verify(treeOf(2), 5000);

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('time allowed for verification'),
    });
  });

  it('ошибка не по времени идёт наверх, а не выдаётся за исчерпанный срок', async () => {
    executeMock.mockImplementation(async () => {
      clock.advance(10);
      throw new Error('ssh: connect to host example.com port 22: Connection refused');
    });

    await expect(verify(treeOf(2), 5000)).rejects.toThrow('Connection refused');
  });

  it('повторный сбор после пропавшей утилиты идёт с остатком, а не с новым сроком', async () => {
    passportMock
      .mockResolvedValueOnce(passport())
      .mockResolvedValueOnce(passport({ sha256: 'openssl' }));
    executeMock
      .mockImplementationOnce(async () => {
        clock.advance(4000);
        return reply('', { exitCode: 127, stderr: 'sh: sha256sum: not found' });
      })
      .mockImplementationOnce(async () => {
        clock.advance(1000);
        return reply(`SHA2-256(/srv/file-0)= ${HASH_ONE}\n`);
      });

    const outcome = await verify(treeOf(1), 10_000);

    expect(timeoutsSent()).toEqual([10_000, 6000]);
    expect(outcome.status).toBe('matched');
  });

  /**
   * Повторный сбор идёт по тому же дереву и с тем же сроком. Ветка у него своя,
   * и неполный ответ в ней обязан читаться так же, как в первом заходе.
   */
  it('срок, истёкший на повторном сборе, — тоже «проверить нечем»', async () => {
    passportMock
      .mockResolvedValueOnce(passport())
      .mockResolvedValueOnce(passport({ sha256: 'openssl' }));
    executeMock
      .mockImplementationOnce(async () => {
        clock.advance(1000);
        return reply('', { exitCode: 127, stderr: 'sh: sha256sum: not found' });
      })
      .mockImplementationOnce(async () => {
        clock.advance(9000);
        return reply(`SHA2-256(/srv/file-0)= ${HASH_ONE}\n`);
      });

    // Второй заход собрал сотню, третьей команде времени уже нет
    const outcome = await verify(treeOf(202), 10_000);

    expect(outcome).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('time allowed for verification'),
    });
  });

  it.each([
    ['срок не назван', undefined],
    ['срок назван нулём', 0],
  ])('%s — потолка нет ни у одной команды', async (_name, timeoutMs) => {
    serverSpending(60_000);

    const outcome = await verify(treeOf(202), timeoutMs);

    expect(timeoutsSent()).toEqual([0, 0, 0]);
    expect(outcome.status).toBe('matched');
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

  /**
   * Трудные имена спрашиваются вторым проходом, по одному файлу за команду, —
   * и у этого прохода те же способы остаться без ответа, что у общего:
   * сторож времени и обрезка буфера. Удавшийся первый проход не делает ответ
   * полным: недосчитанный хэш выглядит как расхождение, а по расхождению
   * установщик сносит уже уехавшее дерево.
   */
  it.each([
    ['coreutils', 124, ''],
    ['BusyBox', 143, 'Terminated'],
  ])('сторож (%s, %i) на трудном имени — «нечем», а не «не сошлось»', async (_n, exitCode, stderr) => {
    executeMock
      .mockResolvedValueOnce(reply(`${HASH_ONE}  /srv/plain.txt\n`))
      .mockResolvedValue(reply('', { exitCode, stderr }));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/plain.txt', hash: HASH_ONE },
        { path: '/srv/a\nb.txt', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('unavailable');
  });

  it('обрезанный ответ на трудном имени — «нечем», а не «не сошлось»', async () => {
    executeMock
      .mockResolvedValueOnce(reply(`${HASH_ONE}  /srv/plain.txt\n`))
      .mockResolvedValue(reply('', { truncated: true }));

    const outcome = await verifyRemoteFiles(
      executor(),
      CONFIG,
      [
        { path: '/srv/plain.txt', hash: HASH_ONE },
        { path: '/srv/a\nb.txt', hash: HASH_TWO },
      ],
      { profileName: 'production' }
    );

    expect(outcome.status).toBe('unavailable');
  });
});
