/**
 * Сколько файлов sha256OfFiles читает одновременно и в каком порядке отвечает.
 *
 * Живёт отдельным файлом, потому что подменяет `createReadStream` на весь
 * модуль: настоящее чтение проверяется в sha256.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { sha256OfBuffer } from '../../src/utils/sha256.js';

const tracker = vi.hoisted(() => ({ open: 0, peak: 0, reads: 0, broken: '' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    createReadStream: (path: string) => {
      tracker.open++;
      tracker.reads++;
      if (tracker.open > tracker.peak) tracker.peak = tracker.open;
      const stream = new EventEmitter();
      // Задержки разные, иначе файлы завершаются ровно в порядке запуска и
      // проверка порядка ничего не значит: сбитый порядок совпал бы с верным
      const delay = Number(/(\d+)/.exec(path)?.[1] ?? 0) % 2 ? 1 : 20;
      setTimeout(() => {
        tracker.open--;
        if (path === tracker.broken) {
          stream.emit('error', Object.assign(new Error('ENOENT: broken file'), { code: 'ENOENT' }));
          return;
        }
        stream.emit('data', Buffer.from(path));
        stream.emit('end');
      }, delay);
      return stream;
    },
  };
});

const { sha256OfFiles } = await import('../../src/utils/sha256.js');

const paths = (count: number) => Array.from({ length: count }, (_, i) => `/tmp/f${i}.bin`);

describe('sha256OfFiles читает дерево ограниченным числом читателей', () => {
  beforeEach(() => {
    tracker.open = 0;
    tracker.peak = 0;
    tracker.reads = 0;
    tracker.broken = '';
  });

  it('на дереве в сотни файлов открывает не больше шестнадцати разом', async () => {
    await sha256OfFiles(paths(300));

    expect(tracker.peak).toBe(16);
    expect(tracker.open).toBe(0);
  });

  it('возвращает хэши в порядке путей, а не в порядке готовности', async () => {
    const list = paths(40);

    const hashes = await sha256OfFiles(list);

    // Подменённое чтение отдаёт содержимым сам путь, поэтому ожидаемый ответ
    // считается независимо от проверяемой функции
    expect(hashes).toEqual(list.map((path) => sha256OfBuffer(Buffer.from(path))));
  });

  it('нечитаемый файл останавливает дерево, а не дочитывает его до конца', async () => {
    const list = paths(300);
    tracker.broken = list[20];

    await expect(sha256OfFiles(list)).rejects.toThrow(/ENOENT/);
    const readsAtFailure = tracker.reads;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Дочитывать нечего: вызывающий уже отказался от этого дерева
    expect(tracker.reads).toBe(readsAtFailure);
    expect(tracker.reads).toBeLessThan(list.length);
  });

  it('пустой список не заводит ни одного чтения', async () => {
    const hashes = await sha256OfFiles([]);

    expect(hashes).toEqual([]);
    expect(tracker.reads).toBe(0);
  });
});
