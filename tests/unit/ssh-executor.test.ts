/**
 * Unit tests for SSHExecutor
 *
 * После врезки транспорта executor отвечает за две вещи: собрать строку
 * команды (sudo, рабочий каталог) и отдать результат как есть. Ни повторов,
 * ни собственных таймаутов у него больше нет — это дело раннера.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';
import type { ExecResult } from '../../src/runner/types.js';

const { getRunnerMock, execMock, pingMock, passportMock } = vi.hoisted(() => ({
  getRunnerMock: vi.fn(),
  execMock: vi.fn(),
  pingMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { SSHTransportError } = await import('../../src/runner/errors.js');
const { resetPassportCache, parsePassport, UNKNOWN_PASSPORT } =
  await import('../../src/runner/passport.js');

/**
 * Ответ транспорта на вопрос о паспорте: под sudo от него зависит язык команд.
 * Разбирается настоящим разбором — заглушка не должна знать больше сервера.
 */
function passportSays(bash: boolean): void {
  passportMock.mockResolvedValue(
    parsePassport(
      `SSH_MCP_PASSPORT bash=${bash ? 1 : 0} sha256=sha256sum coreutils=coreutils ` +
      'rsync=0 timeout=1 install=1 os=Linux home=/home/deploy\n'
    )
  );
}

const CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    truncated: false,
    durationMs: 1,
    ...overrides,
  };
}

/** Команда, отправленная в транспорт на n-м вызове */
function sentCommand(index = 0): string {
  return execMock.mock.calls[index][0] as string;
}

/** Опции, отправленные в транспорт на n-м вызове */
function sentOptions(index = 0): Record<string, unknown> {
  return execMock.mock.calls[index][1] as Record<string, unknown>;
}

/** Последняя команда, ушедшая в транспорт */
function lastCommand(): string {
  return execMock.mock.calls[execMock.mock.calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPassportCache();
  execMock.mockResolvedValue(result());
  pingMock.mockResolvedValue({ state: 'ready', masterWasActive: false, latencyMs: 3 });
  passportMock.mockResolvedValue(UNKNOWN_PASSPORT);
  getRunnerMock.mockResolvedValue({ exec: execMock, ping: pingMock, passport: passportMock });
});

/** Профиль, который входит по паролю, а не по ключу */
const PASSWORD_CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'pwuser',
  password: 'letmein',
};

/**
 * Пароль до sudo не доходил вовсе: обёртка звала его без `-S`, а терминала,
 * на котором sudo мог бы спросить, у нас нет. На парольной машине любая
 * операция с повышением прав отвечала «a terminal is required».
 */
describe('SSHExecutor: пароль для sudo', () => {
  it('парольный профиль подаёт пароль на ввод, а не в аргументы', async () => {
    passportSays(true);

    await new SSHExecutor().execute(PASSWORD_CONFIG, 'ls /root', { sudo: true });

    expect(lastCommand()).toBe(`sudo -S -p '' bash -c 'ls /root'`);
    expect(sentOptions().stdin).toBe('letmein\n');
  });

  /** В argv пароль виден любому, кто смотрит на список процессов сервера */
  it('пароль не попадает в строку команды', async () => {
    passportSays(true);

    await new SSHExecutor().execute(PASSWORD_CONFIG, 'ls /root', { sudo: true });

    expect(lastCommand()).not.toContain('letmein');
  });

  it('профиль по ключу зовёт sudo как прежде', async () => {
    passportSays(true);

    await new SSHExecutor().execute(CONFIG, 'ls /root', { sudo: true });

    expect(lastCommand()).toBe(`sudo bash -c 'ls /root'`);
    expect(sentOptions().stdin).toBeUndefined();
  });

  it('без sudo пароль на ввод не уходит', async () => {
    await new SSHExecutor().execute(PASSWORD_CONFIG, 'ls');

    expect(lastCommand()).toBe('ls');
    expect(sentOptions().stdin).toBeUndefined();
  });

  /**
   * Занятый ввод пароль не принимает: при беспарольном sudo строка не будет
   * прочитана и приедет первой строкой самих данных — то есть в файл.
   */
  it('где ввод занят данными, пароль не подмешивается', async () => {
    passportSays(true);

    await new SSHExecutor().execute(PASSWORD_CONFIG, 'cat > /etc/app.conf', {
      sudo: true,
      stdin: 'key = value\n',
    });

    expect(lastCommand()).toBe(`sudo bash -c 'cat > /etc/app.conf'`);
    expect(sentOptions().stdin).toBe('key = value\n');
  });

  it('профиль по ключу отвечает sudo своим паролем', async () => {
    passportSays(true);

    await new SSHExecutor().execute({ ...CONFIG, sudoPassword: 'root-secret' }, 'ls /root', {
      sudo: true,
    });

    expect(lastCommand()).toBe(`sudo -S -p '' bash -c 'ls /root'`);
    expect(sentOptions().stdin).toBe('root-secret\n');
  });

  /** Спрашивают здесь пароль sudo, а не пароль входа: совпадают они не всегда */
  it('где есть оба, уходит пароль для sudo', async () => {
    passportSays(true);

    await new SSHExecutor().execute(
      { ...PASSWORD_CONFIG, sudoPassword: 'root-secret' },
      'ls /root',
      { sudo: true }
    );

    expect(sentOptions().stdin).toBe('root-secret\n');
    expect(lastCommand()).not.toContain('root-secret');
    expect(lastCommand()).not.toContain('letmein');
  });

  it('и он тоже не подмешивается, где ввод занят данными', async () => {
    passportSays(true);

    await new SSHExecutor().execute({ ...CONFIG, sudoPassword: 'root-secret' }, 'cat > /etc/app.conf', {
      sudo: true,
      stdin: 'key = value\n',
    });

    expect(lastCommand()).toBe(`sudo bash -c 'cat > /etc/app.conf'`);
    expect(sentOptions().stdin).toBe('key = value\n');
  });
});

