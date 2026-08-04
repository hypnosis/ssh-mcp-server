/**
 * Форма аргументов инструмента: есть ли параметр и того ли он вида.
 *
 * Рядом живёт `shell-arg.ts` — он про **значение** (`lines`, `mode`, `pattern`),
 * которое уезжает в команду. Здесь — про **форму**: пришёл ли обязательный
 * параметр вообще и строка это, массив строк или запись.
 *
 * Откуда взялось: замер (CORE_10, п. 4.1/4.2) показал, что ошибка в форме даёт
 * агенту не отказ, а внутренний сбой — `Cannot read properties of undefined
 * (reading 'path')` при вызове `ssh_file_write` без `files`, `finalCommand.
 * substring is not a function` при `command: 42`. Из такого текста нельзя
 * понять, что именно передано не так, и агент уходит в обход через `ssh_exec`.
 *
 * Схема от этого не спасает: MCP проверяет конверт запроса, а `arguments`
 * отдаёт как есть — `oneOf` в схеме остаётся описанием для клиента, не защитой.
 *
 * Тексты отказов держим в одном формате с `shell-arg.ts`: что ожидалось и что
 * пришло. Пустой список — тоже отказ: «записать ноль файлов» это не работа, а
 * потерянный вызов, о котором вызывающий должен узнать.
 */

/**
 * Значение в тексте отказа: «ничего» отличается от пустой строки и от нуля.
 *
 * Длинное содержимое обрезается: в отказе важно, **что** пришло не той формы,
 * а не весь конфиг целиком. `JSON.stringify` возвращает `undefined` для функции
 * и символа — отсюда `??`, иначе внятный отказ сам упал бы на `.slice`.
 */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  }
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return JSON.stringify(value)?.slice(0, 80) ?? String(value);
}

function reject(name: string, value: unknown, expected: string): never {
  throw new Error(`${name} must be ${expected}, got ${describe(value)}`);
}

/** Обязательная строка: путь назначения, каталог, имя файла */
export function requireText(value: unknown, name: string, example: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject(name, value, `a non-empty string like ${example}`);
  }

  return value;
}

/**
 * Обязательная строка или массив строк — форма, объявленная через `oneOf`
 * у `command` и `path`. Наружу всегда отдаётся массив: вызывающему не нужно
 * повторять разбор формы у себя.
 */
export function requireTextList(value: unknown, name: string, example: string): string[] {
  const expected = `a string like ${example} or an array of such strings`;

  if (typeof value === 'string') {
    if (value.trim() === '') reject(name, value, expected);
    return [value];
  }

  if (!Array.isArray(value)) reject(name, value, expected);
  if (value.length === 0) reject(name, value, `${expected} — the list is empty`);

  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      reject(`${name}[${index}]`, item, 'a non-empty string');
    }
  });

  return value as string[];
}

/**
 * Обязательная запись или массив записей — форма `files` у `ssh_file_write`.
 * Обязательные поля записи проверяются здесь же: без них дальше по коду
 * получится тот самый `undefined.path`, ради которого модуль и написан.
 */
export function requireEntryList<F extends string>(
  value: unknown,
  name: string,
  required: readonly F[],
  example: string
): Array<Record<string, unknown> & Record<F, string>> {
  const expected = `an object like ${example} or an array of such objects`;

  const isEntry = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

  const entries = Array.isArray(value) ? value : [value];

  if (!Array.isArray(value) && !isEntry(value)) reject(name, value, expected);
  if (Array.isArray(value) && value.length === 0) {
    reject(name, value, `${expected} — the list is empty`);
  }

  entries.forEach((entry, index) => {
    const where = Array.isArray(value) ? `${name}[${index}]` : name;
    if (!isEntry(entry)) reject(where, entry, 'an object');

    for (const field of required) {
      if (typeof entry[field] !== 'string') {
        reject(`${where}.${field}`, entry[field], 'a string');
      }
    }
  });

  return entries as Array<Record<string, unknown> & Record<F, string>>;
}
