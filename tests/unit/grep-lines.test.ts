/**
 * Unit tests: разбор вывода grep в найденные строки.
 *
 * Совпадение и его сосед различаются одним знаком после номера, и спутать их
 * дороже всего: процитировав соседа как находку, вызывающий сошлётся на
 * строку, которая запросу не отвечает вовсе.
 */

import { describe, it, expect } from 'vitest';
import { parseGrepLines } from '../../src/utils/grep-lines.js';

describe('разбор вывода grep', () => {
  it('совпадение несёт номер, текст и имя файла', () => {
    const found = parseGrepLines('4821:connection refused', '/var/log/nginx/error.log');

    expect(found).toEqual([
      {
        file: '/var/log/nginx/error.log',
        line: 4821,
        text: 'connection refused',
        context: false,
      },
    ]);
  });

  it('сосед по контексту помечен, а совпадение — нет', () => {
    const found = parseGrepLines('10-before\n11:match\n12-after', '/var/log/syslog');

    expect(found.map((entry) => entry.context)).toEqual([true, false, true]);
  });

  it('номер строки приходит числом, а не строкой', () => {
    expect(parseGrepLines('7:text', '/log')[0].line).toBe(7);
  });

  it('разделитель групп контекста находкой не считается', () => {
    const found = parseGrepLines('10:first\n--\n90:second', '/log');

    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.line)).toEqual([10, 90]);
  });

  it('двоеточие внутри самой строки лога не рвёт текст', () => {
    const found = parseGrepLines('12:2026-08-20 10:47:03 ERROR db:timeout', '/log');

    expect(found[0].text).toBe('2026-08-20 10:47:03 ERROR db:timeout');
  });

  it('пустой вывод даёт пустой список, а не строку-призрак', () => {
    expect(parseGrepLines('', '/log')).toEqual([]);
  });

  it('строка без номера пропускается', () => {
    const found = parseGrepLines('grep: /log: Permission denied\n12:real', '/log');

    expect(found).toHaveLength(1);
    expect(found[0].text).toBe('real');
  });

  /** Оборванный буфер режет последнюю строку посередине — половина выдала бы себя за целую */
  it('при обрыве буфера последняя строка отбрасывается', () => {
    const found = parseGrepLines('10:whole\n11:half-of-a-li', '/log', { dropLast: true });

    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(10);
  });

  it('без обрыва последняя строка остаётся на месте', () => {
    expect(parseGrepLines('10:one\n11:two', '/log')).toHaveLength(2);
  });

  /**
   * Номер строки печатает grep, и печатает его в начале. Число с двоеточием
   * внутри самой записи журнала — это её текст, а не номер: приняв его за
   * номер, ответ сослался бы на строку, которой в файле нет.
   */
  it('число в середине строки за номер не принимается', () => {
    expect(parseGrepLines('took 45:03 to finish', '/log')).toEqual([]);
  });

  it('строка целиком уходит в текст, а не обрезается по последнему числу', () => {
    const found = parseGrepLines('12:retry after 45:03', '/log');

    expect(found[0].line).toBe(12);
    expect(found[0].text).toBe('retry after 45:03');
  });
});
