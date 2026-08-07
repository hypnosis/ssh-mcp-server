/**
 * Unit tests for the OpenSSH-backed runner
 *
 * Запуск процессов подменён: он покрыт отдельно в process.test.ts,
 * здесь проверяется логика поверх него — повторы, шлюз первой команды,
 * обработка таймаутов и маскировка секретов.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProcessRunOptions, ProcessRunOutcome } from '../../src/runner/process.js';
import { describeRunnerContract } from './runner-contract.js';

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }));
vi.mock('../../src/runner/process.js', () => ({ runProcess: runProcessMock }));

const { detectRuntimeMock } = vi.hoisted(() => ({ detectRuntimeMock: vi.fn() }));
vi.mock('../../src/runner/runtime-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/runtime-check.js')>();
  return { ...actual, detectRuntime: detectRuntimeMock };
});

const { OpenSshRunner, getOpenSshRunner, runnerKey, configFingerprint, resetRunnerCache } =
  await import('../../src/runner/openssh-runner.js');
const { SSHAuthError, SSHCancelledError, SSHTimeoutError, SSHTransportError, SSHRunnerError } =
  await import('../../src/runner/errors.js');
const { SSH_FAILURE_EXIT_CODE } = await import('../../src/runner/error-classifier.js');
const { resetPassportCache } = await import('../../src/runner/passport.js');
import type { RunnerConfig } from '../../src/runner/ssh-args.js';
import type { SshRuntime } from '../../src/runner/runtime-check.js';

const CONFIG: RunnerConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

const RUNTIME: SshRuntime = {
  available: true,
  version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
  multiplexing: true,
  askpassForce: true,
  scpOverSftp: true,
  controlDir: '/home/user/.ssh/ssh-mcp',
};

/** Успешный исход запуска процесса */
function ok(overrides: Partial<ProcessRunOutcome> = {}): ProcessRunOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signalCode: null,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

/** Аргументы n-го запуска процесса */
function callArgs(index: number): string[] {
  return (runProcessMock.mock.calls[index][0] as ProcessRunOptions).args;
}

/** Удалённая команда — последний аргумент вызова ssh */
function remoteCommand(index: number): string {
  const args = callArgs(index);
  return args[args.length - 1];
}

function hasControlMaster(index: number): boolean {
  return callArgs(index).some((arg) => arg.startsWith('ControlMaster='));
}

function makeRunner(config: RunnerConfig = CONFIG, runtime: SshRuntime = RUNTIME) {
  return new OpenSshRunner(config, runtime);
}

/** Ответ пробы паспорта: по умолчанию обычный сервер с bash и timeout */
function passportLine(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    bash: '1',
    sha256: 'sha256sum',
    coreutils: 'coreutils',
    rsync: '0',
    timeout: '1',
    install: '1',
    os: 'Linux',
    ...overrides,
  };
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  return `SSH_MCP_PASSPORT ${pairs.join(' ')}\n`;
}

beforeEach(() => {
  runProcessMock.mockReset();
  detectRuntimeMock.mockReset();
  detectRuntimeMock.mockResolvedValue(RUNTIME);
  resetRunnerCache();
  resetPassportCache();
});

describe('OpenSshRunner.exec', () => {
  it('returns stdout, stderr and exit code separately', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: 'out', stderr: 'warn', exitCode: 0 }));

    const result = await makeRunner().exec('whoami', { remoteTimeout: false });

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(0);
  });

  it('reports a non-zero exit code as a result, not a failure', async () => {
    runProcessMock.mockResolvedValue(ok({ exitCode: 1, stdout: '' }));

    const result = await makeRunner().exec('grep missing file', { remoteTimeout: false });

    expect(result.exitCode).toBe(1);
  });

  it('passes the command through as a single argument', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().exec('ls -la /tmp', { remoteTimeout: false });

    expect(remoteCommand(0)).toBe('ls -la /tmp');
  });
});

