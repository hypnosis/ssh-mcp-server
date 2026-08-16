/**
 * Значение параметра инструмента не должно исполняться на сервере.
 *
 * Проверяется не «экранирование вообще», а четыре вида значений, которые в
 * командную строку попадают: число, права, владелец и шаблон имени. Шаблон —
 * единственный, который обязан раскрываться на сервере, поэтому кавычками его
 * закрыть нельзя, и правила у него свои.
 */

import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/runner/process.js';
import {
  shellCount,
  shellMode,
  shellOwner,
  shellGlob,
  shellQuote,
} from '../../src/utils/shell-arg.js';

/** Значения, ради которых всё это написано */
const INJECTIONS = [
  '; id',
  '$(id)',
  '`id`',
  '&& rm -rf /tmp/x',
  '| cat /etc/shadow',
  "' ; id ; '",
  '\n id',
];

/** Имена, на которых весь спринт ловились ошибки квотирования */
const AWKWARD_NAMES = [
  'plain.txt',
  "it's.txt",
  'a b.txt',
  'a\\b.txt',
  'a\nb.txt',
  '$HOME.txt',
  '`id`.txt',
  '$(id).txt',
  '~tilde.txt',
  'star*.txt',
  '; id ;.txt',
];

/** Что настоящий shell увидит на месте закавыченного значения */
async function shellSees(command: string): Promise<string> {
  const result = await runProcess({ file: '/bin/sh', args: ['-c', command], timeoutMs: 5000 });
  return result.stdout;
}

describe('shellQuote', () => {
  it('обрамляет значение одинарными кавычками', () => {
    expect(shellQuote('/etc/foo')).toBe(`'/etc/foo'`);
  });

  it("закрывает вложенный апостроф приёмом '\\''", () => {
    expect(shellQuote("/path/it's.txt")).toBe(`'/path/it'\\''s.txt'`);
  });

  it.each(AWKWARD_NAMES)('shell возвращает %j нетронутым', async (name) => {
    expect(await shellSees(`printf %s ${shellQuote(name)}`)).toBe(name);
  });

  /**
   * Путь sudo: команда уезжает внутрь `sudo sh -c '…'`, то есть значение
   * закавычивается дважды. Приём обязан переживать сам себя — здесь жила
   * третья реализация, и на одном круге кавычек разницы не видно.
   */
  it.each(AWKWARD_NAMES)('%j переживает второй круг кавычек', async (name) => {
    const inner = `printf %s ${shellQuote(name)}`;

    expect(await shellSees(`sh -c ${shellQuote(inner)}`)).toBe(name);
  });
});

describe('shellCount', () => {
  it('пропускает целые числа', () => {
    expect(shellCount(100, 'lines')).toBe(100);
    expect(shellCount(0, 'context')).toBe(0);
  });

  it('пропускает число, пришедшее строкой: схема типы не гарантирует', () => {
    expect(shellCount('50', 'lines')).toBe(50);
  });

  it.each(INJECTIONS)('отказывает на %j', (value) => {
    expect(() => shellCount(`100${value}`, 'lines')).toThrow(/lines/);
  });

  it('отказывает на дробном, отрицательном и нечисловом', () => {
    expect(() => shellCount(1.5, 'lines')).toThrow(/lines/);
    expect(() => shellCount(-1, 'lines')).toThrow(/lines/);
    expect(() => shellCount('много', 'lines')).toThrow(/lines/);
    expect(() => shellCount(Infinity, 'lines')).toThrow(/lines/);
    expect(() => shellCount({}, 'lines')).toThrow(/lines/);
  });

  it('называет параметр и показывает полученное значение', () => {
    expect(() => shellCount('5; id', 'log_lines')).toThrow(/log_lines.*5; id/s);
  });
});

describe('shellMode', () => {
  it('пропускает восьмеричные права', () => {
    expect(shellMode('644', 'mode')).toBe('644');
    expect(shellMode('0755', 'mode')).toBe('0755');
  });

  it.each(INJECTIONS)('отказывает на %j', (value) => {
    expect(() => shellMode(`644${value}`, 'mode')).toThrow(/mode/);
  });

  it('пропускает символьную запись: она не опаснее восьмеричной', () => {
    expect(shellMode('u+x', 'mode')).toBe('u+x');
    expect(shellMode('go-w,a+r', 'mode')).toBe('go-w,a+r');
    expect(shellMode('a=rx', 'mode')).toBe('a=rx');
  });

  it('отказывает на цифрах вне восьмеричных и на мусоре', () => {
    expect(() => shellMode('999', 'mode')).toThrow(/mode/);
    expect(() => shellMode('644abc', 'mode')).toThrow(/mode/);
    expect(() => shellMode('u+x rm', 'mode')).toThrow(/mode/);
    expect(() => shellMode('', 'mode')).toThrow(/mode/);
  });
});

describe('shellOwner', () => {
  it('пропускает имя и пару имя:группа', () => {
    expect(shellOwner('root', 'owner')).toBe('root');
    expect(shellOwner('root:root', 'owner')).toBe('root:root');
    expect(shellOwner('www-data:www-data', 'owner')).toBe('www-data:www-data');
  });

  it.each(INJECTIONS)('отказывает на %j', (value) => {
    expect(() => shellOwner(`root${value}`, 'owner')).toThrow(/owner/);
  });

  it('отказывает на имени с ведущим дефисом: install примет его за флаг', () => {
    expect(() => shellOwner('-o', 'owner')).toThrow(/owner/);
    expect(() => shellOwner('root:-g', 'owner')).toThrow(/owner/);
  });

  it('отказывает на пробеле и пустом значении', () => {
    expect(() => shellOwner('root root', 'owner')).toThrow(/owner/);
    expect(() => shellOwner('', 'owner')).toThrow(/owner/);
  });
});

describe('shellGlob', () => {
  it('оставляет символы шаблона нетронутыми: раскрытие на сервере — это функция', () => {
    expect(shellGlob('*.log', 'pattern')).toBe('*.log');
    expect(shellGlob('access?.log', 'pattern')).toBe('access?.log');
    expect(shellGlob('[abc]*.conf', 'pattern')).toBe('[abc]*.conf');
  });

  it('экранирует пробел обратным слэшем: кавычки убили бы раскрытие', () => {
    expect(shellGlob('my file*.log', 'pattern')).toBe('my\\ file*.log');
  });

  it.each(['; id', '$(id)', '`id`', '&& rm -rf /tmp/x', '| cat /etc/passwd', "' ; id ; '"])(
    'обезвреживает %j',
    (value) => {
      const escaped = shellGlob(`*${value}`, 'pattern');
      // Каждый опасный символ уехал за обратный слэш — shell видит буквы
      for (const ch of [';', '$', '`', '&', '|', "'", '(', ')']) {
        if (value.includes(ch)) expect(escaped).toContain(`\\${ch}`);
      }
    }
  );

  it('отказывает на управляющих символах: перевод строки обратным слэшем не закрыть', () => {
    expect(() => shellGlob('*.log\nid', 'pattern')).toThrow(/pattern/);
    expect(() => shellGlob('*\t', 'pattern')).toThrow(/pattern/);
  });

  it('отказывает на ведущем дефисе: ls примет его за флаг', () => {
    expect(() => shellGlob('-la', 'pattern')).toThrow(/pattern/);
  });

  it('оставляет кириллицу читаемой', () => {
    expect(shellGlob('журнал*.log', 'pattern')).toBe('журнал*.log');
  });
});
