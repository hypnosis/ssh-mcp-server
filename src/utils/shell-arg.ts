/**
 * Значения параметров инструментов, попадающие в строку команды.
 *
 * Путь и любое другое значение, которое не обязано ничего раскрывать, идёт
 * через `shellQuote` — там вопрос закрыт кавычками. Здесь живут четыре случая,
 * где кавычек мало или где они запрещены по смыслу:
 *
 * - число (`lines`, `context`, `top_n`) — тип из схемы ничего не гарантирует:
 *   MCP проверяет конверт запроса, а `arguments` отдаёт как есть;
 * - права и владелец — уезжают в `chmod` и `install` отдельными словами;
 * - шаблон имени (`pattern`) — обязан раскрыться на сервере, поэтому закавычить
 *   его нельзя; спасает экранирование обратным слэшем.
 *
 * Плохое значение — отказ с текстом, а не тихая правка: молча урезанные права
 * или шаблон человек не заметит.
 */

/** Что уцелеет в шаблоне: буквы и цифры любого языка, безобидная пунктуация, знаки шаблона */
const GLOB_KEEP = /[^\p{L}\p{N}._/*?[\]-]/gu;

function reject(name: string, value: unknown, expected: string): never {
  throw new Error(`${name} must be ${expected}, got ${JSON.stringify(String(value))}`);
}

/** Целое неотрицательное число: количество строк, размер выборки */
export function shellCount(value: unknown, name: string): number {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';

  if (!/^\d+$/.test(text)) reject(name, value, 'a whole number');

  return Number(text);
}

/**
 * Права: восьмеричные (`644`, `0755`) или символьные (`u+x`, `go-w,a+r`).
 *
 * Символьная запись пропускается наравне с восьмеричной: опасны не её буквы, а
 * то, что вокруг них может приехать. Отсекается всё, чего в записи прав быть
 * не может, — этого для защиты достаточно, а отнимать рабочую форму незачем.
 */
export function shellMode(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';

  const octal = /^[0-7]{3,4}$/;
  const symbolic = /^[ugoa]*[+\-=][rwxXst]*(,[ugoa]*[+\-=][rwxXst]*)*$/;

  if (!octal.test(text) && !symbolic.test(text)) {
    reject(name, value, 'an octal permission like 644 or a symbolic one like u+x');
  }

  return text;
}

/**
 * Владелец: `user` или `user:group`.
 *
 * Ведущий дефис отклоняется отдельно: `install -o -rf` разобрал бы такое имя
 * как свой флаг, и кавычки от этого не защищают.
 */
export function shellOwner(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';

  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/.test(text)) {
    reject(name, value, 'a user name or user:group');
  }

  return text;
}

/**
 * Шаблон имени файла: `*`, `?`, `[…]` доезжают до сервера живыми, остальное
 * уходит за обратный слэш и становится обычной буквой.
 *
 * Кавычки здесь запрещены: в них шаблон перестанет раскрываться, а раскрытие —
 * это и есть смысл параметра. Перевод строки и прочие управляющие символы
 * отклоняются — обратный слэш перед переводом строки означает продолжение
 * команды, то есть ровно то, от чего мы защищаемся.
 */
export function shellGlob(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value : '';

  if (text === '') reject(name, value, 'a file name pattern');
  if ([...text].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
    reject(name, value, 'free of control characters');
  }
  if (text.startsWith('-')) reject(name, value, 'a pattern that does not start with "-"');

  return text.replace(GLOB_KEEP, (char) => `\\${char}`);
}