describe('OpenSshRunner timeouts and cancellation', () => {
  it('raises a timeout error instead of returning a partial result', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null, stdout: 'partial' }));

    await expect(makeRunner().exec('sleep 100', { remoteTimeout: false })).rejects.toThrow(
      SSHTimeoutError
    );
  });

  it('keeps partial output on the timeout error', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null, stdout: 'partial' }));

    await expect(makeRunner().exec('sleep 100', { remoteTimeout: false })).rejects.toMatchObject({
      partialStdout: 'partial',
    });
  });

  it('never retries a timeout — the command already started on the server', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null }));

    await expect(
      makeRunner().exec('rm -rf /tmp/data', { idempotent: true, remoteTimeout: false })
    ).rejects.toThrow(SSHTimeoutError);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('warns that the remote process may survive when the server has no timeout utility', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null }));

    await expect(makeRunner().exec('sleep 100', { remoteTimeout: false })).rejects.toThrow(
      /may still be running/
    );
  });

  /**
   * Ноль означает «потолка нет»: ни локального таймера, ни удалённого сторожа.
   * Так зовутся команды, длительность которых задаёт объём данных, — сверка
   * хэшей большого дерева не обязана укладываться в общие 30 секунд.
   */
  it('treats a zero timeout as no limit at all', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().exec('sha256sum -- /srv/app/big.bin', { timeoutMs: 0 });

    expect((runProcessMock.mock.calls[0][0] as ProcessRunOptions).timeoutMs).toBe(0);
    // Удалённый сторож `timeout N sh -c` тоже не ставится: сроку нет
    expect(remoteCommand(0)).not.toMatch(/^timeout /);
  });

  it('distinguishes cancellation from a timeout', async () => {
    runProcessMock.mockResolvedValue(ok({ aborted: true, exitCode: null }));

    await expect(makeRunner().exec('sleep 100', { remoteTimeout: false })).rejects.toThrow(
      SSHCancelledError
    );
  });
});

