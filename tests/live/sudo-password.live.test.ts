/**
 * Пароль для `sudo` живьём: профиль входит по ключу, а права даются за пароль.
 *
 * Это третья группа профилей — та, у которой пароля входа нет вовсе, и до
 * `sudoPassword` ей нечем было ответить на запрос прав. Проверяется состояние
 * сервера отдельным входом под root: появился ли файл в закрытом каталоге и кому
 * он принадлежит. Ответ инструмента доказательством не служит — он рапортует и о
 * невыполненной работе.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LAB_CONTROL_DIR,
  LAB_KEY,
  LAB_PASSWORD,
  LAB_REQUIRED,
  LAB_SERVERS,
  labUnavailableReason,
} from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'sudo-password-'));

/**
 * Два профиля на каждую машину, различающиеся одним полем: у одного пароль для
 * `sudo` есть, у другого нет. Оба входят по ключу под `keyuser`.
 */
const profilesPath = join(workDir, 'profiles.json');
const withPassword = (port: number) => `pw-${port}`;
const withoutPassword = (port: number) => `nopw-${port}`;

await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries(
      LAB_SERVERS.flatMap((server) => {
        const base = {
          host: '127.0.0.1',
          port: server.port,
          username: 'keyuser',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        };
        return [
          [withPassword(server.port), { ...base, sudoPassword: LAB_PASSWORD }],
          [withoutPassword(server.port), base],
        ];
      })
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
  describe('живой пароль для sudo', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой пароль для sudo — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Пароль для sudo: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const exec = new ExecTool();
      const jobs = new JobTools();
      const executor = new SSHExecutor();

      /** Каталог принадлежит root и закрыт для записи пользователю профиля */
      const guarded = `/root/sudo-pw-${server.port}`;

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

      const answerOf = async (
        profile: string,
        args: Record<string, unknown>
      ): Promise<string> => {
        const result = (await exec.handleCall({
          params: { name: 'ssh_exec', arguments: { profile, ...args } },
        } as never)) as { content: Array<{ text: string }> };
        return result.content[0].text;
      };

      const jobFieldsOf = async (
        profile: string,
        id: string
      ): Promise<Record<string, any>> =>
        (
          (await jobs.handleCall({
            params: { name: 'ssh_job_status', arguments: { profile, id } },
          } as never)) as { structuredContent: Record<string, any> }
        ).structuredContent;

      /** Есть ли файл на сервере и кому он принадлежит — по данным самого сервера */
      const ownerOf = async (path: string): Promise<string> =>
        await asRoot(`ls -ld ${path} 2>/dev/null | awk '{print $3}'`);

      beforeAll(async () => {
        await asRoot(`rm -rf ${guarded} /home/keyuser/.ssh-mcp && mkdir -p ${guarded}`);
      });

      afterAll(async () => {
        await asRoot(
          `for d in /home/keyuser/.ssh-mcp/jobs/*; do kill -KILL -"$(cat "$d/pid" 2>/dev/null)" 2>/dev/null; done; ` +
            `rm -rf ${guarded} /home/keyuser/.ssh-mcp`
        ).catch(() => undefined);
        await closeAllRunners();
      });

      it('с ним команда доходит до закрытого каталога', async () => {
        const target = `${guarded}/written-by-sudo`;

        await answerOf(withPassword(server.port), {
          command: `touch ${target}`,
          sudo: true,
        });

        expect(await ownerOf(target)).toBe('root');
      });

      it('без него в тот же каталог не попадает ничего', async () => {
        const target = `${guarded}/written-without-password`;

        const answer = await answerOf(withoutPassword(server.port), {
          command: `touch ${target}`,
          sudo: true,
        });

        expect(await ownerOf(target)).toBe('');
        expect(answer).toContain('this profile has none to give');
      });

      it('сам пароль в ответе не появляется', async () => {
        const answer = await answerOf(withPassword(server.port), {
          command: 'id -un',
          sudo: true,
        });

        expect(answer).toContain('root');
        expect(answer).not.toContain(LAB_PASSWORD);
      });

      it('фоновая задача с ним запускается под root', async () => {
        const answer = await answerOf(withPassword(server.port), {
          command: 'sleep 30',
          detach: true,
          sudo: true,
        });

        const id = answer.match(/Job (\S+) started/)?.[1];
        expect(id).toBeTruthy();
        expect(await ownerOf(`/home/keyuser/.ssh-mcp/jobs/${id}`)).toBe('root');

        const status = await jobFieldsOf(withPassword(server.port), id!);
        expect(status.jobs[0].state).toBe('running');
      });

      it('а без него не запускается вовсе', async () => {
        const before = await asRoot(
          'ls -1 /home/keyuser/.ssh-mcp/jobs 2>/dev/null | wc -l'
        );

        const answer = await answerOf(withoutPassword(server.port), {
          command: 'sleep 30',
          detach: true,
          sudo: true,
        });

        expect(answer).toContain('The job was not started');
        expect(await asRoot('ls -1 /home/keyuser/.ssh-mcp/jobs 2>/dev/null | wc -l')).toBe(before);
      });
    });
  }
}
