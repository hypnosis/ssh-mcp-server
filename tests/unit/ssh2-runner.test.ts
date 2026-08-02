/**
 * Unit tests for the ssh2-backed runner
 *
 * Пул соединений подменён: он остаётся прежним и здесь не проверяется.
 * Задача адаптера — привести старый транспорт к контракту CommandRunner:
 * честный код возврата вместо исключения, отдельный stderr, единая
 * политика повторов.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { describeRunnerContract, type RunnerScenario } from './runner-contract.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    getClient: vi.fn(),
    releaseClient: vi.fn(),
    getSftp: vi.fn(),
    closeClient: vi.fn(),
    isConnected: vi.fn(),
  },
}));

vi.mock('../../src/managers/connection-pool.js', () => ({
  ConnectionPool: { getInstance: () => poolMock },
}));

const { Ssh2Runner } = await import('../../src/runner/ssh2-runner.js');
const { SSHAuthError, SSHRunnerError } = await import('../../src/runner/errors.js');

const CONFIG: SSHConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

/**
 * Канал ssh2: события данных и close, плюс запись в stdin
 */
class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  closed = false;

  write(chunk: string | Buffer): boolean {
    this.written.push(chunk.toString());
    return true;
  }

  end(): void {
    this.closed = true;
  }

  close(): void {
    this.closed = true;
  }

  destroy(): void {
    this.closed = true;
  }

  signal(_name: string): void {
    this.closed = true;
  }
}

/** Очередь исходов и счётчик попыток, общие для контракта и частных тестов */
const scenarios: RunnerScenario[] = [];
let attemptCount = 0;
let lastChannel: FakeChannel | undefined;

function nextScenario(): RunnerScenario {
  return scenarios.shift() ?? { kind: 'success' };
}

function resetTransport(): void {
  scenarios.length = 0;
  attemptCount = 0;
  lastChannel = undefined;
  vi.clearAllMocks();
  poolMock.isConnected.mockReturnValue(false);
  poolMock.getClient.mockImplementation(async () => {
    attemptCount++;
    const scenario = nextScenario();

    if (scenario.kind === 'transport-error') {
      throw new Error('connect ECONNREFUSED 10.0.0.1:22');
    }

    return {
      exec(_command: string, callback: (err: Error | null, channel: FakeChannel) => void) {
        const channel = new FakeChannel();
        lastChannel = channel;
        callback(null, channel);

        // Канал молчит: сработает либо таймаут, либо отмена вызывающим
        if (scenario.kind === 'timeout' || scenario.kind === 'cancelled') return;

        setImmediate(() => {
          if (scenario.stdout) channel.emit('data', Buffer.from(scenario.stdout));
          if (scenario.stderr) channel.stderr.emit('data', Buffer.from(scenario.stderr));
          channel.emit('close', scenario.exitCode ?? 0);
        });
      },
    };
  });
}

describeRunnerContract({
  name: 'ssh2',
  backend: 'ssh2',
  createRunner: () => new Ssh2Runner(CONFIG, 'production'),
  queue: (...items: RunnerScenario[]) => scenarios.push(...items),
  attempts: () => attemptCount,
  reset: resetTransport,
});

describe('Ssh2Runner: специфика бэкенда', () => {
  beforeEach(() => {
    resetTransport();
  });

  it('передаёт stdin в канал и закрывает его', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    scenarios.push({ kind: 'success', stdout: 'done' });

    await runner.exec('sha256sum -c -', { stdin: 'hash  file\n' });

    expect(lastChannel?.written).toEqual(['hash  file\n']);
    expect(lastChannel?.closed).toBe(true);
  });

  it('обрезает вывод по лимиту и помечает результат', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    scenarios.push({ kind: 'success', stdout: 'x'.repeat(100) });

    const result = await runner.exec('cat /var/log/huge.log', { maxOutputBytes: 10 });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(10);
  });

  it('ошибку аутентификации не повторяет даже для идемпотентной команды', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    poolMock.getClient.mockImplementation(async () => {
      attemptCount++;
      throw new Error('Authentication failed for deploy@example.com. Check username, SSH key path');
    });

    await expect(runner.exec('cat /etc/hostname', { idempotent: true })).rejects.toBeInstanceOf(
      SSHAuthError
    );
    expect(attemptCount).toBe(1);
  });

  it('загружает файл через SFTP и возвращает канал пулу', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    const fastPut = vi.fn((_l: string, _r: string, _o: unknown, cb: (e: Error | null) => void) =>
      cb(null)
    );
    const end = vi.fn();
    poolMock.getSftp.mockResolvedValue({ fastPut, end });

    await runner.upload('/tmp/local.txt', '/srv/remote.txt');

    expect(fastPut).toHaveBeenCalledWith(
      '/tmp/local.txt',
      '/srv/remote.txt',
      expect.anything(),
      expect.any(Function)
    );
    expect(end).toHaveBeenCalled();
    expect(poolMock.releaseClient).toHaveBeenCalledWith('production');
  });

  it('скачивает файл через SFTP', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    const fastGet = vi.fn((_r: string, _l: string, _o: unknown, cb: (e: Error | null) => void) =>
      cb(null)
    );
    const end = vi.fn();
    poolMock.getSftp.mockResolvedValue({ fastGet, end });

    await runner.download('/srv/remote.txt', '/tmp/local.txt');

    expect(fastGet).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });

  it('отказывается от рекурсивной передачи с внятным объяснением', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');

    await expect(runner.upload('/tmp/dir', '/srv/dir', { recursive: true })).rejects.toThrow(
      /SSH_MCP_BACKEND=openssh/
    );
    expect(poolMock.getSftp).not.toHaveBeenCalled();
  });

  it('в статистике честно сообщает, что мультиплексирования нет', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    poolMock.isConnected.mockReturnValue(true);

    const stats = await runner.stats();

    expect(stats.backend).toBe('ssh2');
    expect(stats.multiplexing).toBe(false);
    expect(stats.multiplexingDisabledReason).toMatch(/ssh2/i);
    expect(stats.masterActive).toBe(true);
  });

  it('ping сообщает, было ли соединение живо до проверки', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    poolMock.isConnected.mockReturnValue(true);
    scenarios.push({ kind: 'success' });

    const result = await runner.ping();

    expect(result.ok).toBe(true);
    expect(result.masterWasActive).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ping не бросает, когда сервер недоступен', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    // Проба идемпотентна, поэтому транспортный сбой отрабатывается дважды
    scenarios.push({ kind: 'transport-error' }, { kind: 'transport-error' });

    const result = await runner.ping();

    expect(result.ok).toBe(false);
  });

  it('closeMaster закрывает соединение профиля в пуле', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');

    await runner.closeMaster();

    expect(poolMock.closeClient).toHaveBeenCalledWith('production');
  });

  it('сбой открытия канала подаётся как транспортная ошибка', async () => {
    const runner = new Ssh2Runner(CONFIG, 'production');
    poolMock.getClient.mockImplementation(async () => {
      attemptCount++;
      return {
        exec(_command: string, callback: (err: Error | null) => void) {
          callback(new Error('Channel open failure: administratively prohibited'));
        },
      };
    });

    await expect(runner.exec('true')).rejects.toBeInstanceOf(SSHRunnerError);
    expect(poolMock.releaseClient).toHaveBeenCalledWith('production');
  });
});