describe('OpenSshRunner retry policy', () => {
  const transportFailure = ok({
    exitCode: SSH_FAILURE_EXIT_CODE,
    stderr: 'ssh: connect to host example.com port 22: Connection refused',
  });

  it('retries a transport failure for an idempotent command', async () => {
    runProcessMock.mockResolvedValueOnce(transportFailure).mockResolvedValueOnce(ok({ stdout: 'ok' }));

    const result = await makeRunner().exec('cat /etc/hostname', {
      idempotent: true,
      remoteTimeout: false,
    });

    expect(result.stdout).toBe('ok');
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transport failure for a mutating command', async () => {
    runProcessMock.mockResolvedValue(transportFailure);

    await expect(makeRunner().exec('rm -f /tmp/x', { remoteTimeout: false })).rejects.toThrow(
      SSHTransportError
    );
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('never retries an authentication failure — each attempt counts as a failed login', async () => {
    runProcessMock.mockResolvedValue(
      ok({ exitCode: SSH_FAILURE_EXIT_CODE, stderr: 'Permission denied (publickey).' })
    );

    await expect(
      makeRunner().exec('uptime', { idempotent: true, remoteTimeout: false })
    ).rejects.toThrow(SSHAuthError);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('stops after the second attempt', async () => {
    runProcessMock.mockResolvedValue(transportFailure);

    await expect(
      makeRunner().exec('uptime', { idempotent: true, remoteTimeout: false })
    ).rejects.toThrow(SSHTransportError);
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenSshRunner closeMaster', () => {
  it('называет закрытие закрытием и просит у ssh именно выход', async () => {
    runProcessMock.mockResolvedValue(ok());

    expect(await makeRunner().closeMaster()).toBe('closed');
    expect((runProcessMock.mock.calls[0][0] as ProcessRunOptions).file).toBe('ssh');
    expect(callArgs(0)).toContain('exit');
  });

  it('ненулевой код — это «закрывать было нечего», а не отказ', async () => {
    runProcessMock.mockResolvedValue(ok({ exitCode: 255, stderr: 'No such file or directory' }));

    expect(await makeRunner().closeMaster()).toBe('nothing-to-close');
  });

  it('без мультиплексирования ssh не запускается вовсе', async () => {
    const runtime: SshRuntime = { ...RUNTIME, multiplexing: false };

    expect(await makeRunner(CONFIG, runtime).closeMaster()).toBe('multiplexing-off');
    expect(runProcessMock).not.toHaveBeenCalled();
  });
});

describe('OpenSshRunner multiplexing', () => {
  // Отказ в сессии клиент лечит сам: открывает отдельное соединение и
  // возвращает нулевой код, оставляя жалобу в stderr. Своего отката здесь нет
  // и быть не должно — повторять нечего, команда уже выполнена
  it('keeps the client own retry to itself and returns the command output alone', async () => {
    runProcessMock.mockResolvedValue(
      ok({
        stdout: 'up 3 days',
        stderr:
          'mux_client_request_session: session request failed: Session open refused by peer\r\n' +
          'ControlSocket /tmp/ctl/s-abc already exists, disabling multiplexing\r\n',
      })
    );

    const result = await makeRunner().exec('uptime', { remoteTimeout: false });

    expect(result.stdout).toBe('up 3 days');
    expect(result.stderr.trim()).toBe('');
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the command own diagnostics next to a multiplexing notice', async () => {
    runProcessMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr:
          'mux_client_request_session: session request failed: Session open refused by peer\r\n' +
          'uptime: command not found\r\n',
      })
    );

    const result = await makeRunner().exec('uptime', { remoteTimeout: false });

    expect(result.stderr).toContain('uptime: command not found');
    expect(result.stderr).not.toContain('mux_client_request_session');
  });

  it('omits control options entirely when multiplexing is unavailable', async () => {
    runProcessMock.mockResolvedValue(ok());
    const runtime: SshRuntime = { ...RUNTIME, multiplexing: false };

    await makeRunner(CONFIG, runtime).exec('uptime', { remoteTimeout: false });

    expect(hasControlMaster(0)).toBe(false);
  });

  it('lets only the first command open the connection, so a cold start logs in once', async () => {
    let firstResolve!: (outcome: ProcessRunOutcome) => void;
    runProcessMock
      .mockImplementationOnce(
        () => new Promise<ProcessRunOutcome>((resolve) => { firstResolve = resolve; })
      )
      .mockResolvedValue(ok());

    const runner = makeRunner();
    const inFlight = [
      runner.exec('one', { remoteTimeout: false }),
      runner.exec('two', { remoteTimeout: false }),
      runner.exec('three', { remoteTimeout: false }),
    ];

    // Пока первая команда не завершилась, остальные ждут — соединение одно
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runProcessMock).toHaveBeenCalledTimes(1);

    firstResolve(ok());
    await Promise.all(inFlight);
    expect(runProcessMock).toHaveBeenCalledTimes(3);
  });

  /**
   * Сколько запусков процесса шло одновременно в самый плотный момент.
   *
   * Счётчик вызовов этого не показывает: залп из пяти команд и пять команд по
   * очереди дают одно и то же число. Замер на лаборатории считал входы в логе
   * sshd, здесь та же величина берётся с той стороны мока.
   */
  function trackPeakParallel(outcome: ProcessRunOutcome = ok()): () => number {
    let now = 0;
    let peak = 0;
    runProcessMock.mockImplementation(
      () =>
        new Promise<ProcessRunOutcome>((resolve) => {
          now += 1;
          peak = Math.max(peak, now);
          setTimeout(() => {
            now -= 1;
            resolve(outcome);
          }, 10);
        })
    );
    return () => peak;
  }

  it('после закрытия соединения профиль снова холодный, и входит одна команда', async () => {
    runProcessMock.mockResolvedValue(ok());
    const runner = makeRunner();
    await runner.exec('warm up', { remoteTimeout: false });
    await runner.closeMaster();
    const before = runProcessMock.mock.calls.length;

    let firstResolve!: (outcome: ProcessRunOutcome) => void;
    runProcessMock.mockImplementationOnce(
      () => new Promise<ProcessRunOutcome>((resolve) => { firstResolve = resolve; })
    );

    const inFlight = [
      runner.exec('one', { remoteTimeout: false }),
      runner.exec('two', { remoteTimeout: false }),
      runner.exec('three', { remoteTimeout: false }),
    ];

    // Шлюз держит остальных, пока первая не подняла соединение заново
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runProcessMock).toHaveBeenCalledTimes(before + 1);

    firstResolve(ok());
    await Promise.all(inFlight);
    expect(runProcessMock).toHaveBeenCalledTimes(before + 3);
  });

  it('пока соединение живо, команды идут разом и никого не ждут', async () => {
    runProcessMock.mockResolvedValue(ok());
    const runner = makeRunner();
    await runner.exec('warm up', { remoteTimeout: false });

    const peak = trackPeakParallel();
    await Promise.all([
      runner.exec('one', { remoteTimeout: false }),
      runner.exec('two', { remoteTimeout: false }),
      runner.exec('three', { remoteTimeout: false }),
    ]);

    expect(peak()).toBe(3);
  });

  it('после срока простоя соединения нет, и снова входит одна команда', async () => {
    const previous = process.env.SSH_MCP_CONTROL_PERSIST;
    process.env.SSH_MCP_CONTROL_PERSIST = '2';
    // Подделываем только часы: сроки в самом тесте должны идти по-настоящему
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      runProcessMock.mockResolvedValue(ok());
      const runner = makeRunner();
      await runner.exec('warm up', { remoteTimeout: false });

      vi.setSystemTime(Date.now() + 3000);
      const peak = trackPeakParallel();
      await Promise.all([
        runner.exec('one', { remoteTimeout: false }),
        runner.exec('two', { remoteTimeout: false }),
      ]);

      expect(peak()).toBe(1);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.SSH_MCP_CONTROL_PERSIST;
      else process.env.SSH_MCP_CONTROL_PERSIST = previous;
    }
  });

  /**
   * Провалившаяся первая команда не поднимает master, поэтому ждавшие снова
   * холодные — и уходить залпом им нельзя: каждая попытка считается сервером
   * за отдельный неудачный вход.
   */
  it('когда первая команда провалилась, ждавшие пробуют по одной', async () => {
    const peak = trackPeakParallel(
      ok({
        exitCode: SSH_FAILURE_EXIT_CODE,
        stderr: 'ssh: connect to host example.com port 22: Connection refused',
      })
    );
    const runner = makeRunner();

    await Promise.allSettled([
      runner.exec('one', { remoteTimeout: false }),
      runner.exec('two', { remoteTimeout: false }),
      runner.exec('three', { remoteTimeout: false }),
    ]);

    expect(peak()).toBe(1);
    expect(runProcessMock).toHaveBeenCalledTimes(3);
  });
});

