/**
 * Сборка ответа об отказе: признак провала и вывод, который команда успела
 * напечатать до остановки.
 */

import { describe, it, expect } from 'vitest';
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
    expect(textOf(result)).toBe('Error: нет профиля');
  });

  it('читается и то, что ошибкой не является', () => {
    expect(textOf(toolFailure('просто строка'))).toBe('Error: просто строка');
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

    expect(textOf(toolFailure(error))).toBe('Error: таймаут');
  });

  it('ошибка без таких полей ответ не меняет', () => {
    expect(textOf(toolFailure(new Error('файла нет')))).toBe('Error: файла нет');
  });
});
