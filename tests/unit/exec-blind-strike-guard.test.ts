/**
 * Unit tests: врезка показа цели в ssh_exec
 *
 * Разбор команды, поход за списком и текст отказа проверяются своими файлами.
 * Здесь — только соединение: удар не уходит на сервер, показ уходит вместо
 * него, а подтверждение с верными именами удар пропускает.
 *
 * Проверяется не «был ли отказ», а что именно доехало до транспорта: отказ,
 * после которого команда всё же ушла, — худший исход из возможных.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { executeMock, passportMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passportMock: vi.fn(),
}));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    DEFAULT_TIMEOUT_MS: actual.DEFAULT_TIMEOUT_MS,
    SSHExecutor: class {
      execute = executeMock;
      passport = passportMock;
    },
  };
});

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');
const { KILL_MARKER } = await import('../../src/utils/strike-refusal.js');

/** Ответ машины на вопрос о целях: один контейнер и один процесс */
const PREVIEW =
  '@@CLK\n100\n' +
  '@@UPTIME\n1000000 1000000\n' +
  '@@NET\n   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555 1\n' +
  '@@CONTAINERS docker\nabc123|edge|web:latest|Up 34 days|0.0.0.0:8443->8443/tcp\n' +
  '@@STRIKE 0\nabc123\n' +
  '@@PROCS 0\n#4871 100 /opt/app/relay\n555\n';

const call = (command: string): CallToolRequest =>
  ({ params: { name: 'ssh_exec', arguments: { command } } } as CallToolRequest);

/** Что ушло в транспорт, кроме вопроса о целях */
const sentCommands = (): string[] =>
  executeMock.mock.calls.map((args) => String(args[1])).filter((command) => !command.includes('@@CLK'));

/** Ушёл ли вопрос о целях */
const asked = (): boolean =>
  executeMock.mock.calls.some((args) => String(args[1]).includes('@@CLK'));

beforeEach(() => {
  executeMock.mockReset();
  passportMock.mockReset();
  passportMock.mockResolvedValue(UNKNOWN_PASSPORT);
  executeMock.mockImplementation(async (_config: unknown, command: string) =>
    command.includes('@@CLK')
      ? { stdout: PREVIEW, stderr: '', exitCode: 0, truncated: false }
      : { stdout: 'done', stderr: '', exitCode: 0, truncated: false }
  );
});

const answer = async (command: string): Promise<string> => {
  const result = await new ExecTool().handleCall(call(command));
  return String((result.content as { text: string }[])[0].text);
};

describe('удар вслепую до сервера не доходит', () => {
  it('команда не отправлена, а цель показана', async () => {
    const text = await answer('docker kill $(docker ps -q --filter ancestor=web)');

    expect(sentCommands()).toEqual([]);
    expect(asked()).toBe(true);
    expect(text).toContain('edge');
    expect(text).toContain('Up 34 days');
  });

  it('соседние команды вызова тоже не уходят', async () => {
    await answer('kill $(pgrep -f relay)');

    expect(sentCommands()).toEqual([]);
  });
});

describe('чем и с какими правами спрашивают', () => {
  it('о целях спрашивают с теми же правами, с какими шёл бы удар', async () => {
    await new ExecTool().handleCall({
      params: { name: 'ssh_exec', arguments: { command: 'kill $(pgrep -f relay)', sudo: true } },
    } as CallToolRequest);

    const question = executeMock.mock.calls.find((args) => String(args[1]).includes('@@CLK'));
    expect(question?.[2]).toMatchObject({ sudo: true });
  });

  // Отказ уже говорит всё сам; чужая обёртка предложила бы не тот маркер
  it('отказ не заворачивается в общий маркер', async () => {
    const text = await answer('docker kill $(docker ps -q --filter ancestor=web)');

    expect(text).not.toContain('CONFIRMED-DESTRUCTIVE');
    expect(text).toContain(KILL_MARKER);
  });
});

describe('названная цель платит только за себя', () => {
  it('о целях не спрашивают, команда уходит как была', async () => {
    await answer('docker kill edge');

    expect(asked()).toBe(false);
    expect(sentCommands()).toEqual(['docker kill edge']);
  });
});

describe('подтверждение сверяется, а не принимается на слово', () => {
  it('имена сошлись — удар уходит', async () => {
    const command = `docker kill $(docker ps -q --filter ancestor=web) ${KILL_MARKER} edge`;
    await answer(command);

    expect(sentCommands()).toEqual([command]);
  });

  it('имя не то — удар не уходит', async () => {
    const text = await answer(`docker kill $(docker ps -q --filter ancestor=web) ${KILL_MARKER} api`);

    expect(sentCommands()).toEqual([]);
    expect(text).toContain('not named: edge');
  });

  // Та же строка, отправленная второй раз, — это не согласие, а повтор
  it('повтор без имён проходит не больше первого раза', async () => {
    await answer('docker kill $(docker ps -q --filter ancestor=web)');
    await answer('docker kill $(docker ps -q --filter ancestor=web)');

    expect(sentCommands()).toEqual([]);
  });
});
