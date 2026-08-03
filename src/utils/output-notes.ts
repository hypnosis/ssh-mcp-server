/**
 * Пометки о неполном ответе
 *
 * Транспорт складывает вывод команды в буфер ограниченного размера и честно
 * сообщает, если вывод в него не поместился. Дальше это должен увидеть
 * человек: кусок файла или списка внешне ничем не отличается от целого,
 * и молча отданный огрызок читается как достоверный ответ.
 */

/** Лимит буфера вывода в транспорте (см. DEFAULT_MAX_OUTPUT_BYTES) */
const OUTPUT_LIMIT_LABEL = '10 MiB';

/** Код возврата утилиты `timeout`, когда она убивает затянувшуюся команду */
const TIMEOUT_GUARD_EXIT_CODE = 124;

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

/** Пояснение к коду возврата, если голое число вводит в заблуждение */
export function exitCodeHint(exitCode: number): string {
  if (exitCode === TIMEOUT_GUARD_EXIT_CODE) {
    return ' (killed by the timeout guard on the server — it ran past the allowed time)';
  }
  return '';
}
