/**
 * Фоновая задача на живом сервере: запуск переживает вызов.
 *
 * Проверяется состояние сервера, а не текст ответа: сколько времени занял
 * запуск, что лежит в каталоге задачи и жив ли процесс. Ответ инструмента
 * рапортует и о невыполненной работе, поэтому доказательством не служит.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/**
 * Запуск обязан уложиться заметно быстрее самой команды: она идёт 40 секунд,
 * и всё, что дольше нескольких секунд, означает «ждём её конца».
 */
const START_BUDGET_MS = 10_000;
const LONG_COMMAND_SEC = 40;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'jobs-live-'));

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    default: LAB_SERVERS[0].name,
    profiles: Object.fromEntries(
      LAB_SERVERS.map((server) => [
        server.name,
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'root',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        },
      ])
    ),
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');
const { createMcpServer } = await import('../../src/mcp-server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Свежий MCP-сервер с новым клиентом: всё, что инструмент помнил в памяти,
 * этой заменой теряется. Состояние задачи обязано пережить её.
 */
async function freshClient(): Promise<{ text: (name: string, args: object) => Promise<string>; close: () => Promise<void> }> {
  const { server } = createMcpServer('live-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'jobs-live', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    text: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args as never })) as {
        content: Array<{ text: string }>;
      };
      return result.content[0].text;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

if (unavailable && LAB_REQUIRED) {
  describe('живые фоновые задачи', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живые фоновые задачи — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Фоновая задача: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const exec = new ExecTool();
      const executor = new SSHExecutor();

      const jobsRoot = '/root/.ssh-mcp/jobs';
      const playground = `/tmp/jobs-${server.port}`;

      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const onServer = async (command: string): Promise<string> =>
        (await executor.execute(config, command)).stdout;

      const run = (args: Record<string, unknown>) =>
        exec.handleCall({
          params: { name: 'ssh_exec', arguments: { profile: server.name, ...args } },
        } as never);

      const answerOf = async (args: Record<string, unknown>): Promise<string> =>
        (await run(args)).content[0].text;

      const jobIdOf = (answer: string): string => {
        const id = answer.match(/Job (\S+) started/)?.[1];
        if (!id) throw new Error(`ответ не назвал задачу: ${answer}`);
        return id;
      };

      /** Сколько каталогов задач лежит на сервере */
      const jobCount = async (): Promise<number> =>
        Number((await onServer(`ls -1 ${jobsRoot} 2>/dev/null | wc -l`)).trim());

      /**
       * Живые процессы по образцу. Только `-o args=`: обычный `ps -A` печатает
       * имя без аргументов, и счёт молча даёт ноль. Первая буква образца взята
       * в скобки, иначе сам `grep` попадает в собственный счёт.
       */
      const alive = async (needle: string): Promise<number> =>
        Number(
          (
            await onServer(
              `ps -A -o args= 2>/dev/null | grep -c '[${needle[0]}]${needle.slice(1)}' || true`
            )
          ).trim()
        );

      const waitUntil = async (check: () => Promise<boolean>, limitMs = 15_000): Promise<boolean> => {
        const deadline = Date.now() + limitMs;
        while (Date.now() < deadline) {
          if (await check()) return true;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return false;
      };

      beforeAll(async () => {
        await onServer(`rm -rf /root/.ssh-mcp ${playground} && mkdir -p ${playground}`);
      });

      afterAll(async () => {
        // Сначала снимаем всё запущенное, потом убираем следы: наоборот — и
        // задача переживёт уборку, потеряв каталог
        await onServer(
          `for d in ${jobsRoot}/*; do kill -KILL -"$(cat "$d/pid" 2>/dev/null)" 2>/dev/null; done; ` +
            `rm -rf /root/.ssh-mcp ${playground}`
        ).catch(() => undefined);
        await closeAllRunners();
      });

      it('долгая команда отдаёт идентификатор сразу, а не через свой срок', async () => {
        const startedAt = Date.now();
        const answer = await answerOf({
          command: `sleep ${LONG_COMMAND_SEC} && echo done`,
          detach: true,
        });
        const elapsed = Date.now() - startedAt;

        const id = jobIdOf(answer);
        expect(elapsed).toBeLessThan(START_BUDGET_MS);

        // Протокол на диске: всё, чем задачу потом найдут
        const files = (await onServer(`ls -1 ${jobsRoot}/${id}`)).trim().split('\n').sort();
        expect(files).toEqual(['cmd', 'output.log', 'pid', 'started']);

        const pid = (await onServer(`cat ${jobsRoot}/${id}/pid`)).trim();
        expect(pid).toMatch(/^\d+$/);
        expect(answer).toContain(`pid ${pid}`);

        // Команда действительно работает, а не только записана
        expect(await alive(`sleep ${LONG_COMMAND_SEC}`)).toBeGreaterThan(0);

        await onServer(`kill -KILL -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`);
      });

      it('задача переживает закрытие соединения, которым её запустили', async () => {
        const id = jobIdOf(
          await answerOf({ command: `sleep ${LONG_COMMAND_SEC} && echo done`, detach: true })
        );
        const pid = (await onServer(`cat ${jobsRoot}/${id}/pid`)).trim();

        await closeAllRunners();
        // Новое соединение — прежний процесс на сервере
        expect((await onServer(`kill -0 ${pid} 2>/dev/null && echo YES || echo NO`)).trim()).toBe(
          'YES'
        );

        await onServer(`kill -KILL -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`);
      });

      /**
       * Команда доезжает буквой в букву: она уезжает внутрь `sh -c` и оттуда
       * ещё раз в `sh -c` задачи, то есть закавычивается дважды.
       */
      it('команда с апострофом, пробелом, подстановкой и переводом строки доезжает целой', async () => {
        const dir = `${playground}/quoting`;
        const jobCommand =
          `mkdir -p '${dir}' && ` +
          `printf '%s' one > "${dir}/it's a file.txt" && ` +
          `printf '%s' two > "${dir}/$(echo made).txt" && ` +
          `printf '%s' three > '${dir}/tilde~.txt' && ` +
          `printf '%s' four > '${dir}/star*.txt' && ` +
          `printf '%s' five > '${dir}/back\\slash.txt'\n` +
          `printf '%s' six > '${dir}/second line.txt'`;

        const id = jobIdOf(await answerOf({ command: jobCommand, detach: true }));

        const expected = [
          'back\\slash.txt',
          'it\'s a file.txt',
          'made.txt',
          'second line.txt',
          'star*.txt',
          'tilde~.txt',
        ];

        // `find` печатает путь целиком: `-printf` есть не у всех диалектов
        const namesOnServer = async (): Promise<string[]> =>
          (await onServer(`find '${dir}' -type f 2>/dev/null`))
            .split('\n')
            .map((line) => line.replace(`${dir}/`, '').trim())
            .filter(Boolean)
            .sort();

        expect(await waitUntil(async () => (await namesOnServer()).length >= expected.length)).toBe(
          true
        );
        expect(await namesOnServer()).toEqual(expected);

        // Записанная команда — та же строка, а не её пересказ
        expect(await onServer(`cat ${jobsRoot}/${id}/cmd`)).toBe(jobCommand);
      });

      it('вывод задачи собирается в один файл — и stdout, и stderr', async () => {
        const id = jobIdOf(
          await answerOf({ command: 'echo out; echo err >&2; exit 3', detach: true })
        );

        expect(
          await waitUntil(async () =>
            (await onServer(`cat ${jobsRoot}/${id}/exit_code 2>/dev/null`)).trim() === '3'
          )
        ).toBe(true);

        const output = await onServer(`cat ${jobsRoot}/${id}/output.log`);
        expect(output).toContain('out');
        expect(output).toContain('err');
      });

      it('рабочий каталог достаётся команде задачи', async () => {
        const id = jobIdOf(await answerOf({ command: 'pwd', detach: true, cwd: playground }));

        expect(
          await waitUntil(async () =>
            (await onServer(`cat ${jobsRoot}/${id}/output.log 2>/dev/null`)).includes(playground)
          )
        ).toBe(true);
      });

      /**
       * Полный круг через настоящего MCP-клиента: между запуском и наблюдением
       * процесс сервера заменяется целиком. Если бы состояние жило в памяти,
       * задача после замены перестала бы находиться.
       */
      it('задача переживает замену процесса MCP-сервера и снимается по идентификатору', async () => {
        const first = await freshClient();
        const answer = await first.text('ssh_exec', {
          profile: server.name,
          command: 'for i in 1 2 3 4 5 6 7 8; do echo line-$i; sleep 2; done',
          detach: true,
        });
        const id = jobIdOf(answer);
        await first.close();
        await closeAllRunners();

        const second = await freshClient();

        const status = await second.text('ssh_job_status', { profile: server.name, id });
        expect(status).toContain('still running');
        expect(status).toContain('Command: for i in 1 2 3 4 5 6 7 8');

        // Первое чтение: сколько-то строк и позиция, с которой продолжать
        expect(
          await waitUntil(async () =>
            (await second.text('ssh_job_output', { profile: server.name, id })).includes('line-1')
          )
        ).toBe(true);

        const firstRead = await second.text('ssh_job_output', { profile: server.name, id });
        const cursor = Number(firstRead.match(/Next offset: (\d+)/)?.[1]);
        expect(cursor).toBeGreaterThan(0);

        // Второе чтение с той же позиции: только то, чего не было в первом
        expect(
          await waitUntil(async () =>
            (
              await second.text('ssh_job_output', { profile: server.name, id, offset: cursor })
            ).includes('line-')
          )
        ).toBe(true);

        const secondRead = await second.text('ssh_job_output', {
          profile: server.name,
          id,
          offset: cursor,
        });

        const linesOf = (text: string): string[] =>
          text.split('\n').filter((line) => /^line-\d+$/.test(line));
        const firstLines = linesOf(firstRead);
        const secondLines = linesOf(secondRead);

        expect(firstLines[0]).toBe('line-1');
        expect(secondLines.length).toBeGreaterThan(0);
        // Ни нахлёста, ни пропуска: вторая порция продолжает первую
        expect(firstLines.filter((line) => secondLines.includes(line))).toEqual([]);
        expect(secondLines[0]).toBe(`line-${firstLines.length + 1}`);

        // Снятие проверяется процессами на сервере, а не текстом ответа
        const pid = (await onServer(`cat ${jobsRoot}/${id}/pid`)).trim();
        expect(await second.text('ssh_job_kill', { profile: server.name, id })).toContain(
          'TERM sent'
        );
        expect(
          await waitUntil(async () =>
            (await onServer(`kill -0 ${pid} 2>/dev/null && echo YES || echo NO`)).trim() === 'NO'
          )
        ).toBe(true);
        expect(await alive('sleep 2')).toBe(0);

        // Снятая задача кода возврата не оставляет — и это не выдаётся за успех
        const after = await second.text('ssh_job_status', { profile: server.name, id });
        expect(after).toContain('not running and left no exit code');
        expect(after).not.toContain('finished');

        // Повторное снятие — сообщение, а не отказ
        expect(await second.text('ssh_job_kill', { profile: server.name, id })).toContain(
          'already gone'
        );

        const list = await second.text('ssh_job_list', { profile: server.name });
        expect(list).toContain(id);

        await second.close();
      });

      it('несуществующая задача названа несуществующей, а не выдумана', async () => {
        const client = await freshClient();

        const status = await client.text('ssh_job_status', {
          profile: server.name,
          id: 'no-such-job-0000',
        });

        expect(status).toContain('no such job');
        await client.close();
      });

      describe('отказы: ничего не запускается', () => {
        it('вместе с sudo', async () => {
          const before = await jobCount();
          const result = await run({ command: 'sleep 5', detach: true, sudo: true });

          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('cannot be combined with sudo');
          expect(await jobCount()).toBe(before);
        });

        it('с несколькими командами', async () => {
          const before = await jobCount();
          const result = await run({ command: ['sleep 5', 'echo done'], detach: true });

          expect(result.isError).toBe(true);
          expect(await jobCount()).toBe(before);
        });

        it('снос корня — сторож удаления работает и на этом пути', async () => {
          const before = await jobCount();
          const result = await run({ command: 'rm -rf /', detach: true });

          expect(result.content[0].text).toContain('BLOCKED');
          expect(await jobCount()).toBe(before);
        });
      });
    });
  }
}
