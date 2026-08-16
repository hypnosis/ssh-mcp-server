/**
 * Unit tests: в исходниках нет управляющих байтов.
 *
 * Такой байт попадает в файл не по замыслу, а на границе передачи: в коде
 * пишется литерал `'\0'` из двух знаков, а в файл уезжает один настоящий байт.
 * Дальше он невидим глазом, но `grep` считает файл двоичным и **молча** ничего
 * в нём не находит — пустой ответ поиска читается как «такого кода нет».
 *
 * Ни один другой сторож этого не ловит: компилятор видит корректный литерал,
 * мутации проверяют логику, CI гоняет то и другое.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

/** Перевод строки и табуляция — единственные управляющие знаки, которым здесь место */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', 'src', 'tests', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts') || line.endsWith('.mts') || line.endsWith('.mjs'));
}

/** Где именно сидит байт: файл, строка и код знака — иначе искать его глазами */
function findControlBytes(file: string): string[] {
  const found: string[] = [];
  const lines = readFileSync(file).toString('utf8').split('\n');

  lines.forEach((line, index) => {
    for (const char of line) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 && !ALLOWED_CONTROL.has(code)) {
        found.push(`${file}:${index + 1} — знак 0x${code.toString(16).padStart(2, '0')}`);
      }
    }
  });

  return found;
}

describe('Гигиена исходников', () => {
  it('ни один файл не содержит управляющих байтов', () => {
    const offenders = trackedSources().flatMap(findControlBytes);

    expect(offenders).toEqual([]);
  });

  it('сторож действительно смотрит на файлы, а не на пустой список', () => {
    expect(trackedSources().length).toBeGreaterThan(50);
  });
});