describe('OpenSshRunner remote timeout guard', () => {
  it('wraps the command when the server has a timeout utility', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: passportLine() }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toBe("timeout 35 bash -c 'long-task'");
  });

  it('leaves the command alone when the server has no timeout utility', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: passportLine({ timeout: '0' }) }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toBe('long-task');
  });

  it('speaks bash when the server has it — the same language both backends promise', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: passportLine({ bash: '1' }) }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('[[ -d /tmp ]] && echo yes', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toContain("bash -c '");
  });

  it('falls back to sh where bash is missing — BusyBox and friends', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: passportLine({ bash: '0' }) }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toBe("timeout 35 sh -c 'long-task'");
  });

  it('the passport probe itself is never wrapped — the language is what it is measuring', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: passportLine() }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    // Обёртка сторожа всегда стоит в начале команды — её здесь быть не должно
    expect(remoteCommand(0)).not.toMatch(/^timeout \d+ /);
    expect(remoteCommand(0)).toMatch(/^sh -c /);
    expect(remoteCommand(0)).toContain('SSH_MCP_PASSPORT');
  });

  it('quotes the command so shell metacharacters survive the wrapper', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: passportLine() }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec("echo 'it works'", { timeoutMs: 10000 });

    expect(remoteCommand(1)).toBe(`timeout 15 bash -c 'echo '\\''it works'\\'''`);
  });

  it('probes the server only once', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: passportLine() }));
    const runner = makeRunner();

    await runner.exec('first', { timeoutMs: 5000 });
    await runner.exec('second', { timeoutMs: 5000 });

    // Проба + две команды
    expect(runProcessMock).toHaveBeenCalledTimes(3);
  });

  it('two runners to the same destination share one probe', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: passportLine() }));

    await makeRunner().exec('first', { timeoutMs: 5000 });
    await makeRunner().exec('second', { timeoutMs: 5000 });

    // Паспорт живёт на назначение, а не на экземпляр транспорта
    expect(runProcessMock).toHaveBeenCalledTimes(3);
  });

  it('carries on when the probe itself fails', async () => {
    runProcessMock
      .mockResolvedValueOnce(
        ok({ exitCode: SSH_FAILURE_EXIT_CODE, stderr: 'ssh: connect to host: Connection refused' })
      )
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    const result = await makeRunner().exec('task', { timeoutMs: 5000 });

    expect(result.stdout).toBe('done');
    expect(remoteCommand(1)).toBe('task');
  });
});