describe('SSHExecutor: сборка команды', () => {
  it('оборачивает sudo в bash -c, чтобы конструкции шелла пережили sudo', async () => {
    passportSays(true);

    await new SSHExecutor().execute(CONFIG, 'if true; then echo yes; fi', { sudo: true });

    expect(lastCommand()).toBe(`sudo bash -c 'if true; then echo yes; fi'`);
  });

  it('на сервере без bash берёт sh: иначе sudo не работает вовсе', async () => {
    // Измерено на Alpine: `sudo bash -c …` отвечает «bash: command not found»,
    // то есть любая операция с повышением прав там была невозможна
    passportSays(false);

    await new SSHExecutor().execute(CONFIG, 'cat > /etc/app.conf', { sudo: true });

    expect(lastCommand()).toBe(`sudo sh -c 'cat > /etc/app.conf'`);
  });

  it('паспорт не прочитан — работаем через sh, он есть везде', async () => {
    passportMock.mockResolvedValue(parsePassport('sh: printf: not found'));

    await new SSHExecutor().execute(CONFIG, 'ls', { sudo: true });

    expect(lastCommand()).toBe(`sudo sh -c 'ls'`);
  });

  it('добавляет переход в рабочий каталог', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls', { cwd: '/srv/app' });

    expect(sentCommand()).toBe(`cd '/srv/app' || exit 1; ls`);
  });

  /**
   * `&&` связывает только ближайшую команду: всё после `;` выполнялось в чужом
   * каталоге и заканчивалось кодом 0, то есть успехом.
   */
  it('неудачный переход обрывает всю строку, а не только первую команду', async () => {
    await new SSHExecutor().execute(CONFIG, 'echo before; pwd; echo after', { cwd: '/srv/app' });

    expect(sentCommand()).toBe(`cd '/srv/app' || exit 1; echo before; pwd; echo after`);
    expect(sentCommand()).not.toContain('&&');
  });

  it('при sudo и рабочем каталоге сначала переходит, потом повышает права', async () => {
    passportSays(true);

    await new SSHExecutor().execute(CONFIG, 'ls', { sudo: true, cwd: '/srv/app' });

    expect(lastCommand()).toBe(`cd '/srv/app' || exit 1; sudo bash -c 'ls'`);
  });

  /**
   * Команда, оканчивающаяся на `&`, внутри `{ … ; }` даёт синтаксическую ошибку
   * на BusyBox и dropbear, поэтому текст команды не заворачивается ничем.
   */
  it('текст команды переходом не обрамляется', async () => {
    await new SSHExecutor().execute(CONFIG, 'sleep 1 &', { cwd: '/srv/app' });

    expect(sentCommand()).toBe(`cd '/srv/app' || exit 1; sleep 1 &`);
  });

  it('экранирует одинарные кавычки в команде', async () => {
    passportSays(true);

    await new SSHExecutor().execute(CONFIG, `echo 'hi'`, { sudo: true });

    // Кавычка закрывает строку, вставляется экранированной и строка открывается снова
    expect(lastCommand()).toBe(`sudo bash -c 'echo '\\''hi'\\'''`);
  });

  it('оставляет обычную команду нетронутой', async () => {
    await new SSHExecutor().execute(CONFIG, 'uptime -p');

    expect(sentCommand()).toBe('uptime -p');
  });
});

describe('SSHExecutor: результат', () => {
  it('отдаёт stdout, stderr и код возврата, полученные от транспорта', async () => {
    execMock.mockResolvedValue(result({ stdout: 'out', stderr: 'warn', exitCode: 3 }));

    const executed = await new SSHExecutor().execute(CONFIG, 'ls /missing');

    expect(executed).toEqual({ stdout: 'out', stderr: 'warn', exitCode: 3, truncated: false });
  });

  it('пометку об обрезке вывода передаёт дальше, а не съедает', async () => {
    execMock.mockResolvedValue(result({ stdout: 'первая часть', truncated: true }));

    await expect(new SSHExecutor().execute(CONFIG, 'du -a /')).resolves.toMatchObject({
      truncated: true,
    });
  });

  it('ненулевой код возврата не превращается в исключение', async () => {
    execMock.mockResolvedValue(result({ exitCode: 1 }));

    await expect(new SSHExecutor().execute(CONFIG, 'grep missing file')).resolves.toMatchObject({
      exitCode: 1,
    });
  });
});

