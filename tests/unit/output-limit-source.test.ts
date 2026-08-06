/**
 * Unit tests: объявленный предел вывода и предел, который действует на самом деле.
 *
 * Величина жила двумя экземплярами — числом в транспорте и строкой «10 MiB» в
 * пометке. Расхождение не ловил никто: подняв буфер, пользователю продолжали бы
 * показывать прежнюю цифру, то есть объяснять обрезку тем, чего уже нет.
 *
 * Здесь метка выводится из числа, а число проверяется по поведению транспорта —
 * настоящим процессом, а не догадкой о нём.
 */

import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/runner/process.js';
import {
  byteLimitLabel,
  OUTPUT_LIMIT_BYTES,
  TRUNCATED_OUTPUT_NOTE,
  truncatedReadMessage,
} from '../../src/utils/output-notes.js';

/** Напечатать ровно столько байт отдельным процессом */
function printBytes(count: number) {
  return runProcess({
    file: process.execPath,
    args: ['-e', `process.stdout.write("x".repeat(${count}))`],
    timeoutMs: 30000,
  });
}

describe('метка объёма идёт за числом', () => {
  it.each([
    [10 * 1024 * 1024, '10 MiB'],
    [512, '512 B'],
    // Граница единицы: килобайт начинается ровно здесь, а не байтом позже
    [1024, '1 KiB'],
    [1536 * 1024, '1.5 MiB'],
    [2 * 1024 * 1024 * 1024, '2 GiB'],
    // Выше самой крупной единицы счёт продолжается в ней, а не уходит за список
    [5 * 1024 * 1024 * 1024 * 1024, '5120 GiB'],
  ])('%i байт читается как «%s»', (bytes, label) => {
    expect(byteLimitLabel(bytes)).toBe(label);
  });
});

describe('оба текста называют один и тот же предел', () => {
  const promised = byteLimitLabel(OUTPUT_LIMIT_BYTES);

  it('пометка об обрезке', () => {
    expect(TRUNCATED_OUTPUT_NOTE).toContain(`(${promised})`);
  });

  it('отказ прочитать слишком большой файл', () => {
    expect(truncatedReadMessage('/var/log/huge.log')).toContain(`(${promised})`);
  });
});

describe('транспорт обрезает там, где обещано', () => {
  it('вывод сверх предела обрезается ровно по нему', async () => {
    const result = await printBytes(OUTPUT_LIMIT_BYTES + 1);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(OUTPUT_LIMIT_BYTES);
  });

  it('вывод ровно в предел проходит целиком', async () => {
    const result = await printBytes(OUTPUT_LIMIT_BYTES);

    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBe(OUTPUT_LIMIT_BYTES);
  });
});
