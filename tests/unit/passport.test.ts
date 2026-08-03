/**
 * Паспорт сервера
 *
 * Одна проба за сессию вместо россыпи проверок «а есть ли на сервере вот это».
 * Читается по маркеру: удалённая сторона может подмешать баннер, motd или мусор
 * от экзотического shell, и всё это не должно ломать разбор.
 *
 * Правило поверх всего: паспорт ускоряет и уточняет, но ничего не разрешает.
 * Не ответил — работаем по самому осторожному пути, а не падаем.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  PASSPORT_PROBE_COMMAND,
  UNKNOWN_PASSPORT,
  parsePassport,
  getServerPassport,
  invalidatePassport,
  resetPassportCache,
} = await import('../../src/runner/passport.js');

const COREUTILS_LINE =
  'SSH_MCP_PASSPORT bash=1 sha256=sha256sum coreutils=coreutils rsync=1 timeout=1 install=1 os=Linux';
const BUSYBOX_LINE =
  'SSH_MCP_PASSPORT bash=0 sha256=sha256sum coreutils=busybox rsync=0 timeout=1 install=1 os=Linux';
const BARE_LINE =
  'SSH_MCP_PASSPORT bash=0 sha256=none coreutils=busybox rsync=0 timeout=0 install=0 os=Linux';

describe('проба паспорта', () => {
  it('исполняется через sh -c, потому что login-shell может оказаться csh или fish', () => {
    expect(PASSPORT_PROBE_COMMAND.startsWith('sh -c ')).toBe(true);
  });

  it('печатает единственную строку с маркером', () => {
    expect(PASSPORT_PROBE_COMMAND).toContain('SSH_MCP_PASSPORT');
  });
});

describe('parsePassport', () => {
  it('читает обычный сервер с coreutils', () => {
    const passport = parsePassport(COREUTILS_LINE);

    expect(passport).toMatchObject({
      bash: true,
      sha256: 'sha256sum',
      coreutils: 'coreutils',
      rsync: true,
      remoteTimeout: true,
      install: true,
      os: 'Linux',
      known: true,
    });
  });

  it('читает BusyBox-машину: ни bash, ни rsync', () => {
    const passport = parsePassport(BUSYBOX_LINE);

    expect(passport.bash).toBe(false);
    expect(passport.coreutils).toBe('busybox');
    expect(passport.rsync).toBe(false);
    expect(passport.known).toBe(true);
  });

  it('читает машину без половины утилит: считать хэши нечем', () => {
    const passport = parsePassport(BARE_LINE);

    expect(passport.sha256).toBe('none');
    expect(passport.install).toBe(false);
    expect(passport.remoteTimeout).toBe(false);
  });

  it('находит маркер среди баннера и постороннего вывода', () => {
    const noisy = [
      'Welcome to Ubuntu 22.04.3 LTS',
      '  System load: 0.08   Processes: 128',
      COREUTILS_LINE,
      'Last login: Sun Aug  3 11:20:31 2026',
    ].join('\n');

    expect(parsePassport(noisy).bash).toBe(true);
  });

  it('вывод без маркера означает «ничего не знаем», а не выдуманные значения', () => {
    const passport = parsePassport('sh: printf: not found\n');

    expect(passport).toEqual(UNKNOWN_PASSPORT);
    expect(passport.known).toBe(false);
  });

  it('неизвестное состояние — самое осторожное: ни bash, ни удалённого сторожа, хэши нечем', () => {
    expect(UNKNOWN_PASSPORT).toMatchObject({
      bash: false,
      sha256: 'none',
      coreutils: 'unknown',
      rsync: false,
      remoteTimeout: false,
      install: false,
      known: false,
    });
  });

  it('читает домашний каталог: без него `~/x` раскрывать нечем', () => {
    expect(parsePassport(`${COREUTILS_LINE} home=/home/deploy`).home).toBe('/home/deploy');
  });

  it('домашний каталог с пробелом доезжает целиком', () => {
    // Поле идёт последним и читается до конца строки: разбей мы его по
    // пробелам, как остальные, — путь обрезался бы до «/home/john»
    expect(parsePassport(`${COREUTILS_LINE} home=/home/john doe`).home).toBe('/home/john doe');
  });

  it('не абсолютный домашний каталог считается неизвестным', () => {
    // Пустой ответ, `~` или обрывок означают, что мы не знаем, куда писать.
    // Догадка здесь означала бы файл не по тому адресу
    expect(parsePassport(`${COREUTILS_LINE} home=`).home).toBe('');
    expect(parsePassport(`${COREUTILS_LINE} home=~`).home).toBe('');
  });

  it('старый ответ без поля home разбирается по-прежнему', () => {
    const passport = parsePassport(COREUTILS_LINE);

    expect(passport.home).toBe('');
    expect(passport.bash).toBe(true);
  });

  it('незнакомое значение поля не ломает разбор остальных', () => {
    const passport = parsePassport(
      'SSH_MCP_PASSPORT bash=1 sha256=magictool coreutils=coreutils rsync=1 timeout=1 install=1 os=Linux'
    );

    expect(passport.sha256).toBe('none');
    expect(passport.bash).toBe(true);
  });
});

describe('getServerPassport', () => {
  beforeEach(() => {
    resetPassportCache();
  });

  it('спрашивает сервер один раз на назначение', async () => {
    const probe = vi.fn().mockResolvedValue(COREUTILS_LINE);

    await getServerPassport('deploy@example.com:22', probe);
    await getServerPassport('deploy@example.com:22', probe);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('две параллельные первые команды не запускают пробу наперегонки', async () => {
    let started = 0;
    const probe = vi.fn(async () => {
      started++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return COREUTILS_LINE;
    });

    const [first, second] = await Promise.all([
      getServerPassport('deploy@example.com:22', probe),
      getServerPassport('deploy@example.com:22', probe),
    ]);

    expect(started).toBe(1);
    expect(first).toBe(second);
  });

  it('разные назначения — разные паспорта', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(COREUTILS_LINE)
      .mockResolvedValueOnce(BUSYBOX_LINE);

    const modern = await getServerPassport('deploy@modern:22', probe);
    const poor = await getServerPassport('root@router:22', probe);

    expect(modern.bash).toBe(true);
    expect(poor.bash).toBe(false);
  });

  it('сбой пробы не роняет операцию — просто ничего не знаем', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('connection reset'));

    const passport = await getServerPassport('deploy@example.com:22', probe);

    expect(passport).toEqual(UNKNOWN_PASSPORT);
  });

  it('неудачную пробу не кэшируем навсегда: следующий вызов пробует снова', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(COREUTILS_LINE);

    const failed = await getServerPassport('deploy@example.com:22', probe);
    const second = await getServerPassport('deploy@example.com:22', probe);

    expect(failed.known).toBe(false);
    expect(second.known).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('паспорт можно сбросить, когда сервер изменился под нами', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(COREUTILS_LINE)
      .mockResolvedValueOnce(BUSYBOX_LINE);

    const before = await getServerPassport('deploy@example.com:22', probe);
    invalidatePassport('deploy@example.com:22');
    const after = await getServerPassport('deploy@example.com:22', probe);

    expect(before.rsync).toBe(true);
    expect(after.rsync).toBe(false);
  });
});
