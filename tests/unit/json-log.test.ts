/**
 * Unit tests: разворачивание записей драйвера json-file
 *
 * Строка журнала контейнера — это запись вокруг текста, и наружу должен
 * выходить текст. Проверяется и обратное: строка, которую разобрать нечем,
 * возвращается целиком. Потерянная строка неотличима от ненаписанной, и это
 * дороже, чем показанная сырой.
 */

import { describe, it, expect } from 'vitest';
import { unwrapJsonLog, unwrapJsonLogLine } from '../../src/utils/json-log.js';

const record = (text: string, stream = 'stdout') =>
  JSON.stringify({ log: text, stream, time: '2026-08-24T10:34:16.835543924Z' });

describe('запись драйвера json-file', () => {
  it('наружу выходит текст контейнера, без обёртки', () => {
    expect(unwrapJsonLogLine(record('502 Bad Gateway\n'))).toBe('502 Bad Gateway');
  });

  it('перевод строки в конце снимается один раз', () => {
    expect(unwrapJsonLogLine(record('two\n\n'))).toBe('two\n');
  });

  it('возврат каретки перед переводом снимается вместе с ним', () => {
    expect(unwrapJsonLogLine(record('windows\r\n'))).toBe('windows');
  });

  /**
   * Снимается именно последний перевод строки, а не первый попавшийся:
   * многострочная запись иначе склеилась бы в одну строку.
   */
  it('перевод строки внутри записи остаётся на месте', () => {
    expect(unwrapJsonLogLine(record('stack:\n  at main\n'))).toBe('stack:\n  at main');
  });

  it('строка без перевода в конце остаётся как есть', () => {
    expect(unwrapJsonLogLine(record('partial'))).toBe('partial');
  });

  it('обрезанная запись возвращается целиком, а не теряется', () => {
    const broken = '{"log":"half of a rec';
    expect(unwrapJsonLogLine(broken)).toBe(broken);
  });

  it('запись без поля log возвращается целиком', () => {
    const other = JSON.stringify({ stream: 'stdout', time: 'now' });
    expect(unwrapJsonLogLine(other)).toBe(other);
  });

  it('поле log не строкой — запись не подменяется числом', () => {
    const odd = JSON.stringify({ log: 42, stream: 'stdout' });
    expect(unwrapJsonLogLine(odd)).toBe(odd);
  });

  it('обычная строка журнала не трогается', () => {
    expect(unwrapJsonLogLine('Aug 24 10:34 nginx: 502')).toBe('Aug 24 10:34 nginx: 502');
  });

  it('блок разворачивается построчно и число строк не меняется', () => {
    const block = [record('one\n'), 'plain line', record('three\n')].join('\n');

    expect(unwrapJsonLog(block).split('\n')).toEqual(['one', 'plain line', 'three']);
  });

  it('пустой блок остаётся пустым, а не превращается в строку', () => {
    expect(unwrapJsonLog('')).toBe('');
  });
});
