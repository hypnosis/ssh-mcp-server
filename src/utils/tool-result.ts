/**
 * Ответ инструмента: провал отличается от результата флагом, а не текстом.
 *
 * «Проверить нечем» провалом не считается — это успех с пометкой внутри
 * содержимого, и флаг ему не ставится.
 */

import { partialOutputSection } from './output-notes.js';

/**
 * Ответ инструмента в форме, которую ждёт протокол.
 *
 * Именно псевдоним, а не интерфейс: обработчик запроса в SDK принимает объект
 * с произвольными полями, и интерфейс под такой параметр не подставляется.
 */
export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/** Ошибка, которая несёт вывод, накопленный командой до остановки */
type PartialOutputCarrier = { partialStdout: string; partialStderr: string };

function carriesPartialOutput(error: unknown): error is PartialOutputCarrier {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as PartialOutputCarrier).partialStdout === 'string' &&
    typeof (error as PartialOutputCarrier).partialStderr === 'string'
  );
}

/**
 * Инструмент не сделал того, о чём его просили.
 *
 * Убитая по таймауту команда успевает что-то напечатать, и это единственный
 * след её работы: повторить её нельзя — она уже стартовала на сервере.
 */
export function toolFailure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const partial = carriesPartialOutput(error)
    ? partialOutputSection(error.partialStdout, error.partialStderr)
    : '';

  return {
    content: [{ type: 'text', text: partial ? `Error: ${message}\n\n${partial}` : `Error: ${message}` }],
    isError: true,
  };
}
