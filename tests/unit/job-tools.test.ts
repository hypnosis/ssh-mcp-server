/**
 * Unit tests: инструменты фоновой задачи.
 *
 * Сборка команд и разбор ответов проверяются своим файлом; здесь — что
 * инструмент спрашивает сервер о том, о чём его просили, и пересказывает ответ
 * не приукрашивая: «потеряна» остаётся потерянной, а нечего снимать — не отказ.
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

import type { JobsSummary } from '../../src/tools/job-output.js';

const { JobTools } = await import('../../src/tools/job-tools.js');
const { UNKNOWN_PASSPORT } = await import('../../src/runner/passport.js');

const JOB_ID = 'mst0f2q1-9ab3c4d5';

function call(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { params: { name, arguments: args } } as CallToolRequest;
}

/** Ответ сервера, как он выглядит на самом деле */
function serverAnswers(stdout: string, truncated = false) {
  executeMock.mockResolvedValue({ stdout, stderr: '', exitCode: 0, truncated });
}

const answerOf = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
  (await new JobTools().handleCall(call(name, { id: JOB_ID, ...args }))).content[0].text;

const sentCommand = (): string => String(executeMock.mock.calls[0]?.[1] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  passportMock.mockResolvedValue({ ...UNKNOWN_PASSPORT, known: true, home: '/home/deploy' });
  serverAnswers('');
});

describe('объявление инструментов', () => {
  it('четыре имени, и все требуют то, без чего не работают', () => {
    const tools = new JobTools().getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'ssh_job_status',
      'ssh_job_output',
      'ssh_job_list',
      'ssh_job_kill',
    ]);

    const required = Object.fromEntries(
      tools.map((tool) => [tool.name, (tool.inputSchema as { required?: string[] }).required])
    );
    expect(required.ssh_job_status).toEqual(['profile', 'id']);
    expect(required.ssh_job_output).toEqual(['profile', 'id']);
    expect(required.ssh_job_kill).toEqual(['profile', 'id']);
    // Списку идентификатор не нужен: он и есть способ узнать идентификаторы
    expect(required.ssh_job_list).toEqual(['profile']);
  });
});

