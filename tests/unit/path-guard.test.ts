/**
 * Unit tests: разбор пути до рабочей команды
 *
 * Живьём не проверить два исхода: сервер без `readlink` (в лаборатории он есть
 * на всех трёх узлах) и сдвоенный слэш от BusyBox в ответе резолва. Оба здесь.
 *
 * Мок отвечает на пробу резолва по маркеру, а на всё остальное — пустотой,
 * поэтому «сервер промолчал» выглядит как молчание, а не как удобный ответ.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decideRemotePath } from '../../src/managers/path-guard.js';
import { UNKNOWN_PASSPORT } from '../../src/runner/passport.js';
import type { SSHExecutor } from '../../src/managers/ssh-executor.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const HOME = '/root';

/** Что сервер отвечает на пробу резолва */
let resolveAnswer: string;

const executeMock = vi.fn(async (_config: unknown, command: string) => ({
  stdout: command.includes('SSH_MCP_PATH') ? resolveAnswer : '',
  stderr: '',
  exitCode: 0,
  truncated: false,
}));

/** Что паспорт знает о доме: пустая строка — «сервер не сказал» */
let passportHome: string;

const passportMock = vi.fn(async () => ({
  ...UNKNOWN_PASSPORT,
  known: true,
  home: passportHome,
}));

const executor = {
  execute: executeMock,
  passport: passportMock,
} as unknown as SSHExecutor;

function config(pathSecurity?: Record<string, unknown>): SSHConfig {
  return { host: 'example.com', username: 'root', port: 22, pathSecurity } as SSHConfig;
}

/** Сервер отвечает тем же путём: ссылок по дороге нет */
function resolvesTo(path: string): void {
  resolveAnswer = `SSH_MCP_PATH ${path}\n`;
}

const options = { profileName: 'production' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveAnswer = 'SSH_MCP_PATH_UNRESOLVED\n';
  passportHome = HOME;
});

describe('Без правил профиля сервер не спрашивают', () => {
  it('обычный путь не стоит ни одной команды', async () => {
    const decision = await decideRemotePath(executor, config(), '/var/log/app.log', options);

    expect(decision.outcome).toBe('ok');
    expect(decision.path).toBe('/var/log/app.log');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('тильда раскрывается и помечается как переписанная', async () => {
    const decision = await decideRemotePath(executor, config(), '~/app.log', options);

    expect(decision.outcome).toBe('rewritten');
    expect(decision.path).toBe('/root/app.log');
    expect(decision.warnings).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('голая тильда — это сам дом', async () => {
    const decision = await decideRemotePath(executor, config(), '~', options);

    expect(decision.path).toBe(HOME);
  });

  it('обычный путь не тянет за собой предупреждений', async () => {
    const decision = await decideRemotePath(executor, config(), '/var/log/app.log', options);

    expect(decision.warnings).toEqual([]);
  });

  // Под sudo тильду раньше раскрывал сервер — уже от имени root. Адрес другой,
  // и человек должен это узнать
  it('под sudo тильда объясняет, чей дом имеется в виду', async () => {
    const decision = await decideRemotePath(executor, config(), '~/app.log', {
      ...options,
      sudo: true,
    });

    expect(decision.warnings).toEqual([
      '"~/app.log" points at /root/app.log — the home of the login user, not root\'s. ' +
        'Pass an absolute path if you meant a different directory.',
    ]);
  });
});

describe('С правилами путь приводится к каноническому виду', () => {
  it('относительный путь достраивается от дома', async () => {
    resolvesTo('/root/logs/app.log');
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/root/logs'] }),
      'logs/app.log',
      options
    );

    expect(decision.canonical).toBe('/root/logs/app.log');
    expect(decision.outcome).toBe('ok');
  });

  it('в команду уезжает исходный путь, а не свёрнутый', async () => {
    resolvesTo('/var/log/app.log');
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/dir/../app.log',
      options
    );

    // `..` считается после перехода по ссылке, поэтому свёрнутый путь годится
    // для суждения, но не для команды
    expect(decision.canonical).toBe('/var/log/app.log');
    expect(decision.path).toBe('/var/log/dir/../app.log');
  });

  it('сдвоенный слэш из ответа BusyBox сворачивается', async () => {
    resolveAnswer = 'SSH_MCP_PATH //root/secret\n';
    const decision = await decideRemotePath(
      executor,
      config({ deniedPaths: ['/root'] }),
      '/tmp/link',
      options
    );

    expect(decision.outcome).toBe('denied');
    expect(decision.reason).toContain('/root/secret');
  });

  it('дома нет — относительный путь судить нечем, и правило это скажет', async () => {
    passportHome = '';
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/root/logs'] }),
      'logs/app.log',
      options
    );

    expect(decision.outcome).toBe('denied');
    expect(decision.reason).toContain('not canonical');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('абсолютный путь дом не запрашивает', async () => {
    resolvesTo('/var/log/app.log');
    await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/app.log',
      options
    );

    expect(passportMock).not.toHaveBeenCalled();
  });

  it('раскрытая тильда остаётся переписанной и под правилами', async () => {
    resolvesTo('/root/app.log');
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/root'] }),
      '~/app.log',
      options
    );

    expect(decision.outcome).toBe('rewritten');
  });

  it('сервер ответил корнем', async () => {
    resolveAnswer = 'SSH_MCP_PATH \n';
    const decision = await decideRemotePath(
      executor,
      config({ deniedPaths: ['/root'] }),
      '/tmp/link',
      options
    );

    expect(decision.target).toBe('/');
    expect(decision.outcome).toBe('ok');
  });

  it('баннер сервера ответом не считается', async () => {
    resolveAnswer = `Welcome to Ubuntu\nLast login: never\nSSH_MCP_PATH /var/log/app.log\n`;
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/app.log',
      options
    );

    expect(decision.outcome).toBe('ok');
    expect(decision.target).toBe('/var/log/app.log');
  });
});

