/**
 * Unit tests: как вывод команды укладывается в поле ответа.
 *
 * Опасностей здесь две, и обе про честность. Обрезанный кусок не должен
 * выглядеть целым выводом — иначе решение принимается по половине данных.
 * И обрезка не должна выглядеть порчей: разрезанный посередине символ даёт
 * знак замены, а он в этом сервере означает потерянные байты.
 */

import { describe, it, expect } from 'vitest';
import { clipForField, FIELD_LIMIT_BYTES } from '../../src/utils/clip-output.js';

/** Строка заданной длины в байтах, из однобайтовых знаков */
function ascii(bytes: number, fill = 'a'): string {
  return fill.repeat(bytes);
}

describe('укладка вывода в поле', () => {
  it('короткий вывод едет целиком и без пометки', () => {
    const result = clipForField('total 4\ndrwxr-xr-x 2 root root');

    expect(result.text).toBe('total 4\ndrwxr-xr-x 2 root root');
    expect(result.clippedBytes).toBe(0);
  });

  it('вывод ровно по пределу не режется', () => {
    const result = clipForField(ascii(FIELD_LIMIT_BYTES));

    expect(result.clippedBytes).toBe(0);
    expect(result.text.length).toBe(FIELD_LIMIT_BYTES);
  });

  it('вывод на байт длиннее предела уже режется', () => {
    const result = clipForField(ascii(FIELD_LIMIT_BYTES + 1));

    expect(result.clippedBytes).toBeGreaterThan(0);
  });

  it('от длинного вывода остаются оба конца', () => {
    const text = `НАЧАЛО\n${ascii(2000)}\nКОНЕЦ`;
    const result = clipForField(text, { limit: 200 });

    expect(result.text.startsWith('НАЧАЛО')).toBe(true);
    expect(result.text.endsWith('КОНЕЦ')).toBe(true);
  });

  it('шов называет, сколько байт вырезано', () => {
    const result = clipForField(ascii(5000), { limit: 1000 });

    expect(result.text).toContain('── clipped');
    expect(result.clippedBytes).toBe(5000 - 1000);
  });

  it('вырезанное плюс оставшееся дают исходный размер', () => {
    const text = ascii(10_000);
    const result = clipForField(text, { limit: 4096 });
    const keptBytes = Buffer.byteLength(result.text.replace(/\n── clipped .*? ──\n/, ''), 'utf8');

    expect(keptBytes + result.clippedBytes).toBe(10_000);
  });

  it('обрезка не рвёт многобайтовый символ пополам', () => {
    // Предел нечётный относительно двухбайтовой кириллицы: половина среза
    // приходится ровно на середину буквы
    const result = clipForField('я'.repeat(1000), { limit: 101 });

    expect(result.text).not.toContain('�');
  });

  /**
   * Голова отступает назад, хвост — вперёд, и проверяется это только точным
   * размером: съеденный лишний знак порчи не даёт, поэтому «нет знака замены»
   * такую ошибку пропускает.
   */
  it('голова отступает назад ровно до границы знака', () => {
    // Половина предела — 51 байт, то есть середина двадцать шестой буквы
    const result = clipForField('я'.repeat(1000), { limit: 103 });
    const head = result.text.slice(0, result.text.indexOf('\n'));

    expect(head).toBe('я'.repeat(25));
  });

  it('хвост сдвигается вперёд ровно до границы знака', () => {
    // Хвост — 51 байт от конца, то есть с середины буквы; целых знаков там 25
    const result = clipForField('я'.repeat(1000), { limit: 101 });

    expect(result.text.endsWith('я'.repeat(25))).toBe(true);
    expect(result.clippedBytes).toBe(1900);
  });

  it('без права на хвост остаётся только начало', () => {
    const text = `НАЧАЛО\n${ascii(2000)}\nКОНЕЦ`;
    const result = clipForField(text, { limit: 200, keepTail: false });

    expect(result.text.startsWith('НАЧАЛО')).toBe(true);
    expect(result.text).not.toContain('КОНЕЦ');
    expect(result.text).toContain('── clipped');
  });

  it('без права на хвост вырезанное считается от конца головы', () => {
    const result = clipForField(ascii(5000), { limit: 1000, keepTail: false });

    expect(result.clippedBytes).toBe(4000);
  });
});
