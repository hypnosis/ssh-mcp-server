/**
 * Живая проверка правил путей из профиля
 *
 * Правила `pathSecurity` живьём не проверял никто: юниты мокают транспорт, и
 * запрет мог не работать вовсе — именно так он и не работал в журнальных
 * инструментах. Они сверяли правила с сырым путём, а `~` раскрывали после,
 * поэтому под root `~/secret` обходил запрет `/root` и отдавал содержимое
 * файла. Замер показал это на обоих контейнерах.
 *
 * Утверждение здесь про утечку, а не про текст ошибки: запрещённое содержимое
 * не должно приехать ответом.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Файл в запрещённом каталоге и слово, которого не должно быть в ответе */
const SECRET_WORD = 'TOP-SECRET-LINE';

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'path-rules-'));

// У каждого сервера три профиля: обычный для подготовки файлов, «сторожевой»
// с запретом на дом root и «списочный», где разрешён единственный каталог
const profilesPath = join(workDir, 'profiles.json');
const guardedName = (name: string) => `${name}-guarded`;
const listedName = (name: string) => `${name}-listed`;

/** Единственный разрешённый каталог «списочного» профиля */
const ALLOWED_DIR = '/tmp/rules-allowed';

await writeFile(
  profilesPath,
  JSON.stringify({
    default: LAB_SERVERS[0].name,
    profiles: Object.fromEntries(
      LAB_SERVERS.flatMap((server) => {
        const base = {
          host: '127.0.0.1',
          port: server.port,
          username: 'root',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        };
        return [
          [server.name, base],
          [guardedName(server.name), { ...base, pathSecurity: { deniedPaths: ['/root'] } }],
          [listedName(server.name), { ...base, pathSecurity: { allowedPaths: [ALLOWED_DIR] } }],
        ];
      })
    ),
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { LogTools } = await import('../../src/tools/log-tools.js');
const { FileTools } = await import('../../src/tools/file-tools.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живые правила путей', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живые правила путей — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Правила путей: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const logs = new LogTools();
      const fileTools = new FileTools();
      const executor = new SSHExecutor();
      const guarded = guardedName(server.name);
      const listed = listedName(server.name);
      const allowedLog = `/tmp/path-rules-${server.port}.log`;
      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const callLogs = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const response = await logs.handleCall({ params: { name, arguments: args } } as never);
        return response.content[0].text as string;
      };

      const callFiles = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const response = await fileTools.handleCall({ params: { name, arguments: args } } as never);
        return response.content[0].text as string;
      };

      beforeAll(async () => {
        // Дом root — это и есть /root, значит ~/secret и /root/secret один файл
        await executor.execute(config, `printf '${SECRET_WORD}\\n' > /root/secret`, {
          profileName: server.name,
        });
        await executor.execute(config, `printf 'ordinary line\\n' > ${allowedLog}`, {
          profileName: server.name,
        });

        // Разрешённый каталог с двумя ссылками: одна наружу, в запрещённый дом,
        // другая внутрь себя же. И каталог-сосед, чьё имя начинается так же
        await executor.execute(
          config,
          `mkdir -p ${ALLOWED_DIR}/inner ${ALLOWED_DIR}-evil && ` +
            `printf 'ordinary line\\n' > ${ALLOWED_DIR}/inner/app.log && ` +
            `printf '${SECRET_WORD}\\n' > ${ALLOWED_DIR}-evil/secret && ` +
            `ln -sfn /root ${ALLOWED_DIR}/escape && ` +
            `ln -sfn ${ALLOWED_DIR}/inner ${ALLOWED_DIR}/shortcut && ` +
            // Каталог с именем ровно `~` — законное имя, а не нераскрытая тильда
            `mkdir -p '${ALLOWED_DIR}/~' '/root/~' && ` +
            `printf 'tilde directory\\n' > '${ALLOWED_DIR}/~/note.txt' && ` +
            `printf '${SECRET_WORD}\\n' > '/root/~/secret'`,
          { profileName: server.name }
        );
      });

      afterAll(async () => {
        await executor.execute(
          config,
          `rm -f /root/secret ${allowedLog}; rm -rf ${ALLOWED_DIR} ${ALLOWED_DIR}-evil '/root/~'`,
          { profileName: server.name }
        );
        await closeAllRunners();
      });

      it('ssh_log_tail не отдаёт запрещённый дом через тильду', async () => {
        const text = await callLogs('ssh_log_tail', { profile: guarded, path: '~/secret' });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('ssh_log_search не находит строку в запрещённом доме', async () => {
        const text = await callLogs('ssh_log_search', {
          profile: guarded,
          path: '~/secret',
          query: 'SECRET',
        });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('ssh_file_read не отдаёт запрещённый дом через тильду', async () => {
        const text = await callFiles('ssh_file_read', { profile: guarded, path: '~/secret' });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('разрешённый путь запретом не задет', async () => {
        const text = await callLogs('ssh_log_tail', { profile: guarded, path: allowedLog });

        expect(text).toContain('ordinary line');
        expect(text).not.toMatch(/Path validation failed/);
      });

      // Дальше — семейство обходов правила: имя выглядит законным, а файл
      // получается другой. Каждый из них до канонизации проходил насквозь.

      it('ссылка из разрешённого каталога наружу не выносит данные', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}/escape/secret`,
        });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('`..` не выводит за пределы разрешённого каталога', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}/../../root/secret`,
        });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('относительный путь виден запрету: рабочий каталог — это дом', async () => {
        const text = await callFiles('ssh_file_read', { profile: guarded, path: 'secret' });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('сосед по имени в разрешённый каталог не попадает', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}-evil/secret`,
        });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      it('сдвоенный слэш запрет не обходит', async () => {
        const text = await callFiles('ssh_file_read', { profile: guarded, path: '//root/secret' });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Path validation failed/);
      });

      // Обратная сторона: строгость не должна перекрывать законную работу

      // Отличает канонизацию от простого отказа судить: `..` внутри разрешённого
      // каталога обязан свернуться и пройти, а не упереться в «путь не канонический»
      it('`..` внутри разрешённого каталога сворачивается и работает', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}/inner/../inner/app.log`,
        });

        expect(text).toContain('ordinary line');
        expect(text).not.toMatch(/Path validation failed/);
      });

      it('ссылка внутрь разрешённого каталога работает', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}/shortcut/app.log`,
        });

        expect(text).toContain('ordinary line');
        expect(text).not.toMatch(/Path validation failed/);
      });

      it('запись в ещё не созданное дерево разрешена', async () => {
        const text = await callFiles('ssh_file_write', {
          profile: listed,
          files: { path: `${ALLOWED_DIR}/new/deep/app.conf`, content: 'key = value' },
        });

        expect(text).not.toMatch(/Path validation failed/);
      });

      it('каталог с похожим именем запретом не задет', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: guarded,
          path: `${ALLOWED_DIR}/inner/app.log`,
        });

        expect(text).toContain('ordinary line');
        expect(text).not.toMatch(/Path validation failed/);
      });

      // Такие имена на сервере есть: их оставлял прежний дефект загрузки,
      // и убрать их — обычная работа, которую правила не должны запрещать
      it('файл с именем `~` внутри разрешённого каталога читается', async () => {
        const text = await callFiles('ssh_file_read', {
          profile: listed,
          path: `${ALLOWED_DIR}/~/note.txt`,
        });

        expect(text).toContain('tilde directory');
        expect(text).not.toMatch(/Path validation failed/);
      });

      it('тильда в середине запрещённого пути отказ не отменяет', async () => {
        const text = await callFiles('ssh_file_read', { profile: guarded, path: '/root/~/secret' });

        expect(text).not.toContain(SECRET_WORD);
        expect(text).toMatch(/Access denied/);
      });
    });
  }
}

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});
