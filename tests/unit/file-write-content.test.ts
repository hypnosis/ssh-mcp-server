/**
 * Unit tests: содержимое доезжает до файла байт в байт
 *
 * Быстрый путь записи собирал команду `cat > файл << 'SSHEOF'` и вклеивал в неё
 * текст пользователя. Измерено на живых серверах (BusyBox и dash, оба одинаково):
 * апостроф превращался в пять символов, строка `SSHEOF` внутри текста обрывала
 * запись и остаток файла исполнялся как команды, а ко всякому файлу дописывался
 * лишний перевод строки.
 *
 * Поэтому содержимое больше не проходит через shell вообще: оно идёт в stdin
 * команды `cat`, а на место встаёт установщиком, как и всё остальное.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SSHExecuteResult } from '../../src/managers/ssh-executor.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    SSHExecutor: class {
      execute = executeMock;
      executeChecked = actual.SSHExecutor.prototype.executeChecked;
      passport = passportMock;
    },
  };
});

const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));

vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ upload: uploadMock, download: vi.fn() }),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { FileTools } = await import('../../src/tools/file-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

interface Sent {
  command: string;
  stdin?: string | Buffer;
}

/** Что ушло на сервер: команда и то, что подано ей на вход */
function sent(): Sent[] {
  return executeMock.mock.calls.map(([, command, options]) => ({
    command: command as string,
    stdin: (options as { stdin?: string | Buffer } | undefined)?.stdin,
  }));
}

/** Команда, которая наполняет файл содержимым */
function writeCommand(): Sent | undefined {
  return sent().find((call) => call.command.startsWith('cat >'));
}

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_file_write', arguments: args } } as CallToolRequest;
}

async function write(file: Record<string, unknown>): Promise<string> {
  const response = await new FileTools().handleCall(call({ files: [file] }));
  return response.content[0].text as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const result: SSHExecuteResult = { stdout: '', stderr: '', exitCode: 0, truncated: false };
    // Разведка типа цели у установщика: по умолчанию путь свободен
    if (command.includes('SSH_MCP_KIND')) return { ...result, stdout: 'SSH_MCP_KIND_ABSENT\n' };
    return result;
  });
  passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, home: '/home/deploy' });
  uploadMock.mockResolvedValue(undefined);
});

describe('ssh_file_write: содержимое не проходит через shell', () => {
  it('текст уходит в stdin, а не в строку команды', async () => {
    await write({ path: '/etc/nginx/site.conf', content: 'server_name example;\n' });

    const command = writeCommand();
    expect(command).toBeDefined();
    expect(command!.stdin?.toString()).toBe('server_name example;\n');
    // Ни одна команда не несёт содержимого: разбирать его чужому shell нечего
    expect(sent().some((c) => c.command.includes('server_name'))).toBe(false);
    expect(sent().some((c) => c.command.includes('<<'))).toBe(false);
  });

  it('апостроф остаётся апострофом', async () => {
    await write({ path: '/srv/app.conf', content: "server_name don't-stop.example;\n" });

    expect(writeCommand()!.stdin?.toString()).toBe("server_name don't-stop.example;\n");
  });

  it('строка-разделитель внутри текста больше ничего не обрывает', async () => {
    const content = 'line1\nSSHEOF\nline2\n';

    await write({ path: '/srv/app.conf', content });

    expect(writeCommand()!.stdin?.toString()).toBe(content);
  });

  it('файл без завершающего перевода строки таким и остаётся', async () => {
    await write({ path: '/srv/key.pem', content: 'no trailing newline' });

    expect(writeCommand()!.stdin?.toString()).toBe('no trailing newline');
  });

  it('содержимое попадает во временный путь, а на место встаёт переименованием', async () => {
    await write({ path: '/etc/nginx/site.conf', content: 'x' });

    expect(writeCommand()!.command).toMatch(/^cat > '\/etc\/nginx\/\.upload-[0-9a-f]+\.site\.conf'$/);
    expect(sent().some((c) => /^mv -T --/.test(c.command))).toBe(true);
  });

  it('права применяются отдельной командой по временному пути, до замены', async () => {
    await write({ path: '/etc/nginx/site.conf', content: 'x', mode: '600' });

    const commands = sent().map((c) => c.command);
    const chmod = commands.findIndex((c) => c.startsWith('chmod '));
    const rename = commands.findIndex((c) => c.startsWith('mv -T --'));

    expect(chmod).toBeGreaterThanOrEqual(0);
    expect(commands[chmod]).toContain('.upload-');
    expect(chmod).toBeLessThan(rename);
    // Раньше chmod клеился к записи через `&&`: неудача прав выглядела как
    // неудача записи, хотя файл уже был на месте
    expect(commands.some((c) => c.includes('&&'))).toBe(false);
  });
});

describe('ssh_file_write: раскрытие пути', () => {
  it('тильда превращается в абсолютный путь из паспорта', async () => {
    await write({ path: '~/app/config.ini', content: 'x' });

    expect(writeCommand()!.command).toContain('/home/deploy/app/');
    const commands = sent().map((c) => c.command);
    expect(commands.some((c) => c.includes('~'))).toBe(false);
    expect(commands.some((c) => c.includes('$HOME'))).toBe(false);
  });

  it('под sudo тильда ведёт в дом логин-пользователя и об этом сказано в ответе', async () => {
    // Раньше её раскрывал сервер уже под sudo, то есть в /root. Молчать про
    // смену адреса нельзя — это другой файл
    const text = await write({ path: '~/app.conf', content: 'x', sudo: true });

    expect(writeCommand()!.command).toContain('/home/deploy/');
    expect(text).toContain('/home/deploy/app.conf');
  });

  it('неизвестный домашний каталог — отказ, а не запись наугад', async () => {
    passportMock.mockResolvedValue(UNKNOWN_PASSPORT);

    const text = await write({ path: '~/app.conf', content: 'x' });

    expect(text).toContain('Error');
    expect(text).toContain('absolute path');
    expect(writeCommand()).toBeUndefined();
  });

  it('чужой домашний каталог (`~user/`) — отказ: раскрыть его нам нечем', async () => {
    const text = await write({ path: '~postgres/data.conf', content: 'x' });

    expect(text).toContain('Error');
    expect(text).toContain('absolute path');
    expect(writeCommand()).toBeUndefined();
  });
});
