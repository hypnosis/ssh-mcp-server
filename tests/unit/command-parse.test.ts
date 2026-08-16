/**
 * Unit tests: разбор командной строки на вызовы
 *
 * Модуль отвечает на один вопрос — что команда запускает. От правильности
 * ответа зависят и сторож удаления, и предупреждения: слово в позиции команды
 * это вызов, то же слово в аргументе или в кавычках — нет.
 */

import { describe, it, expect } from 'vitest';
import { parseInvocations, splitSegments, tokenize, unquote } from '../../src/utils/command-parse.js';

describe('parseInvocations: что команда запускает', () => {
  it('простая команда — одно имя и её аргументы', () => {
    expect(parseInvocations('rm -rf /srv/cache')).toEqual([
      { name: 'rm', args: ['-rf', '/srv/cache'] },
    ]);
  });

  it('путь до программы отбрасывается', () => {
    expect(parseInvocations('/sbin/reboot').map((i) => i.name)).toEqual(['reboot']);
  });

  it('обёртки пропускаются, и настоящая команда видна за ними', () => {
    expect(parseInvocations('sudo env nohup time halt --force')).toEqual([
      { name: 'halt', args: ['--force'] },
    ]);
  });

  it('каждый сегмент даёт свой вызов', () => {
    expect(parseInvocations('uptime && reboot; echo done | tee log').map((i) => i.name)).toEqual([
      'uptime',
      'reboot',
      'echo',
      'tee',
    ]);
  });

  it('обёртка пропускается вместе со своими аргументами', () => {
    expect(parseInvocations('timeout 5 reboot').map((i) => i.name)).toEqual(['reboot']);
    expect(parseInvocations('nice -n 10 halt').map((i) => i.name)).toEqual(['halt']);
    expect(parseInvocations('env DEBUG=1 poweroff').map((i) => i.name)).toEqual(['poweroff']);
  });

  it('имя обёртки должно совпасть целиком, а не началом', () => {
    expect(parseInvocations('envsubst < template.tpl').map((i) => i.name)).toEqual(['envsubst']);
    expect(parseInvocations('timeouts-report --json').map((i) => i.name)).toEqual([
      'timeouts-report',
    ]);
  });

  it('слово внутри аргумента вызовом не считается', () => {
    expect(parseInvocations('grep reboot /var/log/syslog').map((i) => i.name)).toEqual(['grep']);
  });

  it('пустые сегменты вызовов не создают', () => {
    expect(parseInvocations('; ; echo hi')).toEqual([{ name: 'echo', args: ['hi'] }]);
  });

  it('пустая команда даёт пустой список', () => {
    expect(parseInvocations('   ')).toEqual([]);
  });

  it('аргумент в кавычках остаётся одним куском вместе с пробелами', () => {
    expect(parseInvocations('psql -c "TRUNCATE users;"')).toEqual([
      { name: 'psql', args: ['-c', '"TRUNCATE users;"'] },
    ]);
  });
});

describe('unquote: кавычки снимаются только парные', () => {
  it('одиночные кавычки вокруг всего аргумента снимаются', () => {
    expect(unquote("'/srv/app data'")).toBe('/srv/app data');
  });

  it('двойные — тоже', () => {
    expect(unquote('"/srv/app"')).toBe('/srv/app');
  });

  it('кавычка только слева ничего не снимает', () => {
    expect(unquote("'/srv/app")).toBe("'/srv/app");
  });

  it('кавычка в середине аргумент не разворачивает', () => {
    expect(unquote("'/srv'/app")).toBe("'/srv'/app");
    expect(unquote('"/srv"/app')).toBe('"/srv"/app');
  });

  it('кавычки не с начала аргумента не снимаются', () => {
    expect(unquote("prefix'/srv/app'")).toBe("prefix'/srv/app'");
    expect(unquote('prefix"/srv/app"')).toBe('prefix"/srv/app"');
  });

  it('кавычка без закрывающей пары остаётся на месте', () => {
    expect(unquote('"/srv/app')).toBe('"/srv/app');
  });

  it('аргумент без кавычек возвращается как есть', () => {
    expect(unquote('/srv/app')).toBe('/srv/app');
  });
});

describe('splitSegments и tokenize', () => {
  it('разделители shell режут команду, а внутри кавычек — нет', () => {
    expect(splitSegments('a && b || c; d | e\nf')).toEqual(['a ', ' b ', ' c', ' d ', ' e', 'f']);
  });

  it('закавыченный кусок остаётся одним словом', () => {
    expect(tokenize('psql -c "DROP TABLE users;"')).toEqual([
      'psql',
      '-c',
      '"DROP TABLE users;"',
    ]);
  });

  it('пустой сегмент слов не даёт', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('кавычки закрываются: разделитель после них снова режет', () => {
    expect(splitSegments('echo "a; b"; reboot')).toEqual(['echo "a; b"', ' reboot']);
  });

  it('одинарные кавычки прячут разделитель так же, как двойные', () => {
    expect(splitSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });
});
