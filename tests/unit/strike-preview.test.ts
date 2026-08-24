/**
 * Unit tests: поход на машину за списком целей
 *
 * Разбор ответа проверяется своим файлом; здесь — то, чего разбор не видит:
 * когда на машину не идут вовсе, и чем отвечают, если сходить не вышло.
 *
 * Мок отвечает злее сервера нарочно: оборванный ответ и отказ соединения —
 * это исходы, которые обязаны отличаться от «целей не найдено», иначе отказ
 * превратится в разрешение.
 */

import { describe, it, expect, vi } from 'vitest';
import { findBlindStrikes } from '../../src/utils/blind-target.js';
import { previewStrikes } from '../../src/managers/strike-preview.js';
import type { SSHExecutor } from '../../src/managers/ssh-executor.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const CONFIG = { host: 'example.com', username: 'deploy', port: 22 } as SSHConfig;

/** Исполнитель, отвечающий заданным образом */
const executorOf = (result: unknown) =>
  ({ execute: vi.fn().mockResolvedValue(result) } as unknown as SSHExecutor & { execute: ReturnType<typeof vi.fn> });

const answer = (stdout: string) => ({ stdout, stderr: '', exitCode: 0, truncated: false });

describe('когда на машину не идут', () => {
  it('ударов нет — вопроса нет', async () => {
    const executor = executorOf(answer(''));

    expect(await previewStrikes(executor, CONFIG, [])).toEqual([]);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('раскрывать нечего — на машину не идут, но исход называют', async () => {
    const executor = executorOf(answer(''));
    const previews = await previewStrikes(executor, CONFIG, findBlindStrikes('kill $PID'));

    expect(executor.execute).not.toHaveBeenCalled();
    expect(previews[0].unavailable).toContain('nothing to expand');
  });
});

describe('когда сходить не вышло', () => {
  const strikes = findBlindStrikes('kill $(pgrep -f app)');

  it('оборванный ответ — это не «целей нет»', async () => {
    const executor = executorOf({ stdout: '@@STRIKE 0\n280', stderr: '', exitCode: 0, truncated: true });
    const [preview] = await previewStrikes(executor, CONFIG, strikes);

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toContain('did not fit');
  });

  it('отказ соединения — это не «целей нет»', async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as SSHExecutor;

    const [preview] = await previewStrikes(executor, CONFIG, strikes);

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toContain('connection refused');
  });

  it('каждый удар получает свою причину, а не только первый', async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error('timed out')),
    } as unknown as SSHExecutor;

    const previews = await previewStrikes(
      executor,
      CONFIG,
      findBlindStrikes('kill $(pgrep -f a); pkill -f b')
    );

    expect(previews).toHaveLength(2);
    expect(previews.every((preview) => preview.unavailable !== undefined)).toBe(true);
  });
});

describe('чем идут на машину', () => {
  const strikes = findBlindStrikes('docker kill $(docker ps -q)');

  it('вопрос повторить безопасно — он ничего не меняет', async () => {
    const executor = executorOf(answer('@@CLK\n100'));
    await previewStrikes(executor, CONFIG, strikes);

    expect(executor.execute.mock.calls[0][2]).toMatchObject({ idempotent: true });
  });

  it('права передаются те же, с какими шёл бы удар', async () => {
    const executor = executorOf(answer('@@CLK\n100'));
    await previewStrikes(executor, CONFIG, strikes, { sudo: true });

    expect(executor.execute.mock.calls[0][2]).toMatchObject({ sudo: true });
  });

  it('ответ без целей остаётся ответом без целей', async () => {
    const executor = executorOf(answer('@@CLK\n100\n@@CONTAINERS docker\n@@STRIKE 0\n'));
    const [preview] = await previewStrikes(executor, CONFIG, strikes);

    expect(preview.targets).toEqual([]);
    expect(preview.unavailable).toBeUndefined();
  });
});