describe('SSHExecutor.executeChecked: шаг, который обязан удаться', () => {
  it('успешную команду отдаёт как обычно', async () => {
    execMock.mockResolvedValue(result({ stdout: 'done' }));

    await expect(
      new SSHExecutor().executeChecked(CONFIG, 'mkdir -p /srv/app')
    ).resolves.toMatchObject({ stdout: 'done' });
  });

  it('на ненулевом коде объясняет, что именно не получилось', async () => {
    execMock.mockResolvedValue(
      result({ exitCode: 1, stderr: 'mkdir: cannot create directory: Permission denied' })
    );

    await expect(new SSHExecutor().executeChecked(CONFIG, 'mkdir -p /srv/app')).rejects.toThrow(
      /mkdir -p \/srv\/app.*Permission denied/
    );
  });

  it('при пустом stderr сообщает хотя бы код возврата', async () => {
    execMock.mockResolvedValue(result({ exitCode: 2 }));

    await expect(new SSHExecutor().executeChecked(CONFIG, 'false')).rejects.toThrow(/exit code 2/);
  });

  /**
   * Сторож времени на сервере убивает команду разными кодами: coreutils
   * возвращает 124, BusyBox — 143 (это 128 + SIGTERM). Замерено на обоих
   * серверах лаборатории. Голое «143» читается как отказ самой команды,
   * поэтому пояснение обязано быть у каждого из кодов, а не у одного.
   */
  it.each([
    ['coreutils', 124],
    ['BusyBox', 143],
  ])('код сторожа %s (%i) объясняется словами, а не остаётся числом', async (_name, exitCode) => {
    execMock.mockResolvedValue(result({ exitCode }));

    await expect(new SSHExecutor().executeChecked(CONFIG, 'rsync -a /srv /backup')).rejects.toThrow(
      /timeout/i
    );
  });

  it('обычный ненулевой код пояснения про сторож не получает', async () => {
    execMock.mockResolvedValue(result({ exitCode: 1 }));

    await expect(new SSHExecutor().executeChecked(CONFIG, 'grep x file')).rejects.toThrow(
      /^(?!.*timeout).*$/i
    );
  });
});

describe('SSHExecutor: передача опций транспорту', () => {
  it('переводит таймаут в миллисекунды транспорта', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls', { timeout: 5000 });

    expect(sentOptions().timeoutMs).toBe(5000);
  });

  it('без явного таймаута использует значение по умолчанию', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls');

    expect(sentOptions().timeoutMs).toBe(30000);
  });

  /**
   * Ноль означает «потолка нет», а не «ноль миллисекунд». Так зовут команды,
   * длительность которых задаёт объём данных: сверка хэшей дерева на
   * гигабайты не обязана укладываться в общие 30 секунд.
   */
  it('ноль означает отсутствие потолка, а не мгновенный обрыв', async () => {
    await new SSHExecutor().execute(CONFIG, 'sha256sum -- /srv/app/big.bin', { timeout: 0 });

    expect(sentOptions().timeoutMs).toBe(0);
  });

  it('прокидывает пометку об идемпотентности', async () => {
    await new SSHExecutor().execute(CONFIG, 'cat /etc/hostname', { idempotent: true });

    expect(sentOptions().idempotent).toBe(true);
  });

  it('по умолчанию команда считается мутирующей', async () => {
    await new SSHExecutor().execute(CONFIG, 'rm /tmp/file');

    expect(sentOptions().idempotent).toBeFalsy();
  });

  it('передаёт данные на вход команды', async () => {
    await new SSHExecutor().execute(CONFIG, 'sha256sum -c -', {
      stdin: 'abc123  /srv/app/file\n',
    });

    expect(sentOptions().stdin).toBe('abc123  /srv/app/file\n');
  });

  it('берёт транспорт по конфигурации соединения', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls');

    expect(getRunnerMock).toHaveBeenCalledWith(CONFIG);
  });
});

describe('SSHExecutor: ошибки и проверка связи', () => {
  it('не повторяет команду сам — политика повторов живёт в транспорте', async () => {
    execMock.mockRejectedValue(new SSHTransportError('connection reset'));

    await expect(new SSHExecutor().execute(CONFIG, 'ls')).rejects.toBeInstanceOf(SSHTransportError);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('проверка связи идёт через ping транспорта', async () => {
    const connected = await new SSHExecutor().testConnection(CONFIG);

    expect(connected).toBe(true);
    expect(pingMock).toHaveBeenCalled();
  });

  it('недоступный сервер даёт false, а не исключение', async () => {
    pingMock.mockResolvedValue({ state: 'no-route', masterWasActive: false, latencyMs: 10 });

    await expect(new SSHExecutor().testConnection(CONFIG)).resolves.toBe(false);
  });

  it('сбой транспорта при проверке связи тоже даёт false', async () => {
    pingMock.mockRejectedValue(new SSHTransportError('host unreachable'));

    await expect(new SSHExecutor().testConnection(CONFIG)).resolves.toBe(false);
  });
});
