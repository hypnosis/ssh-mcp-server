/**
 * Unit tests for ssh failure classification
 *
 * Образцы stderr взяты из реальных сообщений OpenSSH.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySpawnOutcome,
  stripMuxNotices,
  SSH_FAILURE_EXIT_CODE,
} from '../../src/runner/error-classifier.js';
import {
  SSHAuthError,
  SSHBinaryMissingError,
  SSHChannelClosedError,
  SSHHostKeyError,
  SSHMuxLimitError,
  SSHTransportError,
  isRetryable,
} from '../../src/runner/errors.js';

const CONTEXT = { host: 'example.com', port: 22 };

/** Классифицировать сбой ssh с указанным stderr */
function classifyFailure(stderr: string) {
  return classifySpawnOutcome({ exitCode: SSH_FAILURE_EXIT_CODE, stderr }, CONTEXT);
}

describe('error-classifier', () => {
  describe('spawn failures', () => {
    it('reports a missing ssh binary with install instructions', () => {
      const error = classifySpawnOutcome(
        { spawnError: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }), exitCode: null, stderr: '' },
        CONTEXT
      );
      expect(error).toBeInstanceOf(SSHBinaryMissingError);
      expect(error?.message).toMatch(/not found in PATH/);
      expect(error?.message).toMatch(/openssh-client/);
    });

    it('treats other spawn errors as transport failures', () => {
      const error = classifySpawnOutcome(
        { spawnError: Object.assign(new Error('EACCES'), { code: 'EACCES' }), exitCode: null, stderr: '' },
        CONTEXT
      );
      expect(error).toBeInstanceOf(SSHTransportError);
    });
  });

  describe('remote command exit codes are not transport failures', () => {
    it('passes through a zero exit', () => {
      expect(classifySpawnOutcome({ exitCode: 0, stderr: '' }, CONTEXT)).toBeNull();
    });

    it('passes through grep-style exit 1', () => {
      expect(classifySpawnOutcome({ exitCode: 1, stderr: '' }, CONTEXT)).toBeNull();
    });

    it('passes through a command-not-found exit 127', () => {
      const outcome = { exitCode: 127, stderr: 'bash: frobnicate: command not found' };
      expect(classifySpawnOutcome(outcome, CONTEXT)).toBeNull();
    });

    it('passes through exit 255 produced by the remote command itself', () => {
      // Вывод не похож на диагностику ssh — значит это результат команды
      const outcome = { exitCode: 255, stderr: 'myapp: fatal: config missing' };
      expect(classifySpawnOutcome(outcome, CONTEXT)).toBeNull();
    });
  });

  describe('authentication failures', () => {
    it.each([
      'deploy@example.com: Permission denied (publickey).',
      'Permission denied, please try again.',
      'Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures',
      'deploy@example.com: Permission denied (publickey,password,keyboard-interactive).',
    ])('classifies %j as an auth failure', (stderr) => {
      expect(classifyFailure(stderr)).toBeInstanceOf(SSHAuthError);
    });

    it('is never retried, even for idempotent operations', () => {
      const error = classifyFailure('Permission denied (publickey).');
      expect(isRetryable(error, true)).toBe(false);
    });
  });

  describe('host key failures', () => {
    it.each([
      'Host key verification failed.',
      '@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@',
    ])('classifies %j as a host key failure', (stderr) => {
      expect(classifyFailure(stderr)).toBeInstanceOf(SSHHostKeyError);
    });

    it('suggests the exact command to clear a stale entry', () => {
      const error = classifyFailure('Host key verification failed.');
      expect(error?.message).toContain('ssh-keygen -R example.com');
    });

    it('takes precedence over the auth pattern when both appear', () => {
      const stderr = 'Host key verification failed.\nPermission denied (publickey).';
      expect(classifyFailure(stderr)).toBeInstanceOf(SSHHostKeyError);
    });

    it('is never retried', () => {
      expect(isRetryable(classifyFailure('Host key verification failed.'), true)).toBe(false);
    });
  });

  describe('transport failures', () => {
    it.each([
      'ssh: connect to host example.com port 22: Connection refused',
      'ssh: connect to host example.com port 22: Connection timed out',
      'ssh: Could not resolve hostname example.com: Name or service not known',
      'ssh: connect to host example.com port 22: No route to host',
      'ssh: connect to host example.com port 22: Network is unreachable',
      'kex_exchange_identification: read: Connection reset by peer',
      'client_loop: send disconnect: Broken pipe',
    ])('classifies %j as a transport failure', (stderr) => {
      expect(classifyFailure(stderr)).toBeInstanceOf(SSHTransportError);
    });

    it('is retried only when the caller marked the operation idempotent', () => {
      const error = classifyFailure('ssh: connect to host example.com port 22: Connection refused');
      expect(isRetryable(error, true)).toBe(true);
      expect(isRetryable(error, false)).toBe(false);
    });

    it('hints at a rate limiter when the server drops an established connection', () => {
      const error = classifyFailure('Connection closed by 1.2.3.4 port 22');
      expect(error).toBeInstanceOf(SSHTransportError);
      expect(error?.message).toMatch(/fail2ban/);
    });

    it('does not mention a rate limiter for a plain refusal', () => {
      const error = classifyFailure('ssh: connect to host example.com port 22: Connection refused');
      expect(error?.message).not.toMatch(/fail2ban/);
    });
  });

  describe('multiplexing limits', () => {
    it('recognises a refused multiplexed session', () => {
      const error = classifyFailure('mux_client_request_session: session request failed: Session open refused by peer');
      expect(error).toBeInstanceOf(SSHMuxLimitError);
    });

    // Отдельное соединение вместо отказанной сессии клиент открывает сам, так
    // что до кода 255 доходит только вместе с отказом самого соединения — и
    // назвать причиной лимит сессий значило бы подменить диагноз
    it('names the dropped connection, not the session limit, when both are in the output', () => {
      const error = classifyFailure(
        'mux_client_request_session: session request failed: Session open refused by peer\n' +
        'Connection closed by 1.2.3.4 port 22'
      );

      expect(error).toBeInstanceOf(SSHTransportError);
      expect(error?.message).toMatch(/fail2ban/);
    });

    it('is not retried by the generic policy', () => {
      const error = classifyFailure('mux_client_request_session: session request failed');
      expect(isRetryable(error, true)).toBe(false);
    });
  });

  describe('stripMuxNotices', () => {
    it('drops the notices the client prints about its own control connection', () => {
      const cleaned = stripMuxNotices(
        'mux_client_request_session: session request failed: Session open refused by peer\r\n' +
        'ControlSocket /tmp/ctl/s-abc already exists, disabling multiplexing\r\n'
      );

      expect(cleaned.trim()).toBe('');
    });

    it('keeps the output of the command itself, in order', () => {
      const cleaned = stripMuxNotices(
        'first line\nmux_client_request_session: session request failed\nsecond line\n'
      );

      expect(cleaned).toBe('first line\nsecond line\n');
    });

    it('leaves a line that only mentions multiplexing alone', () => {
      const text = 'grep: mux_client_request_session: no such file\n';

      expect(stripMuxNotices(text)).toBe(text);
    });
  });

  describe('unrecognised ssh diagnostics', () => {
    it('treats ssh-prefixed output as a transport failure', () => {
      const error = classifyFailure('ssh: something entirely new went wrong');
      expect(error).toBeInstanceOf(SSHTransportError);
    });

    it('preserves the raw stderr for diagnosis', () => {
      const error = classifyFailure('ssh: something entirely new went wrong');
      expect(error?.stderr).toBe('ssh: something entirely new went wrong');
      expect(error?.exitCode).toBe(SSH_FAILURE_EXIT_CODE);
    });

    it('reports an empty diagnostic rather than an empty message', () => {
      const error = classifySpawnOutcome(
        { exitCode: SSH_FAILURE_EXIT_CODE, stderr: 'ssh: ' },
        CONTEXT
      );
      expect(error?.message).toMatch(/example\.com:22/);
    });
  });

  /**
   * Так отвечает dropbear на залп коротких команд по общему соединению: код 255,
   * ни знака вывода, ни строки диагностики. Снимок печатал это как «0 ядер».
   */
  describe('оборванный канал без единого знака вывода', () => {
    const CLOSED = { exitCode: SSH_FAILURE_EXIT_CODE, stderr: '', stdout: '' };

    it('у идемпотентной команды это транспортный сбой', () => {
      const error = classifySpawnOutcome(CLOSED, { ...CONTEXT, idempotent: true });
      expect(error).toBeInstanceOf(SSHChannelClosedError);
      expect(error?.message).toMatch(/closed before the command produced output/);
    });

    it('такой сбой повторяется, потому что он транспортный', () => {
      const error = classifySpawnOutcome(CLOSED, { ...CONTEXT, idempotent: true });
      expect(isRetryable(error, true)).toBe(true);
    });

    it('без пометки об идемпотентности остаётся обычным результатом', () => {
      expect(classifySpawnOutcome(CLOSED, CONTEXT)).toBeNull();
      expect(classifySpawnOutcome(CLOSED, { ...CONTEXT, idempotent: false })).toBeNull();
    });

    it('команда, напечатавшая хоть что-то, обрывом не считается', () => {
      const withStdout = { ...CLOSED, stdout: 'before' };
      const withStderr = { ...CLOSED, stderr: 'nope' };
      expect(classifySpawnOutcome(withStdout, { ...CONTEXT, idempotent: true })).toBeNull();
      expect(classifySpawnOutcome(withStderr, { ...CONTEXT, idempotent: true })).toBeNull();
    });

    it('пробелы выводом не считаются', () => {
      const error = classifySpawnOutcome(
        { exitCode: SSH_FAILURE_EXIT_CODE, stderr: ' \n', stdout: '  ' },
        { ...CONTEXT, idempotent: true }
      );
      expect(error).toBeInstanceOf(SSHChannelClosedError);
    });

    it('другой код возврата обрывом не считается', () => {
      const error = classifySpawnOutcome(
        { exitCode: 1, stderr: '', stdout: '' },
        { ...CONTEXT, idempotent: true }
      );
      expect(error).toBeNull();
    });
  });
});
