/**
 * Паспорт и шлюз первой команды не должны ждать друг друга
 *
 * Залп параллельных чтений по холодному профилю — это снимок системы: одно из
 * его чтений идёт с sudo, а значит первым делом спрашивает паспорт сервера.
 * Остальные в это время уже закрыли шлюз первой команды и внутри себя ждут тот
 * же паспорт. Если проба паспорта идёт на сервер через шлюз, круг замыкается:
 * шлюз ждёт паспорт, паспорт ждёт шлюз, и ни одна команда не доходит до ssh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProcessRunOptions, ProcessRunOutcome } from '../../src/runner/process.js';
import type { SshRuntime } from '../../src/runner/runtime-check.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }));
vi.mock('../../src/runner/process.js', () => ({ runProcess: runProcessMock }));

const { detectRuntimeMock } = vi.hoisted(() => ({ detectRuntimeMock: vi.fn() }));
vi.mock('../../src/runner/runtime-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/runtime-check.js')>();
  return { ...actual, detectRuntime: detectRuntimeMock };
});

const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { resetRunnerCache } = await import('../../src/runner/openssh-runner.js');
const { resetPassportCache } = await import('../../src/runner/passport.js');

const CONFIG: SSHConfig = {
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

const PASSPORT_LINE =
  'SSH_MCP_PASSPORT bash=1 sha256=sha256sum coreutils=coreutils rsync=1 timeout=1 install=1 os=Linux home=/root';

/**
 * Мок злее сервера: ответ приходит не в том же тике, иначе параллельные вызовы
 * успевают выстроиться в очередь и взаимная блокировка не воспроизводится.
 */
function respondAfterTick(outcome: Partial<ProcessRunOutcome>): Promise<ProcessRunOutcome> {
  return new Promise((resolve) =>
    setTimeout(() =>
      resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        signalCode: null,
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 1,
        ...outcome,
      }), 1)
  );
}

/** Сколько успело ответить к сроку: незавершённый залп — это зависание */
async function raceWave<T>(wave: Promise<T[]>, limitMs: number): Promise<T[] | 'зависло'> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<'зависло'>((resolve) => {
    timer = setTimeout(() => resolve('зависло'), limitMs);
  });
  const outcome = await Promise.race([wave, deadline]);
  clearTimeout(timer!);
  return outcome;
}

beforeEach(() => {
  detectRuntimeMock.mockResolvedValue(RUNTIME);
  runProcessMock.mockClear();
  runProcessMock.mockImplementation((options: ProcessRunOptions) => {
    const command = options.args.join(' ');
    return respondAfterTick({ stdout: command.includes('SSH_MCP_PASSPORT') ? PASSPORT_LINE : 'ok' });
  });
  resetRunnerCache();
  resetPassportCache();
});

describe('залп чтений по холодному профилю', () => {
  it('проходит целиком, когда среди чтений есть команда с sudo', async () => {
    const executor = new SSHExecutor();

    const wave = Promise.all([
      ...Array.from({ length: 9 }, (_, index) =>
        executor.execute(CONFIG, `echo ${index}`, { idempotent: true })
      ),
      executor.execute(CONFIG, 'tail -n 100 /var/log/syslog', { sudo: true, idempotent: true }),
    ]);

    const results = await raceWave(wave, 2000);

    expect(results).not.toBe('зависло');
    expect(results).toHaveLength(10);
  });

  it('спрашивает паспорт сервера один раз на все чтения залпа', async () => {
    const executor = new SSHExecutor();

    await Promise.all([
      ...Array.from({ length: 9 }, (_, index) =>
        executor.execute(CONFIG, `echo ${index}`, { idempotent: true })
      ),
      executor.execute(CONFIG, 'tail -n 100 /var/log/syslog', { sudo: true, idempotent: true }),
    ]);

    const probes = runProcessMock.mock.calls.filter(([options]: [ProcessRunOptions]) =>
      options.args.join(' ').includes('SSH_MCP_PASSPORT')
    );

    expect(probes).toHaveLength(1);
  });
});
