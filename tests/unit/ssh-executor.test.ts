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

const { getRunnerMock, execMock, pingMock } = vi.hoisted(() => ({
  getRunnerMock: vi.fn(),
  execMock: vi.fn(),
  pingMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({ getRunner: getRunnerMock }));

const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { SSHTransportError } = await import('../../src/runner/errors.js');

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
    timedOut: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(result());
  pingMock.mockResolvedValue({ ok: true, masterWasActive: false, latencyMs: 3 });
  getRunnerMock.mockResolvedValue({ exec: execMock, ping: pingMock });
});

describe('SSHExecutor: сборка команды', () => {
  it('оборачивает sudo в bash -c, чтобы конструкции шелла пережили sudo', async () => {
    await new SSHExecutor().execute(CONFIG, 'if true; then echo yes; fi', { sudo: true });

    expect(sentCommand()).toBe(`sudo bash -c 'if true; then echo yes; fi'`);
  });

  it('добавляет переход в рабочий каталог', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls', { cwd: '/srv/app' });

    expect(sentCommand()).toBe(`cd '/srv/app' && ls`);
  });

  it('при sudo и рабочем каталоге сначала переходит, потом повышает права', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls', { sudo: true, cwd: '/srv/app' });

    expect(sentCommand()).toBe(`cd '/srv/app' && sudo bash -c 'ls'`);
  });

  it('экранирует одинарные кавычки в команде', async () => {
    await new SSHExecutor().execute(CONFIG, `echo 'hi'`, { sudo: true });

    // Кавычка закрывает строку, вставляется как отдельная и строка открывается снова
    expect(sentCommand()).toBe(`sudo bash -c 'echo '"'"'hi'"'"''`);
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

    expect(executed).toEqual({ stdout: 'out', stderr: 'warn', exitCode: 3 });
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

  it('передаёт имя профиля в фабрику транспорта', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls', { profileName: 'production' });

    expect(getRunnerMock).toHaveBeenCalledWith(CONFIG, 'production');
  });

  it('без имени профиля использует профиль по умолчанию', async () => {
    await new SSHExecutor().execute(CONFIG, 'ls');

    expect(getRunnerMock).toHaveBeenCalledWith(CONFIG, 'default');
  });
});

describe('SSHExecutor: ошибки и проверка связи', () => {
  it('не повторяет команду сам — политика повторов живёт в транспорте', async () => {
    execMock.mockRejectedValue(new SSHTransportError('connection reset'));

    await expect(new SSHExecutor().execute(CONFIG, 'ls')).rejects.toBeInstanceOf(SSHTransportError);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('проверка связи идёт через ping транспорта', async () => {
    const connected = await new SSHExecutor().testConnection(CONFIG, 'production');

    expect(connected).toBe(true);
    expect(pingMock).toHaveBeenCalled();
  });

  it('недоступный сервер даёт false, а не исключение', async () => {
    pingMock.mockResolvedValue({ ok: false, masterWasActive: false, latencyMs: 10 });

    await expect(new SSHExecutor().testConnection(CONFIG)).resolves.toBe(false);
  });

  it('сбой транспорта при проверке связи тоже даёт false', async () => {
    pingMock.mockRejectedValue(new SSHTransportError('host unreachable'));

    await expect(new SSHExecutor().testConnection(CONFIG)).resolves.toBe(false);
  });
});
