/**
 * Разбор листинга `du -sh`.
 *
 * Имя каталога с пробелом — не редкость на боевых машинах, и разрезанный по
 * каждому пробелу путь указывает на несуществующее место. Поэтому пара
 * «размер и путь» проверяется обоими элементами, а строка, которую разобрать
 * не вышло, обязана остаться видимой, а не исчезнуть.
 */

import { describe, it, expect } from 'vitest';
import { parseDuLines } from '../../src/utils/du-lines.js';

describe('parseDuLines', () => {
  it('разбирает размер и путь', () => {
    const { entries, unparsed } = parseDuLines('1.2G\t/var/lib/docker\n48M\t/var/log');

    expect(entries).toEqual([
      { size: '1.2G', path: '/var/lib/docker' },
      { size: '48M', path: '/var/log' },
    ]);
    expect(unparsed).toEqual([]);
  });

  it('сохраняет пробелы внутри пути', () => {
    const { entries } = parseDuLines('4.0K\t/home/user/My Documents');

    expect(entries).toEqual([{ size: '4.0K', path: '/home/user/My Documents' }]);
  });

  it('пропускает пустые строки', () => {
    const { entries, unparsed } = parseDuLines('\n\n12K\t/tmp\n\n');

    expect(entries).toEqual([{ size: '12K', path: '/tmp' }]);
    expect(unparsed).toEqual([]);
  });

  /** Замерено на обоих контейнерах: пустой файл du печатает без суффикса */
  it('берёт нулевой размер без суффикса', () => {
    const { entries, unparsed } = parseDuLines('0\t/tmp/empty-file');

    expect(entries).toEqual([{ size: '0', path: '/tmp/empty-file' }]);
    expect(unparsed).toEqual([]);
  });

  it('не тащит разделитель в начало пути', () => {
    const { entries } = parseDuLines('12K \t  /tmp/spaced');

    expect(entries).toEqual([{ size: '12K', path: '/tmp/spaced' }]);
  });

  it('не оставляет возврат каретки в конце пути', () => {
    const { entries } = parseDuLines('12K\t/tmp/crlf\r');

    expect(entries).toEqual([{ size: '12K', path: '/tmp/crlf' }]);
  });

  it('оставляет неразобранное видимым', () => {
    const { entries, unparsed } = parseDuLines('du: cannot access\n12K\t/tmp');

    expect(entries).toEqual([{ size: '12K', path: '/tmp' }]);
    expect(unparsed).toEqual(['du: cannot access']);
  });
});
