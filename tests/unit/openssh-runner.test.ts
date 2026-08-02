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

beforeEach(() => {
  runProcessMock.mockReset();
  detectRuntimeMock.mockReset();
  detectRuntimeMock.mockResolvedValue(RUNTIME);
  resetRunnerCache();
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

describe('OpenSshRunner multiplexing', () => {
  it('falls back to a direct connection when the server refuses a multiplexed session', async () => {
    runProcessMock
      .mockResolvedValueOnce(
        ok({
          exitCode: SSH_FAILURE_EXIT_CODE,
          stderr: 'mux_client_request_session: session request failed',
        })
      )
      .mockResolvedValueOnce(ok({ stdout: 'recovered' }));

    const result = await makeRunner().exec('uptime', { remoteTimeout: false });

    expect(result.stdout).toBe('recovered');
    expect(hasControlMaster(0)).toBe(true);
    expect(hasControlMaster(1)).toBe(false);
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
});

describe('OpenSshRunner remote timeout guard', () => {
  it('wraps the command when the server has a timeout utility', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: 'yes\n' }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toBe("timeout 35 sh -c 'long-task'");
  });

  it('leaves the command alone when the server has no timeout utility', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: 'no\n' }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec('long-task', { timeoutMs: 30000 });

    expect(remoteCommand(1)).toBe('long-task');
  });

  it('quotes the command so shell metacharacters survive the wrapper', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok({ stdout: 'yes\n' }))
      .mockResolvedValueOnce(ok({ stdout: 'done' }));

    await makeRunner().exec("echo 'it works'", { timeoutMs: 10000 });

    expect(remoteCommand(1)).toBe(`timeout 15 sh -c 'echo '\\''it works'\\'''`);
  });

  it('probes the server only once', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: 'yes\n' }));
    const runner = makeRunner();

    await runner.exec('first', { timeoutMs: 5000 });
    await runner.exec('second', { timeoutMs: 5000 });

    // Проба + две команды
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

  it('masks the secret if it is echoed back in the output', async () => {
    runProcessMock.mockResolvedValue(ok({ stdout: 'password is hunter2' }));

    const result = await makeRunner(passwordConfig, runtime).exec('echo', { remoteTimeout: false });

    expect(result.stdout).toBe('password is ***');
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
 * Тот же контракт, что проходит бэкенд на ssh2.
 *
 * Часть проверок дублирует тесты выше — это цена того, что обещание
 * инструментам одно на оба транспорта и проверяется одним текстом.
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
