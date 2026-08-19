/**
 * Живая проверка: закрытое правами называется, а не выпадает молча.
 *
 * Юнит здесь доказывает мало. Жалобу пишет сама утилита сервера, и пишет
 * по-разному: coreutils берёт имя в кавычки, BusyBox — нет, а `du` вдобавок
 * прячет имя внутрь собственных слов. Разбор жалобы идёт по строке, поэтому
 * настоящий текст с настоящей машины — единственное доказательство.
 *
 * Профиль ходит под `deploy`: у него есть NOPASSWD-sudo и нет прав на цель.
 * Под root закрытых каталогов не бывает, и вся проверка стала бы зелёной сама
 * по себе.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'permission-honesty-'));

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

const { LogTools } = await import('../../src/tools/log-tools.js');
const { AuditTool } = await import('../../src/tools/audit-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живая честность про права', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живая честность про права — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Закрытое правами: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const logs = new LogTools();
      const audit = new AuditTool();
      const executor = new SSHExecutor();

      const root = `/opt/perm-live-${server.port}`;
      const openLog = `${root}/open/app.log`;
      const closedLog = `${root}/closed/secret.log`;

      const rootConfig = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const asRoot = async (command: string): Promise<string> => {
        const result = await executor.execute(rootConfig, command, {});
        return result.stdout.trim();
      };

      const call = async (
        tool: { handleCall: (request: never) => Promise<any> },
        name: string,
        args: Record<string, unknown>
      ) => tool.handleCall({ params: { name, arguments: args } } as never);

      beforeAll(async () => {
        await asRoot(
          `rm -rf '${root}' && mkdir -p '${root}/open' '${root}/closed' && ` +
            `echo 'ERROR open one' > '${openLog}' && ` +
            `echo 'ERROR closed one' > '${closedLog}' && ` +
            `chmod 755 '${root}' '${root}/open' && chmod 700 '${root}/closed' && ` +
            `chown -R root:root '${root}'`
        );
      });

      afterAll(async () => {
        await asRoot(`rm -rf '${root}'`).catch(() => undefined);
        await closeAllRunners();
      });

      /**
       * Негативный контроль сцены. Читаемый каталог обязан быть читаемым, а
       * закрытый — закрытым: иначе всё ниже зелёное само по себе.
       */
      it('сцена собрана: один каталог открыт, другой закрыт', async () => {
        const answer = await call(logs, 'ssh_log_search', {
          profile: server.name,
          path: `${root}/open/*.log`,
          query: 'ERROR',
        });

        expect(answer.structuredContent.matches).toBe(1);

        const denied = await call(logs, 'ssh_log_search', {
          profile: server.name,
          path: closedLog,
          query: 'ERROR',
        });

        expect(JSON.stringify(denied)).toMatch(/denied|permission|not found/i);
      });

      it('закрытый каталог в дереве назван, а не пропущен молча', async () => {
        const answer = await call(logs, 'ssh_log_search', {
          profile: server.name,
          path: root,
          query: 'ERROR',
          recursive: true,
        });

        // Найдено то, что открыто, и сказано про то, что закрыто
        expect(answer.structuredContent.files_unreadable.join(' ')).toContain('closed');
        expect(answer.content[0].text).toContain('could not look inside');
      });

      it('под sudo тот же поиск доходит до закрытого файла', async () => {
        const answer = await call(logs, 'ssh_log_search', {
          profile: server.name,
          path: root,
          query: 'ERROR',
          recursive: true,
          sudo: true,
        });

        expect(answer.structuredContent.matches).toBe(2);
        expect(answer.structuredContent.files_unreadable).toEqual([]);
      });

      /**
       * Окно `since` спрашивает у `find` время файла. Файл, чьё время
       * посмотреть не дали, не должен уйти в «не менялся»: иначе закрытый
       * журнал читается как пустой.
       */
      it('файл с нечитаемым временем не уходит в пропущенные окном', async () => {
        const answer = await call(logs, 'ssh_log_search', {
          profile: server.name,
          path: [openLog, closedLog],
          query: 'ERROR',
          since: 'today',
        });

        expect(answer.structuredContent.files_skipped).toBe(0);
        expect(answer.structuredContent.files_unreadable.join(' ')).toContain('secret.log');
      });

      it('разбор диска называет каталог, куда его не пустили', async () => {
        const answer = await call(audit, 'ssh_disk_breakdown', {
          profile: server.name,
          paths: [root],
        });

        expect(answer.structuredContent.unreadable.join(' ')).toContain('closed');
        expect(answer.content[0].text).toContain('Retry with sudo: true');
      });

      it('разбор диска под sudo видит закрытый каталог и молчать ему не о чем', async () => {
        const answer = await call(audit, 'ssh_disk_breakdown', {
          profile: server.name,
          paths: [root],
          sudo: true,
        });

        expect(answer.structuredContent.unreadable).toEqual([]);
        const named = JSON.stringify(answer.structuredContent.largest);
        expect(named).toContain('closed');
      });

      /**
       * У службы полигона нет: systemd на контейнерах не запущен, поэтому
       * проверяется одно — права доезжают и ответ остаётся честным
       * («не проверяли»), а не превращается в «служба остановлена».
       */
      it('служба под sudo отвечает «не проверяли», а не «остановлена»', async () => {
        const answer = await call(audit, 'ssh_service_status', {
          profile: server.name,
          unit: 'nginx',
          sudo: true,
        });

        expect(answer.structuredContent.outcome).toBe('no_systemd');
        expect(answer.structuredContent.active_state).toBeNull();
      });
    });
  }
}
