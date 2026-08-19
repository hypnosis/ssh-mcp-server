/**
 * Unit tests: путь, вынутый из жалобы инструмента.
 *
 * Жалоба — единственное, что отличает «закрыто правами» от «ничего нет», и
 * разбирается она двумя якорями: жалоба начинается с имени инструмента, а имя
 * в кавычках закавычено целиком. Без первого якоря кусок чужого текста
 * становится путём, без второго — обрывок строки становится именем.
 */

import { describe, it, expect } from 'vitest';
import { unreadablePath } from '../../src/utils/output-notes.js';

describe('разбор жалобы инструмента', () => {
  it('обычная жалоба отдаёт путь, а не свои слова', () => {
    expect(unreadablePath('grep: /var/log/secure: Permission denied')).toBe('/var/log/secure');
  });

  it('путь в кавычках достаётся из слов вокруг него', () => {
    expect(unreadablePath("du: can't open '/root': Permission denied")).toBe('/root');
  });

  /**
   * Строка журнала начинается временем, а не именем инструмента: разбирать её
   * значит выдать кусок чужого текста за имя файла.
   */
  it('строка, которая не начинается жалобой, путём не становится', () => {
    const line = 'Aug 19 10:00:00 host grep: /var/log/secure: Permission denied';

    expect(unreadablePath(line)).toBe(line);
  });

  /** Кавычки закрывают часть текста, а не имя — имени здесь нет вовсе */
  it('обрывок в кавычках посреди строки именем не становится', () => {
    expect(unreadablePath("du: 'cache' not readable: skipped")).toBe("'cache' not readable");
  });
});
