/**
 * Очистка вывода от того, чем терминал рисует.
 *
 * Замерено на роутере с вендорской оболочкой: его CLI шлёт стирание строки даже без
 * терминала, и ответ приезжает с `[K` по краям. Для агента это шум, который
 * он принимает за часть ответа сервера.
 */

import { describe, it, expect } from 'vitest';
import { stripTerminalControls } from '../../src/utils/terminal-noise.js';

const ESC = '\u001B';

describe('stripTerminalControls', () => {
  it('убирает стирание строки', () => {
    expect(stripTerminalControls(`${ESC}[Krelease: 4.03${ESC}[K`)).toBe('release: 4.03');
  });

  it('убирает цвета', () => {
    expect(stripTerminalControls(`${ESC}[31mfailed${ESC}[0m`)).toBe('failed');
  });

  it('убирает обрезанную последовательность', () => {
    expect(stripTerminalControls(`load: ${ESC}`)).toBe('load: ');
  });

  it('оставляет обычный текст нетронутым', () => {
    const text = 'Filesystem  Size  Used\n/dev/sda1  50G  45G\n';

    expect(stripTerminalControls(text)).toBe(text);
  });

  it('не трогает квадратные скобки в тексте', () => {
    expect(stripTerminalControls('array[0] and [K in a name')).toBe('array[0] and [K in a name');
  });
});
