/**
 * Фоновая задача под повышением прав: запуск и весь опрос идут как root.
 *
 * Профиль входит непривилегированным `deploy`, которому `sudo` разрешён без
 * пароля. Проверяется состояние сервера отдельным входом под root: кому
 * принадлежит каталог задачи, жив ли процесс, исчез ли он после снятия. Текст
 * ответа доказательством не служит — он рапортует и о несделанной работе.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/** Команда живёт дольше любого вызова: пока она идёт, задачу есть о чём спрашивать */
const LONG_COMMAND_SEC = 40;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'job-root-'));

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries(
      LAB_SERVERS.map((server) => [
        server.name,
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'deploy',
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
const { JobTools } = await import('../../src/tools/job-tools.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живая задача под root', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живая задача под root — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Задача под root: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const exec = new ExecTool();
      const jobs = new JobTools();
      const executor = new SSHExecutor();

      const jobsRoot = '/home/deploy/.ssh-mcp/jobs';

      /** Отдельный вход под root — только чтобы готовить сцену и сверять результат */
      const rootConfig = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const asRoot = async (command: string): Promise<string> =>
        (await executor.execute(rootConfig, command)).stdout.trim();

      const call = async (name: string, args: Record<string, unknown>) => {
        const request = { params: { name, arguments: { profile: server.name, ...args } } };
        return name === 'ssh_exec'
          ? await exec.handleCall(request as never)
          : await jobs.handleCall(request as never);
      };

      const textOf = async (name: string, args: Record<string, unknown>): Promise<string> =>
        ((await call(name, args)) as { content: Array<{ text: string }> }).content[0].text;

      const fieldsOf = async (
        name: string,
        args: Record<string, unknown>
      ): Promise<Record<string, any>> =>
        ((await call(name, args)) as { structuredContent: Record<string, any> }).structuredContent;

      /** Задача, которая переживёт вызов: имя того, кто её выполняет, уходит в вывод */
      const startJob = async (sudo: boolean): Promise<string> => {
        const answer = await textOf('ssh_exec', {
          command: `id -un; sleep ${LONG_COMMAND_SEC}`,
          detach: true,
          sudo,
        });
        const id = answer.match(/Job (\S+) started/)?.[1];
        if (!id) throw new Error(`ответ не назвал задачу: ${answer}`);
        return id;
      };

      /** Владелец каталога задачи по данным сервера, а не по ответу инструмента */
      const ownerOf = async (id: string): Promise<string> =>
        await asRoot(`ls -ld ${jobsRoot}/${id} | awk '{print $3}'`);

      const processAlive = async (id: string): Promise<boolean> => {
        const pid = await asRoot(`cat ${jobsRoot}/${id}/pid 2>/dev/null || true`);
        if (!pid) return false;
        return (await asRoot(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)) === 'yes';
      };

      const waitUntil = async (check: () => Promise<boolean>, limitMs = 15_000): Promise<boolean> => {
        const deadline = Date.now() + limitMs;
        while (Date.now() < deadline) {
          if (await check()) return true;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return false;
      };

      const wipe = async (): Promise<void> => {
        await asRoot(
          `for d in ${jobsRoot}/*; do kill -KILL -"$(cat "$d/pid" 2>/dev/null)" 2>/dev/null; done; ` +
            `rm -rf /home/deploy/.ssh-mcp`
        ).catch(() => undefined);
      };

      beforeAll(wipe);

      afterAll(async () => {
        await wipe();
        await closeAllRunners();
      });

      it('запускается и работает от имени root', async () => {
        const id = await startJob(true);

        expect(id.startsWith('root-')).toBe(true);
        expect(await ownerOf(id)).toBe('root');
        expect(await processAlive(id)).toBe(true);

        // Кто выполняет команду, знает она сама — читаем её вывод с диска
        const said = await waitUntil(
          async () => (await asRoot(`cat ${jobsRoot}/${id}/output.log`)).trim() === 'root'
        );
        expect(said).toBe(true);
      });

      it('корень каталога задач остаётся пользовательским', async () => {
        await startJob(true);

        // Первая задача под root не должна забрать общий корень себе: иначе
        // обычной задаче некуда будет писать
        expect(await asRoot(`ls -ld ${jobsRoot} | awk '{print $3}'`)).toBe('deploy');

        const plain = await startJob(false);
        expect(plain.startsWith('root-')).toBe(false);
        expect(await processAlive(plain)).toBe(true);
      });

      it('статус называет её живой, а не потерянной', async () => {
        const id = await startJob(true);

        const summary = await fieldsOf('ssh_job_status', { id });
        expect(summary.jobs[0].id).toBe(id);
        expect(summary.jobs[0].state).toBe('running');
      });

      it('вывод читается тем же путём', async () => {
        const id = await startJob(true);
        await waitUntil(async () => (await asRoot(`cat ${jobsRoot}/${id}/output.log`)).trim() === 'root');

        const answer = await textOf('ssh_job_output', { id, offset: 0 });
        expect(answer).toContain('root');
      });

      it('список показывает её вместе с обычными', async () => {
        const elevated = await startJob(true);
        const plain = await startJob(false);

        const summary = await fieldsOf('ssh_job_list', {});
        const state = (id: string) =>
          summary.jobs.find((job: { id: string }) => job.id === id)?.state;

        // Состояние, а не одно имя: без второго прохода под root список видит
        // каталог задачи, но не её процесс, и живая работа читается как потерянная
        expect(state(elevated)).toBe('running');
        expect(state(plain)).toBe('running');
      });

      it('снятие доходит до чужого процесса', async () => {
        const id = await startJob(true);
        expect(await processAlive(id)).toBe(true);

        const summary = await fieldsOf('ssh_job_kill', { id });
        expect(summary.outcome).toBe('signalled');

        expect(await waitUntil(async () => !(await processAlive(id)))).toBe(true);
      });
    });
  }
}
