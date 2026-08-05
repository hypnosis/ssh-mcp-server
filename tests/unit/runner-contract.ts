/**
 * Контракт CommandRunner — обещание транспорта инструментам
 *
 * Ненулевой код команды — это результат, таймаут и отмена — исключения,
 * повтор бывает только у идемпотентных операций и только при сбое транспорта.
 * Набор общий: он переживёт появление второго способа доставки, если тот
 * когда-нибудь понадобится старым серверам.
 *
 * Файл не заканчивается на .test.ts намеренно: он не запускается сам,
 * его подключают тесты транспорта.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CommandRunner } from '../../src/runner/types.js';
import { SSHCancelledError, SSHTimeoutError, SSHTransportError } from '../../src/runner/errors.js';

/** Что транспорт сделает на очередной попытке */
export type RunnerScenario =
  | { kind: 'success'; stdout?: string; stderr?: string; exitCode?: number }
  | { kind: 'timeout' }
  /** Транспорт молчит, пока вызывающий не отменит операцию */
  | { kind: 'cancelled' }
  | { kind: 'transport-error' };

/**
 * Подменённый транспорт конкретного бэкенда.
 *
 * Тесты контракта не знают, спавнится ли процесс или открывается канал
 * библиотеки — они только программируют исходы и считают попытки.
 */
export interface RunnerHarness {
  /** Имя транспорта для заголовка describe */
  name: string;
  /** Ожидаемое значение stats().backend */
  backend: 'openssh';
  /** Свежий раннер с пустыми счётчиками */
  createRunner(): CommandRunner;
  /** Запрограммировать исходы попыток по порядку */
  queue(...scenarios: RunnerScenario[]): void;
  /** Сколько раз транспорт реально дёрнули */
  attempts(): number;
  /** Сбросить состояние между тестами */
  reset(): void;
}

/** Таймаут в контрактных тестах короткий: зависание имитируется по-настоящему */
const TEST_TIMEOUT_MS = 150;

/**
 * Опции, общие для всех вызовов контракта.
 * Удалённый сторож `timeout` выключен: он делает дополнительный вызов
 * транспорта и сбивал бы счётчик попыток.
 */
const BASE_OPTIONS = { timeoutMs: TEST_TIMEOUT_MS, remoteTimeout: false as const };

export function describeRunnerContract(harness: RunnerHarness): void {
  describe(`CommandRunner contract: ${harness.name}`, () => {
    let runner: CommandRunner;

    beforeEach(() => {
      harness.reset();
      runner = harness.createRunner();
    });

    it('возвращает stdout, stderr и код возврата раздельно', async () => {
      harness.queue({ kind: 'success', stdout: 'output', stderr: 'warning', exitCode: 0 });

      const result = await runner.exec('echo output', BASE_OPTIONS);

      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('warning');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('ненулевой код возврата — результат, а не исключение', async () => {
      harness.queue({ kind: 'success', stdout: '', stderr: 'no match', exitCode: 1 });

      const result = await runner.exec('grep missing file', BASE_OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('no match');
    });

    it('таймаут превращается в SSHTimeoutError', async () => {
      harness.queue({ kind: 'timeout' });

      await expect(runner.exec('sleep 100', BASE_OPTIONS)).rejects.toBeInstanceOf(SSHTimeoutError);
    });

    it('отмена превращается в SSHCancelledError', async () => {
      harness.queue({ kind: 'cancelled' });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await expect(
        runner.exec('sleep 100', { ...BASE_OPTIONS, timeoutMs: 5000, signal: controller.signal })
      ).rejects.toBeInstanceOf(SSHCancelledError);
    });

    it('по умолчанию транспортный сбой не повторяется', async () => {
      harness.queue({ kind: 'transport-error' }, { kind: 'success', stdout: 'late' });

      await expect(runner.exec('rm -rf /tmp/data', BASE_OPTIONS)).rejects.toBeInstanceOf(
        SSHTransportError
      );
      expect(harness.attempts()).toBe(1);
    });

    it('идемпотентная операция переживает один транспортный сбой', async () => {
      harness.queue({ kind: 'transport-error' }, { kind: 'success', stdout: 'ok' });

      const result = await runner.exec('cat /etc/hostname', { ...BASE_OPTIONS, idempotent: true });

      expect(result.stdout).toBe('ok');
      expect(harness.attempts()).toBe(2);
    });

    it('идемпотентная операция повторяется ровно один раз', async () => {
      harness.queue({ kind: 'transport-error' }, { kind: 'transport-error' }, { kind: 'success' });

      await expect(
        runner.exec('cat /etc/hostname', { ...BASE_OPTIONS, idempotent: true })
      ).rejects.toBeInstanceOf(SSHTransportError);
      expect(harness.attempts()).toBe(2);
    });

    it('таймаут не повторяется даже для идемпотентной операции', async () => {
      harness.queue({ kind: 'timeout' }, { kind: 'success', stdout: 'late' });

      await expect(
        runner.exec('cat /etc/hostname', { ...BASE_OPTIONS, idempotent: true })
      ).rejects.toBeInstanceOf(SSHTimeoutError);
      expect(harness.attempts()).toBe(1);
    });

    it('сообщает свой бэкенд и считает выполненные команды', async () => {
      harness.queue({ kind: 'success' }, { kind: 'success' });

      const before = await runner.stats();
      expect(before.backend).toBe(harness.backend);
      expect(before.commandsThisSession).toBe(0);

      await runner.exec('true', BASE_OPTIONS);
      await runner.exec('true', BASE_OPTIONS);

      const after = await runner.stats();
      expect(after.commandsThisSession).toBe(2);
    });
  });
}
