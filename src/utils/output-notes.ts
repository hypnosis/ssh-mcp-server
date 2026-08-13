/**
 * Пометки о неполном ответе
 *
 * Транспорт складывает вывод команды в буфер ограниченного размера и честно
 * сообщает, если вывод в него не поместился. Дальше это должен увидеть
 * человек: кусок файла или списка внешне ничем не отличается от целого,
 * и молча отданный огрызок читается как достоверный ответ.
 */

/** Сколько вывода команды помещается в буфер транспорта; сверх этого ответ обрезается */
export const OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'];

/** Человеческая запись объёма: 10485760 → «10 MiB» */
export function byteLimitLabel(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded} ${BYTE_UNITS[unit]}`;
}

const OUTPUT_LIMIT_LABEL = byteLimitLabel(OUTPUT_LIMIT_BYTES);

/**
 * Коды, которыми удалённый сторож сообщает, что убил затянувшуюся команду.
 *
 * Замерено на живых серверах: coreutils возвращает 124, BusyBox — 143
 * (это 128 + SIGTERM). Работу убивают оба, но голое «143» без пояснения
 * читается как отказ самой команды.
 */
const TIMEOUT_GUARD_EXIT_CODES = [124, 143];

export const TRUNCATED_OUTPUT_NOTE =
  `⚠️ Output truncated at the transport buffer limit (${OUTPUT_LIMIT_LABEL}) — ` +
  'this is only its first part.';

/** Подписать вывод, если он неполный */
export function withTruncationNote(text: string, truncated: boolean): string {
  if (!truncated) return text;
  return text ? `${text}\n\n${TRUNCATED_OUTPUT_NOTE}` : TRUNCATED_OUTPUT_NOTE;
}

/**
 * Почему чтение файла отказало и что делать вместо него.
 *
 * Для файла пометка не спасает: содержимое уходит дальше как данные — его
 * записывают обратно, разбирают, сравнивают. Обрезанный файл в этой цепочке
 * опаснее отказа, поэтому здесь отказ с готовым обходным путём.
 */
export function truncatedReadMessage(path: string): string {
  return (
    `${path} does not fit into the transport buffer (${OUTPUT_LIMIT_LABEL}), ` +
    'so reading it as command output would return only its first part. ' +
    `Use ssh_download to fetch the whole file, or read it in ranges: sed -n '1,500p' ${path}.`
  );
}

/**
 * Байты, не сложившиеся в текст, приходят знаком замены — файл уже испорчен,
 * и записанный обратно даст другой файл. Поэтому здесь тоже отказ с обходным
 * путём, а не пометка поверх содержимого.
 */
export function binaryReadMessage(path: string): string {
  return (
    `${path} is not valid UTF-8 text: reading it as command output replaces the ` +
    'bytes that do not form characters, so the content would come back damaged. ' +
    'Read it with binary: true to get base64, or fetch the file with ssh_download.'
  );
}

/** Есть ли в прочитанном знак замены — след потерянных байтов */
export function looksDamagedAsText(text: string): boolean {
  return text.includes('�');
}

/** Пояснение к коду возврата, если голое число вводит в заблуждение */
export function exitCodeHint(exitCode: number): string {
  if (TIMEOUT_GUARD_EXIT_CODES.includes(exitCode)) {
    return ' (killed by the timeout guard on the server — it ran past the allowed time)';
  }
  return '';
}