describe('ssh_job_status', () => {
  it('работающая задача названа работающей', async () => {
    serverAnswers(
      'SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=128\nSSH_MCP_JOB_CMD\nsleep 120'
    );

    const text = await answerOf('ssh_job_status');

    expect(text).toContain(`Job ${JOB_ID}: still running`);
    expect(text).toContain('Pid: 4242');
    expect(text).toContain('Output: 128 bytes');
    expect(text).toContain('Command: sleep 120');
  });

  it('законченная задача отдаёт код возврата', async () => {
    serverAnswers('SSH_MCP_JOB alive=0 pid=4242 code=3 started=1755250000 size=10\nSSH_MCP_JOB_CMD\nfalse');

    const text = await answerOf('ssh_job_status');

    expect(text).toContain('finished');
    expect(text).toContain('Exit code: 3');
  });

  it('код сторожа сроков поясняется, а не остаётся голым числом', async () => {
    serverAnswers('SSH_MCP_JOB alive=0 pid=4242 code=143 started=1755250000 size=0\nSSH_MCP_JOB_CMD\nsleep 9');

    expect(await answerOf('ssh_job_status')).toContain('timeout guard');
  });

  it('потерянная задача не выдаётся ни за успех, ни за провал', async () => {
    serverAnswers('SSH_MCP_JOB alive=0 pid=4242 code= started=1755250000 size=7\nSSH_MCP_JOB_CMD\nsleep 120');

    const text = await answerOf('ssh_job_status');

    expect(text).toContain('not running and left no exit code');
    expect(text).not.toContain('finished');
  });

  it('несуществующая задача названа несуществующей', async () => {
    serverAnswers('SSH_MCP_JOB state=missing');

    const result = await new JobTools().handleCall(call('ssh_job_status', { id: JOB_ID }));

    expect(result.content[0].text).toContain('no such job');
    // Ответ о том, что задачи нет, — это ответ, а не сбой инструмента
    expect(result.isError).toBeUndefined();
    // И не выдуманные подробности о ней: печатать нечего
    expect(result.content[0].text).not.toContain('Started:');
    expect(result.content[0].text).not.toContain('Output:');
  });

  it('время старта печатается и человеку, и машиной', async () => {
    serverAnswers('SSH_MCP_JOB alive=1 pid=1 code= started=1755250000 size=0');

    const text = await answerOf('ssh_job_status');

    expect(text).toContain('2025-08-15T');
    expect(text).toContain('unix 1755250000');
  });

  it('чужой идентификатор отклоняется до отправки', async () => {
    const result = await new JobTools().handleCall(call('ssh_job_status', { id: '../../etc' }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid job id');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('идентификатор спрашивается, если его не дали вовсе', async () => {
    const result = await new JobTools().handleCall(call('ssh_job_status'));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id must be');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('каталог задачи строится от дома из паспорта', async () => {
    serverAnswers('SSH_MCP_JOB state=missing');

    await answerOf('ssh_job_status');

    expect(sentCommand()).toContain(`/home/deploy/.ssh-mcp/jobs/${JOB_ID}`);
  });
});

describe('ssh_job_output', () => {
  it('читает с названной позиции и говорит, откуда продолжать', async () => {
    serverAnswers('SSH_MCP_JOB size=40\nhello');

    const text = await answerOf('ssh_job_output', { offset: 35 });

    expect(sentCommand()).toContain('tail -c +36');
    expect(text).toContain('read 5 from offset 35');
    expect(text).toContain('Next offset: 40');
    expect(text).toContain('hello');
  });

  it('с начала — позиция по умолчанию', async () => {
    serverAnswers('SSH_MCP_JOB size=5\nhello');

    const text = await answerOf('ssh_job_output');

    expect(sentCommand()).toContain('tail -c +1');
    expect(text).toContain('Next offset: 5');
  });

  /**
   * Обрезанный буфером ответ — главная ловушка курсора: поставить следующую
   * позицию по размеру файла значит молча перескочить через непрочитанное.
   */
  it('обрезанный ответ двигает курсор на прочитанное, а не на размер файла', async () => {
    serverAnswers('SSH_MCP_JOB size=100000\nabc', true);

    const text = await answerOf('ssh_job_output', { offset: 10 });

    expect(text).toContain('Next offset: 13');
    expect(text).toContain('truncated');
  });

  it('позиция считается в байтах, а не в знаках', async () => {
    serverAnswers('SSH_MCP_JOB size=6\nдв');

    expect(await answerOf('ssh_job_output')).toContain('Next offset: 4');
  });

  it('пустое чтение названо пустым, а не выдано за вывод', async () => {
    serverAnswers('SSH_MCP_JOB size=40\n');

    const text = await answerOf('ssh_job_output', { offset: 40 });

    expect(text).toContain('(no output at this offset)');
    expect(text).toContain('Next offset: 40');
  });

  it('отрицательная позиция читается как начало файла — и курсор идёт от начала', async () => {
    serverAnswers('SSH_MCP_JOB size=5\nhello');

    const text = await answerOf('ssh_job_output', { offset: -100 });

    expect(sentCommand()).toContain('tail -c +1');
    // Иначе следующее чтение поехало бы от отрицательной позиции
    expect(text).toContain('Next offset: 5');
  });

  /**
   * Молчащая задача и выдуманный идентификатор до этого отвечали одинаково —
   * достаточно было перепутать профиль, чтобы принять одно за другое.
   */
  it('несуществующая задача названа несуществующей, а не пустым выводом', async () => {
    serverAnswers('SSH_MCP_JOB state=missing');

    const result = await new JobTools().handleCall(call('ssh_job_output', { id: JOB_ID }));

    expect(result.content[0].text).toContain('no such job');
    expect(result.content[0].text).not.toContain('no output at this offset');
    expect(result.content[0].text).not.toContain('Next offset');
    // Задачи нет — это ответ, а не сбой инструмента
    expect(result.isError).toBeUndefined();
  });
});

describe('ssh_job_list', () => {
  it('пустой сервер отвечает словами, а не пустотой', async () => {
    serverAnswers('');

    expect(await answerOf('ssh_job_list')).toContain('No background jobs');
  });

  it('перечисляет задачи с их исходами', async () => {
    serverAnswers(
      'SSH_MCP_JOB id=aaa alive=1 code= started=1755250000 size=12\n' +
        'SSH_MCP_JOB id=bbb alive=0 code=0 started=1755240000 size=3\n'
    );

    const text = await answerOf('ssh_job_list');

    expect(text).toContain('2 background job(s)');
    expect(text).toContain('aaa  running');
    expect(text).toContain('bbb  finished, exit 0');
  });

  it('убранные по сроку каталоги названы поимённо', async () => {
    serverAnswers('SSH_MCP_JOB_REMOVED id=old-one\nSSH_MCP_JOB id=aaa alive=1 code= started=1 size=0');

    const text = await answerOf('ssh_job_list');

    expect(text).toContain('Removed 1 finished job(s) older than 7 days: old-one');
  });

  it('спрашивает свой корень задач, а не чужой путь', async () => {
    await answerOf('ssh_job_list');

    expect(sentCommand()).toContain("root='/home/deploy/.ssh-mcp/jobs'");
  });

  it('идентификатора не требует', async () => {
    const result = await new JobTools().handleCall(call('ssh_job_list'));

    expect(result.isError).toBeUndefined();
    expect(executeMock).toHaveBeenCalled();
  });
});

describe('ssh_job_kill', () => {
  it('снятая задача названа снятой', async () => {
    serverAnswers('SSH_MCP_JOB killed=1');

    const text = await answerOf('ssh_job_kill');

    expect(text).toContain('TERM sent to its process group');
    expect(sentCommand()).toContain('kill -TERM');
  });

  it('второй сигнал доезжает как есть', async () => {
    serverAnswers('SSH_MCP_JOB killed=1');

    const text = await answerOf('ssh_job_kill', { signal: 'KILL' });

    expect(sentCommand()).toContain('kill -KILL');
    expect(text).toContain('KILL sent');
  });

  it('чужая строка сигналом не становится', async () => {
    serverAnswers('SSH_MCP_JOB killed=1');

    await answerOf('ssh_job_kill', { signal: 'TERM; touch /tmp/pwned' });

    expect(sentCommand()).toContain('kill -TERM');
    expect(sentCommand()).not.toContain('pwned');
  });

  it('уже законченная задача — сообщение, а не отказ', async () => {
    serverAnswers('SSH_MCP_JOB killed=0 reason=gone');

    const result = await new JobTools().handleCall(call('ssh_job_kill', { id: JOB_ID }));

    expect(result.content[0].text).toContain('already gone');
    expect(result.isError).toBeUndefined();
  });

  it('задача без записанного pid названа своим случаем', async () => {
    serverAnswers('SSH_MCP_JOB killed=0 reason=nopid');

    const text = await answerOf('ssh_job_kill');

    expect(text).toContain('never recorded a pid');
    // Причина не про отсутствие задачи: каталог на месте, pid не записан
    expect(text).not.toContain('no such job');
  });

  it('несуществующая задача названа несуществующей, а не задачей без pid', async () => {
    serverAnswers('SSH_MCP_JOB killed=0 reason=missing');

    const result = await new JobTools().handleCall(call('ssh_job_kill', { id: JOB_ID }));

    expect(result.content[0].text).toContain('no such job');
    expect(result.content[0].text).not.toContain('never recorded a pid');
    expect(result.isError).toBeUndefined();
  });

  it('молчание сервера не выдаётся за снятие', async () => {
    serverAnswers('');

    const text = await answerOf('ssh_job_kill');

    expect(text).toContain('did not answer');
    expect(text).not.toContain('sent to its process group');
  });
});

/**
 * Сводка рядом с текстом ответа о задаче.
 *
 * Состояний четыре, и различать `lost` (работа пропала, кода нет) от `missing`
 * (такой задачи на сервере нет) приходилось по формулировке фразы. Полем они
 * названы теми же словами, что и в коде.
 */
describe('сводка задач', () => {
  async function summaryOf(name: string, args: Record<string, unknown> = {}): Promise<JobsSummary> {
    const response = await new JobTools().handleCall(call(name, { id: JOB_ID, ...args }));
    return response.structuredContent as JobsSummary;
  }

  it.each([
    ['running', 'SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=0'],
    ['finished', 'SSH_MCP_JOB alive=0 pid=4242 code=3 started=1755250000 size=0'],
    ['lost', 'SSH_MCP_JOB alive=0 pid=4242 code= started=1755250000 size=0'],
    ['missing', 'SSH_MCP_JOB state=missing'],
  ])('состояние %s приходит полем, а не фразой', async (state, stdout) => {
    serverAnswers(stdout);

    expect((await summaryOf('ssh_job_status')).jobs[0].state).toBe(state);
  });

  it('код есть у завершившейся задачи', async () => {
    serverAnswers('SSH_MCP_JOB alive=0 pid=4242 code=3 started=1755250000 size=0');

    expect((await summaryOf('ssh_job_status')).jobs[0].exit_code).toBe(3);
  });

  /** У потерянной работы кода нет вовсе — ноль на его месте был бы выдумкой */
  it.each([
    ['lost', 'SSH_MCP_JOB alive=0 pid=4242 code= started=1755250000 size=0'],
    ['running', 'SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=0'],
  ])('у состояния %s кода нет', async (_state, stdout) => {
    serverAnswers(stdout);

    expect((await summaryOf('ssh_job_status')).jobs[0].exit_code).toBeNull();
  });

  it('идентификатор, pid и время старта доезжают как есть', async () => {
    serverAnswers('SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=0');

    expect((await summaryOf('ssh_job_status')).jobs[0]).toMatchObject({
      id: JOB_ID,
      pid: 4242,
      started_at: 1755250000,
    });
  });

  it('неизвестный pid приходит пустотой, а не нулём', async () => {
    serverAnswers('SSH_MCP_JOB state=missing');

    expect((await summaryOf('ssh_job_status')).jobs[0].pid).toBeNull();
  });

  it('форма одна и та же: у одной задачи — тоже список', async () => {
    serverAnswers('SSH_MCP_JOB alive=1 pid=1 code= started=1 size=0');

    expect((await summaryOf('ssh_job_status')).jobs).toHaveLength(1);
  });

  it('список задач приходит записью на каждую, в порядке ответа сервера', async () => {
    serverAnswers(
      'SSH_MCP_JOB id=aaa alive=1 code= started=1755250000 size=12\n' +
        'SSH_MCP_JOB id=bbb alive=0 code=0 started=1755240000 size=3\n'
    );

    const { jobs } = await summaryOf('ssh_job_list');

    expect(jobs.map((job) => job.id)).toEqual(['aaa', 'bbb']);
    expect(jobs.map((job) => job.state)).toEqual(['running', 'finished']);
    expect(jobs.map((job) => job.exit_code)).toEqual([null, 0]);
  });

  it('пустой сервер отвечает пустым списком, а не отсутствием сводки', async () => {
    serverAnswers('');

    expect((await summaryOf('ssh_job_list')).jobs).toEqual([]);
  });
});

/**
 * Легенда: слова состояний расшифрованы в самом ответе.
 *
 * `lost` и `missing` различаются последствиями, а на вид — ничем; читатель
 * ответа не обязан помнить объявление инструмента, чтобы их развести.
 */
describe('легенда задач', () => {
  async function legendOf(name: string, args: Record<string, unknown> = {}): Promise<JobsSummary['legend']> {
    const response = await new JobTools().handleCall(call(name, { id: JOB_ID, ...args }));
    return (response.structuredContent as JobsSummary).legend;
  }

  it.each([
    ['running', 'SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=0', 'still running'],
    ['finished', 'SSH_MCP_JOB alive=0 pid=4242 code=3 started=1755250000 size=0', 'reported its exit code'],
    ['lost', 'SSH_MCP_JOB alive=0 pid=4242 code= started=1755250000 size=0', 'left no exit code'],
    ['missing', 'SSH_MCP_JOB state=missing', 'knows no job'],
  ])('%s объясняется словами, а не оставляется на догадку', async (state, stdout, meaning) => {
    serverAnswers(stdout);

    expect((await legendOf('ssh_job_status'))[`jobs[].state=${state}`]).toContain(meaning);
  });

  it('ключ называет поле внутри списка, а не голое слово', async () => {
    serverAnswers('SSH_MCP_JOB alive=1 pid=4242 code= started=1755250000 size=0');

    expect(Object.keys(await legendOf('ssh_job_status'))).toEqual(['jobs[].state=running']);
  });

  /**
   * Тридцать задач в двух состояниях — две расшифровки, а не тридцать: иначе
   * легенда растёт вместе со списком и перестаёт читаться.
   */
  it('повторяющееся состояние объясняется один раз', async () => {
    serverAnswers(
      'SSH_MCP_JOB id=aaa alive=1 code= started=1755250000 size=0\n' +
        'SSH_MCP_JOB id=bbb alive=1 code= started=1755240000 size=0\n' +
        'SSH_MCP_JOB id=ccc alive=0 code=0 started=1755230000 size=0\n'
    );

    expect(Object.keys(await legendOf('ssh_job_list')).sort()).toEqual([
      'jobs[].state=finished',
      'jobs[].state=running',
    ]);
  });

  it('пустой список задач приносит пустую легенду, а не отсутствие поля', async () => {
    serverAnswers('');

    expect(await legendOf('ssh_job_list')).toEqual({});
  });
});
