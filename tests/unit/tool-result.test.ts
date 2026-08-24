/**
 * Сборка ответа об отказе: признак провала и вывод, который команда успела
 * напечатать до остановки.
 */

import { describe, it, expect } from 'vitest';
import { CallerError, EXEC_FALLBACK } from '../../src/utils/tool-result.js';

/** Текст отказа целиком: к причине ответ всегда добавляет выход через ssh_exec */
const refusal = (reason: string) => `${reason} ${EXEC_FALLBACK}`;
import { toolFailure } from '../../src/utils/tool-result.js';
import { PARTIAL_OUTPUT_NOTE } from '../../src/utils/output-notes.js';
import { SSHTimeoutError, SSHCancelledError } from '../../src/runner/errors.js';

/** Текст единственного куска ответа */
function textOf(result: ReturnType<typeof toolFailure>): string {
  return result.content[0].text;
}

describe('отказ инструмента', () => {
  it('несёт признак провала и текст ошибки', () => {
    const result = toolFailure(new Error('нет профиля'));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(refusal('Error: нет профиля'));
  });

  it('читается и то, что ошибкой не является', () => {
    expect(textOf(toolFailure('просто строка'))).toBe(refusal('Error: просто строка'));
  });
});

describe('вывод, накопленный до остановки команды', () => {
  it('доходит до ответа под пометкой о неполноте', () => {
    const error = new SSHTimeoutError('Command timed out after 1500ms', {
      partialStdout: 'started\n',
      partialStderr: 'warming\n',
    });

    const text = textOf(toolFailure(error));

    expect(text).toContain('Command timed out after 1500ms');
    expect(text).toContain(PARTIAL_OUTPUT_NOTE);
    expect(text).toContain('STDOUT:\nstarted');
    expect(text).toContain('STDERR:\nwarming');
  });

  it('отменённая команда отдаёт своё накопленное так же', () => {
    const error = new SSHCancelledError('Command cancelled', { partialStdout: 'half a line' });

    const text = textOf(toolFailure(error));

    expect(text).toContain('STDOUT:\nhalf a line');
    expect(text).not.toContain('STDERR:');
  });

  it('пустой канал не показывается — иначе он читался бы как «вывода не было»', () => {
    const error = new SSHTimeoutError('таймаут', { partialStderr: 'oops\n' });

    const text = textOf(toolFailure(error));

    expect(text).toContain('STDERR:\noops');
    expect(text).not.toContain('STDOUT:');
  });

  it('команда, убитая до первого байта, не получает пустой пометки', () => {
    const error = new SSHTimeoutError('таймаут', { partialStdout: '', partialStderr: '' });

    expect(textOf(toolFailure(error))).toBe(refusal('Error: таймаут'));
  });

  it('ошибка без таких полей ответ не меняет', () => {
    expect(textOf(toolFailure(new Error('файла нет')))).toBe(refusal('Error: файла нет'));
  });
});

/**
 * Разбор при провале даётся там, где сам провал — измерение: клиент обязан
 * разбирать только ответ без пометки об ошибке, поэтому пустого поля здесь
 * быть не должно.
 */
describe('разбор рядом с отказом', () => {
  it('обычный отказ приезжает без разбора — поля нет вовсе', () => {
    const result = toolFailure(new Error('нет профиля'));

    expect('structuredContent' in result).toBe(false);
  });

  it('переданный разбор приезжает вместе с пометкой об ошибке', () => {
    const summary = { files: [] };

    const result = toolFailure(new Error('не сошлось'), summary);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBe(summary);
  });
});

/**
 * Выход из отказа.
 *
 * Инструмент, упершийся в свои границы, обязан назвать того, кто границ не
 * знает: агент после первого «нет» всё равно пойдёт в оболочку, вопрос лишь
 * в том, вслепую или по подсказке. Перечислять случаи бессмысленно — их
 * больше, чем можно предусмотреть, поэтому выход добавляется всем сразу.
 *
 * И три исключения, где он врёт: правило профиля обходить не предлагаем,
 * ошибку вызова оболочкой не чинят, а в ответе самого exec совет ведёт по кругу.
 */
describe('выход через ssh_exec в отказе', () => {
  it('обычный отказ несёт выход', () => {
    const result = toolFailure(new Error('the server has no sha256sum'));

    expect(result.content[0].text).toBe(`Error: the server has no sha256sum ${EXEC_FALLBACK}`);
    expect(result.isError).toBe(true);
  });

  it('ошибка вызова выхода не получает: чинить нужно вызов', () => {
    const result = toolFailure(new CallerError('path must be a non-empty string, got nothing'));

    expect(result.content[0].text).toBe('Error: path must be a non-empty string, got nothing');
  });

  it('правило профиля выхода не получает: его не обходят, а соблюдают', () => {
    const denied = Object.assign(new Error('Path validation failed: /etc is not allowed'), {
      noExecHint: true,
    });

    expect(toolFailure(denied).content[0].text).not.toContain('ssh_exec');
  });

  it('инструмент, который сам и есть оболочка, выход отключает', () => {
    const result = toolFailure(new Error('command timed out'), undefined, { hint: false });

    expect(result.content[0].text).toBe('Error: command timed out');
  });

  /**
   * Брошено может быть что угодно, включая `null` и строку. Проверка формы
   * стоит перед чтением полей: без неё разбор отказа падал бы сам, и вместо
   * причины вызывающий получал бы отказ отказа.
   */
  it.each([
    ['null', null],
    ['строку', 'connection reset'],
  ])('отказ, брошенный не объектом (%s), разбирается наравне', (_case, thrown) => {
    const result = toolFailure(thrown);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(EXEC_FALLBACK);
  });

  it('отказ, уже назвавший ssh_exec, второй раз его не называет', () => {
    const result = toolFailure(new Error('journald keeps no file — ssh_exec reaches it'));

    expect(result.content[0].text).toBe('Error: journald keeps no file — ssh_exec reaches it');
  });
});
