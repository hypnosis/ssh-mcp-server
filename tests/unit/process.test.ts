/**
 * Unit tests for child process execution
 *
 * Тесты запускают настоящие процессы (node), а не моки: проверять надо
 * реальное поведение сигналов и потоков, а не собственные догадки о нём.
 */

import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/runner/process.js';

/** Запустить фрагмент JS отдельным процессом node */
function nodeScript(script: string, overrides = {}) {
  return runProcess({ file: process.execPath, args: ['-e', script], ...overrides });
}

describe('runProcess', () => {
  describe('normal completion', () => {
    it('captures stdout', async () => {
      const result = await nodeScript('process.stdout.write("hello")');
      expect(result.stdout).toBe('hello');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    });

    it('keeps stderr separate from stdout', async () => {
      const result = await nodeScript('process.stdout.write("out"); process.stderr.write("err")');
      expect(result.stdout).toBe('out');
      expect(result.stderr).toBe('err');
    });

    it('reports a non-zero exit code without treating it as a failure', async () => {
      const result = await nodeScript('process.exit(3)');
      expect(result.exitCode).toBe(3);
      expect(result.spawnError).toBeUndefined();
    });

    it('measures duration', async () => {
      const result = await nodeScript('process.stdout.write("x")');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('timeout', () => {
    it('terminates a hanging process instead of just giving up on it', async () => {
      const result = await nodeScript('setTimeout(() => {}, 60000)', { timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signalCode).toBe('SIGTERM');
    });

    it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
      const stubborn = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
      const result = await nodeScript(stubborn, { timeoutMs: 200, killGraceMs: 300 });
      expect(result.timedOut).toBe(true);
      expect(result.signalCode).toBe('SIGKILL');
    });

    it('keeps output produced before the timeout', async () => {
      const script = 'process.stdout.write("partial"); setTimeout(() => {}, 60000)';
      const result = await nodeScript(script, { timeoutMs: 300 });
      expect(result.stdout).toBe('partial');
      expect(result.timedOut).toBe(true);
    });

    it('does not fire for a process that finishes in time', async () => {
      const result = await nodeScript('process.stdout.write("fast")', { timeoutMs: 5000 });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('cancellation', () => {
    it('terminates the process when the signal fires', async () => {
      const controller = new AbortController();
      const promise = nodeScript('setTimeout(() => {}, 60000)', { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const result = await promise;
      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.signalCode).toBe('SIGTERM');
    });

    it('does not start a process when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await nodeScript('process.stdout.write("should not run")', {
        signal: controller.signal,
      });
      expect(result.aborted).toBe(true);
      expect(result.stdout).toBe('');
    });
  });

  describe('stdin', () => {
    it('passes input through', async () => {
      const result = await nodeScript('process.stdin.pipe(process.stdout)', { stdin: 'piped input' });
      expect(result.stdout).toBe('piped input');
    });

    it('closes stdin by default so a reading command cannot hang', async () => {
      const result = await nodeScript('process.stdin.pipe(process.stdout)', { timeoutMs: 3000 });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('accepts a Buffer', async () => {
      const result = await nodeScript('process.stdin.pipe(process.stdout)', {
        stdin: Buffer.from('buffered'),
      });
      expect(result.stdout).toBe('buffered');
    });
  });

  describe('spawn failures', () => {
    it('reports a missing binary instead of throwing', async () => {
      const result = await runProcess({ file: 'definitely-not-a-real-binary-xyz', args: [] });
      expect(result.spawnError?.code).toBe('ENOENT');
      expect(result.exitCode).toBeNull();
    });
  });

  describe('output limit', () => {
    it('truncates output beyond the limit', async () => {
      const result = await nodeScript('process.stdout.write("x".repeat(1000))', {
        maxOutputBytes: 100,
      });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBe(100);
    });

    it('lets the process finish rather than blocking it on a full buffer', async () => {
      const script = 'process.stdout.write("y".repeat(200000)); process.exit(0)';
      const result = await nodeScript(script, { maxOutputBytes: 1000, timeoutMs: 5000 });
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('does not flag truncation when output fits', async () => {
      const result = await nodeScript('process.stdout.write("small")', { maxOutputBytes: 1000 });
      expect(result.truncated).toBe(false);
    });

    /**
     * Обрезка внутри второй порции: остаток буфера считается от уже накопленного,
     * а не от пустого. Один-единственный кусок вывода этого не показывает —
     * при пустом буфере остаток равен всему лимиту.
     */
    it('counts the remaining room against what is already buffered', async () => {
      const script =
        'process.stdout.write("a".repeat(60));' +
        'setTimeout(() => process.stdout.write("b".repeat(60)), 50)';
      const result = await nodeScript(script, { maxOutputBytes: 100, timeoutMs: 5000 });

      expect(result.stdout).toBe('a'.repeat(60) + 'b'.repeat(40));
      expect(result.truncated).toBe(true);
    });
  });

  describe('encoding', () => {
    it('does not split multi-byte characters across chunk boundaries', async () => {
      const script = 'process.stdout.write("Проверка кодировки. ".repeat(5000))';
      const result = await nodeScript(script);
      expect(result.stdout).not.toContain('�');
      expect(result.stdout.startsWith('Проверка кодировки. ')).toBe(true);
      expect(result.stdout.endsWith('Проверка кодировки. ')).toBe(true);
    });
  });

  describe('environment', () => {
    it('passes the provided environment to the child', async () => {
      const result = await nodeScript('process.stdout.write(process.env.SSH_MCP_TEST_VAR || "unset")', {
        env: { ...process.env, SSH_MCP_TEST_VAR: 'provided' },
      });
      expect(result.stdout).toBe('provided');
    });
  });
});