describe('OpenSshRunner secret handling', () => {
  const passwordConfig: RunnerConfig = {
    host: 'example.com',
    username: 'deploy',
    password: 'hunter2',
  };

  // Профиль с паролем создаёт askpass-скрипт на диске — уводим его во временный каталог
  let controlDir: string;
  let runtime: SshRuntime;

  beforeEach(() => {
    controlDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-runner-'));
    runtime = { ...RUNTIME, controlDir };
  });

  afterEach(() => {
    rmSync(controlDir, { recursive: true, force: true });
  });

  it('отдаёт ответ сервера нетронутым, даже если он совпал с паролем профиля', async () => {
    // Пароль на сервер не уезжает, поэтому совпадение случайное. Вырезав его,
    // мы испортили бы данные: прочитанный так конфиг записывается обратно
    // сломанным. Секрет прячется там, где мы пишем его сами, — в логе
    runProcessMock.mockResolvedValue(ok({ stdout: 'hunter2:x:0:0::/home/hunter2:/bin/sh' }));

    const result = await makeRunner(passwordConfig, runtime).exec('echo', { remoteTimeout: false });

    expect(result.stdout).toBe('hunter2:x:0:0::/home/hunter2:/bin/sh');
  });

  it('keeps the secret out of process arguments', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner(passwordConfig, runtime).exec('whoami', { remoteTimeout: false });

    expect(callArgs(0).join(' ')).not.toContain('hunter2');
  });

  it('passes the secret through the environment instead', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner(passwordConfig, runtime).exec('whoami', { remoteTimeout: false });

    const env = (runProcessMock.mock.calls[0][0] as ProcessRunOptions).env;
    expect(env?.SSH_MCP_SECRET).toBe('hunter2');
    expect(env?.SSH_ASKPASS_REQUIRE).toBe('force');
  });

  it('creates the askpass script even when multiplexing is off', async () => {
    runProcessMock.mockResolvedValue(ok());
    const noMux: SshRuntime = { ...runtime, multiplexing: false };

    await makeRunner(passwordConfig, noMux).exec('whoami', { remoteTimeout: false });

    const env = (runProcessMock.mock.calls[0][0] as ProcessRunOptions).env;
    expect(existsSync(env?.SSH_ASKPASS as string)).toBe(true);
  });
});

describe('OpenSshRunner transfers', () => {
  it('reports a failed transfer as an error', async () => {
    runProcessMock.mockResolvedValue(ok({ exitCode: 1, stderr: 'scp: /etc/x: Permission denied' }));

    await expect(makeRunner().upload('/tmp/a', '/etc/x')).rejects.toThrow(SSHRunnerError);
  });

  it('succeeds silently on exit code zero', async () => {
    runProcessMock.mockResolvedValue(ok());

    await expect(makeRunner().upload('/tmp/a', '/tmp/b')).resolves.toBeUndefined();
  });

  it('orders arguments correctly for a download', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().download('/etc/hosts', '/tmp/hosts');

    const args = callArgs(0);
    expect(args[args.length - 2]).toBe('example.com:/etc/hosts');
    expect(args[args.length - 1]).toBe('/tmp/hosts');
  });

  /**
   * Прежде здесь стоял потолок в 300 секунд, и переопределить его было нечем:
   * каталог на гигабайты или медленный канал обрывались на 301-й секунде,
   * а вызывающий не мог попросить больше. От зависшего канала это не защищало:
   * молчание рвёт сам ssh за ~минуту силами ServerAliveInterval (замерено).
   */
  it('does not cap a transfer the caller did not limit', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().upload('/tmp/huge', '/srv/huge');

    expect((runProcessMock.mock.calls[0][0] as ProcessRunOptions).timeoutMs).toBeUndefined();
  });

  it('passes the caller timeout to the process', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().upload('/tmp/a', '/tmp/b', { timeoutMs: 7000 });

    expect((runProcessMock.mock.calls[0][0] as ProcessRunOptions).timeoutMs).toBe(7000);
  });

  it('names the caller timeout in the error, not a hidden default', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null }));

    await expect(
      makeRunner().upload('/tmp/a', '/tmp/b', { timeoutMs: 7000 })
    ).rejects.toThrow(/timed out after 7000ms/);
  });
});

/**
 * Сервер без подсистемы sftp: современный scp обрывается, классический
 * протокол работает. Замерено на dropbear-узле лаборатории — команды по тому
 * же соединению при этом ходят исправно, ломается только передача.
 */
