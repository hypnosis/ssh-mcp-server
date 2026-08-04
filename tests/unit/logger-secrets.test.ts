/**
 * Логгер не выпускает секреты профилей в свой вывод.
 *
 * Лог уходит в stderr — то есть в вывод MCP-клиента, поэтому пароль,
 * попавший туда однажды, остаётся в чужих логах навсегда.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inspect } from 'util';
import { logger, hideFromLogs, forgetLoggedSecrets } from '../../src/utils/logger.js';

const PASSWORD = 'Kf8#mQ2vLp';
const SHORT_PASSWORD = 'root';

describe('логгер прячет секреты профилей', () => {
  let written: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      // Так же, как это делает настоящий console.error: иначе `Error`
      // сериализуется в `{}`, и проверка не увидит секрет в его тексте
      const asText = (value: unknown) => (typeof value === 'string' ? value : inspect(value));
      written.push(args.map(asText).join(' '));
    });
    forgetLoggedSecrets();
  });

  afterEach(() => {
    spy.mockRestore();
    forgetLoggedSecrets();
  });

  it('вычищает секрет из текста сообщения', () => {
    hideFromLogs(PASSWORD);

    logger.error(`connect failed with password ${PASSWORD}`);

    expect(written.join('\n')).not.toContain(PASSWORD);
    expect(written.join('\n')).toContain('***');
  });

  it('вычищает секрет из объекта, отданного вторым аргументом', () => {
    hideFromLogs(PASSWORD);

    // Так выглядит неосторожная отладочная строка, ради которой сторож и стоит
    logger.error('profile data:', { host: '10.0.0.1', username: 'root', password: PASSWORD });

    expect(written.join('\n')).not.toContain(PASSWORD);
  });

  it('прячет и короткий секрет: в нашем тексте длина роли не играет', () => {
    hideFromLogs(SHORT_PASSWORD);

    logger.error(`password is ${SHORT_PASSWORD}`);

    expect(written.join('\n')).not.toContain('password is root');
  });

  it('объект без секрета остаётся объектом, а не превращается в строку', () => {
    hideFromLogs(PASSWORD);

    logger.error('profile data:', { host: '10.0.0.1', username: 'root' });

    expect(spy.mock.calls[0][2]).toEqual({ host: '10.0.0.1', username: 'root' });
  });

  it('без зарегистрированных секретов текст не меняется', () => {
    logger.error('nothing to hide: password Kf8#mQ2vLp');

    expect(written.join('\n')).toContain('password Kf8#mQ2vLp');
  });

  it('прячет секрет внутри объекта с циклической ссылкой', () => {
    // Раньше здесь была дыра: сериализация в JSON бросала исключение, и объект
    // печатался нетронутым — вместе с паролем
    hideFromLogs(PASSWORD);
    const looped: Record<string, unknown> = { host: '10.0.0.1', password: PASSWORD };
    looped.self = looped;

    logger.error('looped:', looped);

    expect(written.join('\n')).not.toContain(PASSWORD);
  });

  it('прячет секрет в тексте ошибки и её стеке', () => {
    // `JSON.stringify(new Error(...))` давал `{}`, и ошибка уходила в лог как есть
    hideFromLogs(PASSWORD);

    logger.error('connect failed:', new Error(`auth with ${PASSWORD} rejected`));

    expect(written.join('\n')).not.toContain(PASSWORD);
  });

  it('прячет секрет в Map, а не только в обычном объекте', () => {
    hideFromLogs(PASSWORD);

    logger.error('creds:', new Map([['password', PASSWORD]]));

    expect(written.join('\n')).not.toContain(PASSWORD);
  });

  it.each([['обратный слэш', 'pa\\ss'], ['перевод строки', 'pa\nss'], ['кавычка', 'pa"ss']])(
    'прячет секрет со спецсимволом: %s',
    (_name, secret) => {
      // Печатная форма экранирует такие символы, и поиск сырой подстроки её не находит
      hideFromLogs(secret);

      logger.error('profile:', { host: '10.0.0.1', password: secret });

      const printed = written.join('\n');
      expect(printed).not.toContain(secret);
      expect(printed).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  );
});
