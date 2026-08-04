/**
 * Unit tests: форма аргумента проверяется до первой команды.
 *
 * Откуда: замер CORE_10 (4.1/4.2). Ошибка в форме давала не отказ, а внутренний
 * сбой — `Cannot read properties of undefined (reading 'path')` у
 * `ssh_file_write` без `files`, `finalCommand.substring is not a function` у
 * `ssh_exec` с числом. Агент из такого текста не понимает, что передал не так.
 *
 * Проверяется не только текст отказа, но и то, что **до транспорта не ушло ни
 * одной команды**: сначала отказ, потом уже работа. И отдельно — что модуль
 * действительно врезан в инструменты: тест на одну утилиту не поймает случай
 * «функция написана, но никуда не подключена», ровно так выжил `pathSecurity`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  requireText,
  requireTextList,
  requireEntryList,
} from '../../src/utils/tool-args.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    SSHExecutor: class {
      execute = executeMock;
      passport = passportMock;
      executeChecked = actual.SSHExecutor.prototype.executeChecked;
    },
  };
});

const { uploadMock, downloadMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  downloadMock: vi.fn(),
}));

vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ upload: uploadMock, download: downloadMock }),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { LogTools } = await import('../../src/tools/log-tools.js');
const { TransferTool } = await import('../../src/tools/transfer-tool.js');

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

describe('форма аргумента: сам модуль', () => {
  describe('requireText', () => {
    it('пропускает непустую строку как есть', () => {
      expect(requireText('/var/log', 'path', '"/var/log"')).toBe('/var/log');
    });

    it.each([
      ['отсутствие', undefined, 'nothing'],
      ['null', null, 'null'],
      ['пустую строку', '', '""'],
      ['одни пробелы', '   ', '"   "'],
      ['число', 42, '42'],
      ['массив', ['/var/log'], 'an array of 1'],
      ['объект', { path: '/var/log' }, '{"path":"/var/log"}'],
    ])('отклоняет %s и называет полученное', (_, value, shown) => {
      expect(() => requireText(value, 'path', '"/var/log"')).toThrow(
        `path must be a non-empty string like "/var/log", got ${shown}`
      );
    });
  });

  describe('описание значения в отказе', () => {
    it('длинная строка обрезается — в отказе важна форма, а не весь конфиг', () => {
      // Строка вместо записи: сюда длинное значение и попадает на практике —
      // клиент прислал содержимое файла туда, где ждали объект
      const long = 'x'.repeat(200);

      expect(() => requireEntryList(long, 'files', ['path'], '{"path": "/a"}')).toThrow(
        `got "${'x'.repeat(60)}…"`
      );
    });

    it('на границе в 60 знаков ещё не обрезает', () => {
      const exact = 'y'.repeat(60);

      // Ровно на границе многоточия быть не должно: обрезаем то, что длиннее
      expect(() => requireEntryList(exact, 'files', ['path'], '{"path": "/a"}')).toThrow(
        `got "${exact}"`
      );
    });

    it('длинный объект тоже обрезается', () => {
      const wide = { note: 'z'.repeat(200) };

      expect(() => requireText(wide, 'path', '"/a"')).toThrow(/got \{"note":"z+$/);
    });

    it('функция не роняет сам отказ — JSON.stringify отдаёт для неё undefined', () => {
      expect(() => requireText(() => undefined, 'path', '"/a"')).toThrow(/^path must be .*got \(\)/);
    });
  });

  describe('requireTextList', () => {
    it('строку отдаёт списком из одного', () => {
      expect(requireTextList('uptime', 'command', '"uptime"')).toEqual(['uptime']);
    });

    it('массив строк отдаёт как есть', () => {
      expect(requireTextList(['a', 'b'], 'command', '"uptime"')).toEqual(['a', 'b']);
    });

    it('строка из одних пробелов — тоже отказ, а не команда', () => {
      expect(() => requireTextList('   ', 'command', '"uptime"')).toThrow(/^command must be/);
    });

    it('отклоняет пустой список — «ноль команд» это потерянный вызов', () => {
      expect(() => requireTextList([], 'command', '"uptime"')).toThrow(/the list is empty/);
    });

    it.each([
      ['число', 42],
      ['объект', { command: 'uptime' }],
      ['отсутствие', undefined],
      ['пустую строку', ''],
    ])('отклоняет %s', (_, value) => {
      expect(() => requireTextList(value, 'command', '"uptime"')).toThrow(/^command must be/);
    });

    it.each([
      ['число внутри', ['ok', 42], 'command[1]'],
      ['пустую строку внутри', ['ok', '  '], 'command[1]'],
      ['null внутри', [null, 'ok'], 'command[0]'],
    ])('отклоняет %s и называет позицию', (_, value, where) => {
      expect(() => requireTextList(value, 'command', '"uptime"')).toThrow(
        new RegExp(`^${where.replace(/[[\]]/g, '\\$&')} must be a non-empty string`)
      );
    });
  });

  describe('requireEntryList', () => {
    const EXAMPLE = '{"path": "/etc/app.conf", "content": "..."}';

    it('одну запись отдаёт списком из одной', () => {
      const entry = { path: '/a', content: 'x' };
      expect(requireEntryList(entry, 'files', ['path', 'content'], EXAMPLE)).toEqual([entry]);
    });

    it('массив записей отдаёт как есть', () => {
      const entries = [
        { path: '/a', content: 'x' },
        { path: '/b', content: 'y' },
      ];
      expect(requireEntryList(entries, 'files', ['path', 'content'], EXAMPLE)).toEqual(entries);
    });

    it('отклоняет пустой список — «записать ноль файлов» это не работа', () => {
      expect(() => requireEntryList([], 'files', ['path', 'content'], EXAMPLE)).toThrow(
        /the list is empty/
      );
    });

    it.each([
      ['path', { content: 'x' }, 'files.path'],
      ['content', { path: '/a' }, 'files.content'],
    ])('отклоняет запись без %s и называет поле', (_, entry, where) => {
      expect(() => requireEntryList(entry, 'files', ['path', 'content'], EXAMPLE)).toThrow(
        `${where} must be a string, got nothing`
      );
    });

    it('не-объект внутри массива называется своей позицией', () => {
      expect(() =>
        requireEntryList([{ path: '/a', content: 'x' }, 42], 'files', ['path', 'content'], EXAMPLE)
      ).toThrow('files[1] must be an object, got 42');
    });

    it('в массиве называет и позицию, и поле', () => {
      expect(() =>
        requireEntryList(
          [{ path: '/a', content: 'x' }, { path: '/b' }],
          'files',
          ['path', 'content'],
          EXAMPLE
        )
      ).toThrow('files[1].content must be a string, got nothing');
    });

    it.each([
      ['строку', 'files'],
      ['число', 7],
      ['отсутствие', undefined],
      ['null', null],
    ])('отклоняет %s вместо записи', (_, value) => {
      expect(() => requireEntryList(value, 'files', ['path'], EXAMPLE)).toThrow(/^files must be/);
    });

    it('нестроковое обязательное поле — тоже отказ', () => {
      expect(() =>
        requireEntryList({ path: '/a', content: 42 }, 'files', ['path', 'content'], EXAMPLE)
      ).toThrow('files.content must be a string, got 42');
    });
  });
});

describe('форма аргумента: врезка в инструменты', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    passportMock.mockResolvedValue({ home: '/home/deploy', sha256: 'sha256sum', bash: false });
    executeMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });
  });

  const cases: Array<{ label: string; tool: () => { handleCall: (r: CallToolRequest) => Promise<any> }; name: string; args: Record<string, unknown>; expect: RegExp }> = [
    {
      label: 'ssh_exec без command',
      tool: () => new ExecTool(),
      name: 'ssh_exec',
      args: { profile: 'production' },
      expect: /command must be a string like "uptime" or an array of such strings, got nothing/,
    },
    {
      label: 'ssh_exec с числом вместо команды',
      tool: () => new ExecTool(),
      name: 'ssh_exec',
      args: { profile: 'production', command: 42 },
      expect: /command must be .*got 42/,
    },
    {
      label: 'ssh_file_read без path',
      tool: () => new FileTools(),
      name: 'ssh_file_read',
      args: { profile: 'production' },
      expect: /path must be .*got nothing/,
    },
    {
      label: 'ssh_file_write без files',
      tool: () => new FileTools(),
      name: 'ssh_file_write',
      args: { profile: 'production' },
      expect: /files must be an object like .*got nothing/,
    },
    {
      label: 'ssh_file_write с пустым списком',
      tool: () => new FileTools(),
      name: 'ssh_file_write',
      args: { profile: 'production', files: [] },
      expect: /the list is empty/,
    },
    {
      label: 'ssh_file_write с path/content мимо files',
      tool: () => new FileTools(),
      name: 'ssh_file_write',
      args: { profile: 'production', path: '/tmp/a', content: 'x' },
      expect: /files must be an object like/,
    },
    {
      label: 'ssh_file_list без path',
      tool: () => new FileTools(),
      name: 'ssh_file_list',
      args: { profile: 'production' },
      expect: /path must be a non-empty string like "\/var\/log", got nothing/,
    },
    {
      label: 'ssh_log_tail без path',
      tool: () => new LogTools(),
      name: 'ssh_log_tail',
      args: { profile: 'production' },
      expect: /path must be .*got nothing/,
    },
    {
      label: 'ssh_log_search без query',
      tool: () => new LogTools(),
      name: 'ssh_log_search',
      args: { profile: 'production', path: '/var/log/syslog' },
      expect: /query must be .*got nothing/,
    },
    {
      label: 'ssh_upload без local_path',
      tool: () => new TransferTool(),
      name: 'ssh_upload',
      args: { profile: 'production', remote_path: '/opt/app' },
      expect: /local_path must be .*got nothing/,
    },
    {
      label: 'ssh_download без remote_path',
      tool: () => new TransferTool(),
      name: 'ssh_download',
      args: { profile: 'production', local_path: './app.conf' },
      expect: /remote_path must be .*got nothing/,
    },
  ];

  it.each(cases)('$label — внятный отказ, и ничего не ушло на сервер', async ({ tool, name, args, expect: pattern }) => {
    const answer = await tool().handleCall(call(name, args));
    const text: string = answer.content[0].text;

    expect(text).toMatch(pattern);
    // Текста внутреннего сбоя быть не должно — ради этого всё и делалось
    expect(text).not.toMatch(/Cannot read properties|is not a function/);
    expect(executeMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });
});
