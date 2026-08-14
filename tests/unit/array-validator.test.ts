/**
 * Unit tests: разбор строки, которая притворяется массивом.
 *
 * Модуль стоит на входе четырёх инструментов (`ssh_exec`, `ssh_file_read`,
 * `ssh_log_tail`, `ssh_log_search`) и до сих пор не был покрыт ничем — замер
 * CORE_10 (4.2) это вскрыл. Он ловит ровно один класс: клиент не осилил форму
 * `oneOf` и прислал массив строкой с одинарными кавычками.
 *
 * Вторая половина теста важнее первой: команда `[[ -f x ]]` начинается с той же
 * скобки, и ложное срабатывание отняло бы у `ssh_exec` рабочую форму. Поэтому
 * каждый «не срабатывает» здесь — отдельное утверждение, а не довесок.
 */

import { describe, it, expect } from 'vitest';
import { validateArrayParameter, createValidationErrorResponse } from '../../src/utils/array-validator.js';

describe('array-validator: строка, притворяющаяся массивом', () => {
  describe('отклоняет', () => {
    it.each([
      ['одинарные кавычки', "['echo a', 'echo b']"],
      ['одинарные кавычки, один элемент', "['echo a']"],
      ['JSON-массив, присланный строкой', '["echo a", "echo b"]'],
      ['числа в скобках через запятую', '[1, 2, 3]'],
      ['пробел перед скобкой', "  ['a', 'b']  "],
    ])('%s', (_, value) => {
      const result = validateArrayParameter(value, 'command');

      expect(result.isValid).toBe(false);
      // В тексте должно быть и имя параметра, и присланное значение —
      // иначе вызывающий не поймёт, что именно чинить
      expect(result.errorMessage).toContain('command');
      expect(result.errorMessage).toContain(value);
    });
  });

  describe('пропускает', () => {
    it.each([
      ['настоящий массив', ['echo a', 'echo b']],
      ['пустой массив', []],
      ['обычную команду', 'uptime'],
      ['bash-тест в двойных скобках', '[[ -f /etc/hosts ]] && echo да'],
      ['два bash-теста подряд', '[[ -f a ]] && [[ -f b ]]'],
      ['скобку в середине', 'grep "[0-9]," /etc/hosts'],
      ['bash-тест с запятой внутри', '[[ "$x" == a,b ]] && echo да'],
      ['скобку с кавычкой не в начале строки', "[x ['y]"],
      ['одиночную скобку без запятой и кавычек', '[test]'],
      ['число', 42],
      ['отсутствие значения', undefined],
      ['null', null],
    ])('%s', (_, value) => {
      expect(validateArrayParameter(value, 'command').isValid).toBe(true);
    });
  });

  it('текст отказа говорит про тот параметр, в котором ошиблись', () => {
    const result = validateArrayParameter("['/var/log/a']", 'path');

    expect(result.errorMessage).toContain('path: ["item1", "item2", "item3"]');
    // Подсказка про bash-тест относится к команде: в ответе про путь она
    // советовала бы чинить не тот параметр
    expect(result.errorMessage).not.toContain('command');
  });

  it('про bash-тест подсказывает только там, где значение и есть команда', () => {
    const result = validateArrayParameter("['echo a']", 'command');

    expect(result.errorMessage).toContain('[[ -f file.txt ]]');
  });

  it('без имени параметра отказ всё равно читается', () => {
    const result = validateArrayParameter("['a', 'b']");

    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain("'parameter'");
  });

  it('ответ об ошибке приходит текстом MCP', () => {
    const answer = createValidationErrorResponse('текст отказа');

    expect(answer).toEqual({
      content: [{ type: 'text', text: 'текст отказа' }],
      isError: true,
    });
  });
});