describe('Правило применяется и к имени, и к назначению', () => {
  it('ссылка из разрешённого каталога наружу отклоняется', async () => {
    resolvesTo('/root/secret');
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/escape/secret',
      options
    );

    expect(decision.outcome).toBe('denied');
    expect(decision.reason).toContain('/var/log/escape/secret → /root/secret');
  });

  it('запрещённое имя отклоняется до пробы на сервер', async () => {
    const decision = await decideRemotePath(
      executor,
      config({ deniedPaths: ['/root'] }),
      '/root/secret',
      options
    );

    expect(decision.outcome).toBe('denied');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('ссылка внутрь разрешённого каталога проходит', async () => {
    resolvesTo('/var/log/inner/app.log');
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/shortcut/app.log',
      options
    );

    expect(decision.outcome).toBe('ok');
    expect(decision.target).toBe('/var/log/inner/app.log');
  });
});

describe('Сервер не смог ответить — это пропуск с предупреждением, а не отказ', () => {
  it('работа не запрещается, но человек узнаёт о пробеле', async () => {
    const decision = await decideRemotePath(
      executor,
      config({ allowedPaths: ['/var/log'] }),
      '/var/log/app.log',
      options
    );

    expect(decision.outcome).toBe('unverified');
    expect(decision.warnings).toEqual([
      '"/var/log/app.log" was checked by name only: the server could not resolve it, ' +
        'so a symlink pointing elsewhere would go unnoticed.',
    ]);
    expect(decision.target).toBeUndefined();
  });

  // Проба — чтение, повтор её ничего не портит: обрыв на ней не должен
  // проваливать операцию целиком
  it('проба помечена повторяемой', async () => {
    await decideRemotePath(executor, config({ allowedPaths: ['/var/log'] }), '/var/log/x', options);

    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('readlink'),
      expect.objectContaining({ idempotent: true })
    );
  });

  it('правило по имени работает и без ответа сервера', async () => {
    const decision = await decideRemotePath(
      executor,
      config({ deniedPaths: ['/root'] }),
      '/root/secret',
      options
    );

    expect(decision.outcome).toBe('denied');
  });
});