describe('OpenSshRunner transfers to a server without sftp', () => {
  /** Отказ, каким его отдаёт scp на таком сервере */
  const noSftp = () =>
    ok({
      exitCode: 255,
      stderr: 'sh: /usr/lib/ssh/sftp-server: not found\nscp: Connection closed\r\n',
    });

  /** Есть ли флаг классического протокола в n-м запуске */
  const askedClassic = (index: number) => callArgs(index).includes('-O');

  it('retries an upload with the classic protocol', async () => {
    runProcessMock.mockResolvedValueOnce(noSftp()).mockResolvedValueOnce(ok());

    await expect(makeRunner().upload('/tmp/a', '/tmp/b')).resolves.toBeUndefined();

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(askedClassic(0)).toBe(false);
    expect(askedClassic(1)).toBe(true);
  });

  it('retries a download with the classic protocol', async () => {
    runProcessMock.mockResolvedValueOnce(noSftp()).mockResolvedValueOnce(ok());

    await expect(makeRunner().download('/etc/hosts', '/tmp/hosts')).resolves.toBeUndefined();

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(askedClassic(1)).toBe(true);
  });

  /** Путь на классическом пути читает shell сервера, значит экранируется */
  it('escapes the upload target once it falls back', async () => {
    runProcessMock.mockResolvedValueOnce(noSftp()).mockResolvedValueOnce(ok());

    await makeRunner().upload('/tmp/a', '/srv/my app.txt');

    const first = callArgs(0);
    const second = callArgs(1);
    expect(first[first.length - 1]).toBe('example.com:/srv/my app.txt');
    expect(second[second.length - 1]).toBe('example.com:/srv/my\\ app.txt');
  });

  it('remembers the destination and skips the failing attempt next time', async () => {
    runProcessMock.mockResolvedValueOnce(noSftp()).mockResolvedValue(ok());
    const runner = makeRunner();

    await runner.upload('/tmp/a', '/tmp/b');
    runProcessMock.mockClear();
    await runner.upload('/tmp/c', '/tmp/d');

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(askedClassic(0)).toBe(true);
  });

  /**
   * Откат либо чинит, либо ничего не меняет: вторая неудача возвращает
   * вызывающему первую ошибку, а не жалобу классического протокола.
   */
  it('reports the original failure when the classic protocol fails too', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ exitCode: 1, stderr: 'scp: /etc/x: Permission denied' }))
      .mockResolvedValueOnce(ok({ exitCode: 1, stderr: 'scp: unrelated classic complaint' }));

    await expect(makeRunner().upload('/tmp/a', '/etc/x')).rejects.toThrow(/Permission denied/);
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });

  it('does not remember the destination when the retry failed', async () => {
    runProcessMock.mockResolvedValue(ok({ exitCode: 1, stderr: 'scp: /etc/x: Permission denied' }));
    const runner = makeRunner();

    await expect(runner.upload('/tmp/a', '/etc/x')).rejects.toThrow();
    runProcessMock.mockClear();
    await expect(runner.upload('/tmp/a', '/etc/x')).rejects.toThrow();

    expect(askedClassic(0)).toBe(false);
  });

  it('does not retry after a timeout', async () => {
    runProcessMock.mockResolvedValue(ok({ timedOut: true, exitCode: null }));

    await expect(
      makeRunner().upload('/tmp/a', '/tmp/b', { timeoutMs: 7000 })
    ).rejects.toThrow(SSHTimeoutError);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry after a cancellation', async () => {
    runProcessMock.mockResolvedValue(ok({ aborted: true, exitCode: null }));

    await expect(makeRunner().upload('/tmp/a', '/tmp/b')).rejects.toThrow(SSHCancelledError);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  /** До 9.0 передача и так идёт классическим протоколом — повторять нечем */
  it('does not retry on a client that only speaks the classic protocol', async () => {
    runProcessMock.mockResolvedValue(noSftp());
    const classicClient: SshRuntime = { ...RUNTIME, scpOverSftp: false };

    await expect(makeRunner(CONFIG, classicClient).upload('/tmp/a', '/tmp/b')).rejects.toThrow();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a transfer that succeeded', async () => {
    runProcessMock.mockResolvedValue(ok());

    await makeRunner().upload('/tmp/a', '/tmp/b');

    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Недоступный сервер и отказавшая передача — разные ответы: по первому
   * вызывающий повторяет операцию, по второму разбирается с путём и правами.
   */
  it('keeps a transport failure distinguishable from a failed transfer', async () => {
    runProcessMock.mockResolvedValue(
      ok({ exitCode: 255, stderr: 'ssh: connect to host example.com port 22: Connection refused' })
    );

    await expect(makeRunner().upload('/tmp/a', '/tmp/b')).rejects.toThrow(SSHTransportError);
  });

  /** Отказ и повтор другим протоколом — одна передача, а не две */
  it('counts a fallback as a single transfer', async () => {
    runProcessMock.mockResolvedValueOnce(noSftp()).mockResolvedValue(ok());
    const runner = makeRunner();

    await runner.upload('/tmp/a', '/tmp/b');

    expect((await runner.stats()).transfersThisSession).toBe(1);
  });
});

describe('runner cache', () => {
  it('treats two profile names pointing at the same destination as one connection', () => {
    const production: RunnerConfig = { ...CONFIG };
    const alias: RunnerConfig = { ...CONFIG };
    expect(runnerKey(production)).toBe(runnerKey(alias));
  });

  it('separates different ports on the same host', () => {
    expect(runnerKey(CONFIG)).not.toBe(runnerKey({ ...CONFIG, port: 2222 }));
  });

  it('changes the fingerprint when credentials change', () => {
    const rotated: RunnerConfig = { ...CONFIG, privateKeyPath: '/home/user/.ssh/new_key' };
    expect(configFingerprint(CONFIG)).not.toBe(configFingerprint(rotated));
  });

  it('keeps the fingerprint stable for the same credentials', () => {
    expect(configFingerprint(CONFIG)).toBe(configFingerprint({ ...CONFIG }));
  });

  it('reuses the same runner for the same destination', async () => {
    const first = await getOpenSshRunner(CONFIG);
    const second = await getOpenSshRunner({ ...CONFIG });
    expect(second).toBe(first);
  });

  it('replaces the runner and closes the old connection when credentials change', async () => {
    runProcessMock.mockResolvedValue(ok());

    const first = await getOpenSshRunner(CONFIG);
    const second = await getOpenSshRunner({ ...CONFIG, privateKeyPath: '/home/user/.ssh/new_key' });

    expect(second).not.toBe(first);
    // Старое соединение погашено явно: иначе оно продолжило бы ходить со старым ключом
    const controlExit = runProcessMock.mock.calls.some(([options]) =>
      (options as ProcessRunOptions).args.includes('exit')
    );
    expect(controlExit).toBe(true);
  });
});

/**
 * Общий контракт транспорта.
 *
 * Часть проверок дублирует тесты выше — это цена того, что обещание
 * инструментам записано отдельным текстом и переживёт смену способа доставки.
 */
const contractScenarios: ProcessRunOutcome[] = [];
let contractAttempts = 0;

describeRunnerContract({
  name: 'openssh',
  backend: 'openssh',
  createRunner: () => makeRunner(),
  queue: (...scenarios) => {
    for (const scenario of scenarios) {
      if (scenario.kind === 'timeout') {
        contractScenarios.push(ok({ timedOut: true, exitCode: null }));
      } else if (scenario.kind === 'cancelled') {
        contractScenarios.push(ok({ aborted: true, exitCode: null }));
      } else if (scenario.kind === 'transport-error') {
        contractScenarios.push(
          ok({
            exitCode: SSH_FAILURE_EXIT_CODE,
            stderr: 'ssh: connect to host example.com port 22: Connection refused',
          })
        );
      } else {
        contractScenarios.push(
          ok({
            stdout: scenario.stdout ?? '',
            stderr: scenario.stderr ?? '',
            exitCode: scenario.exitCode ?? 0,
          })
        );
      }
    }
  },
  attempts: () => contractAttempts,
  reset: () => {
    contractScenarios.length = 0;
    contractAttempts = 0;
    runProcessMock.mockReset();
    runProcessMock.mockImplementation(async (options: ProcessRunOptions) => {
      // Служебные вызовы `ssh -O check|exit` попыткой выполнения не считаются
      if (options.args.includes('-O')) return ok({ exitCode: 1 });

      contractAttempts++;
      return contractScenarios.shift() ?? ok();
    });
  },
});
