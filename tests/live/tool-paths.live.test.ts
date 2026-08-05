/**
 * Живая проверка путей инструмента: «положить каталог X в Y»
 *
 * Контракт передачи (transfer-contract.ts) проверяет транспорт. Здесь
 * проверяется то, что поверх него делает инструмент, — и это отдельная точка
 * отказа: `scp -r` в **существующий** каталог создаёт внутри него ещё один
 * уровень. Пока инструмент не создаёт цель заранее, этого не происходит;
 * стоит кому-то добавить `mkdir -p` перед передачей — дерево молча уедет
 * на уровень глубже. Юнит-тесты этого не увидят: они мокают транспорт.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';
import { localManifest } from './manifest.js';

const LIVE_TIMEOUT_MS = 60_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'tool-paths-'));

// Инструмент берёт конфигурацию только из файла профилей
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

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живые пути инструмента', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живые пути инструмента — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Пути инструмента: openssh @ ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new TransferTool();
      const executor = new SSHExecutor();
      const remoteDir = `/tmp/tool-paths-${server.port}`;
      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      let source: string;
      let expected: string;

      const call = (name: string, args: Record<string, unknown>) =>
        tool.handleCall({ params: { name, arguments: args } } as never);

      /** Пути на сервере, относительно каталога */
      const remoteTree = async (): Promise<string[]> => {
        const result = await executor.execute(
          config,
          `cd '${remoteDir}' && find . -mindepth 1 | sort`,
          { profileName: server.name }
        );
        return result.stdout
          .split('\n')
          .map((line) => line.trim().replace(/^\.\//, ''))
          .filter(Boolean);
      };

      beforeAll(async () => {
        source = join(workDir, `app-${server.port}`);
        await mkdir(join(source, 'conf'), { recursive: true });
        await writeFile(join(source, 'index.js'), 'новая версия\n');
        await writeFile(join(source, 'conf/app.ini'), 'key=new\n');
        expected = await localManifest(source);

        await executor.execute(config, `rm -rf '${remoteDir}'`, { profileName: server.name });
      });

      afterAll(async () => {
        await executor
          .execute(config, `rm -rf '${remoteDir}'`, { profileName: server.name })
          .catch(() => undefined);
      });

      it('загрузка в несуществующую цель кладёт содержимое в неё, а не внутрь неё', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: remoteDir,
          verify: true,
        });

        expect(answer.content[0].text).toContain('verified');
        expect(await remoteTree()).toEqual(['conf', 'conf/app.ini', 'index.js']);
      });

      it('загрузка поверх существующего каталога заменяет его целиком', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: remoteDir,
          overwrite: true,
          verify: true,
        });

        expect(answer.content[0].text).toContain('verified');
        // Ни лишнего уровня, ни остатков прошлой копии рядом
        expect(await remoteTree()).toEqual(['conf', 'conf/app.ini', 'index.js']);
      });

      it('скачивание в несуществующую цель кладёт дерево один в один', async () => {
        const target = join(workDir, `down-new-${server.port}`);

        await call('ssh_download', {
          profile: server.name,
          remote_path: remoteDir,
          local_path: target,
          verify: true,
        });

        expect(await localManifest(target)).toBe(expected);
      });

      it('скачивание поверх существующей цели заменяет её целиком', async () => {
        const target = join(workDir, `down-over-${server.port}`);
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'stale.txt'), 'старое\n');

        await call('ssh_download', {
          profile: server.name,
          remote_path: remoteDir,
          local_path: target,
          overwrite: true,
          verify: true,
        });

        expect(await localManifest(target)).toBe(expected);
      });

      /**
       * Удалённый путь не остаётся у клиента: в классическом протоколе его
       * разбирает shell сервера, в современном шаблоны раскрывает сам клиент.
       * Замерено в обоих режимах: `star*name.txt` тащит три посторонних файла
       * везде, а `$(id)` в классическом исполняется на сервере.
       */
      describe('метасимволы в удалённом пути', () => {
        const globDir = `${remoteDir}-glob`;

        beforeAll(async () => {
          await executor.execute(
            config,
            `rm -rf '${globDir}' && mkdir -p '${globDir}' && ` +
              `echo сосед > '${globDir}/star1name.txt' && ` +
              `echo сосед > '${globDir}/star2name.txt' && ` +
              `printf %s настоящий > '${globDir}/star*name.txt' && ` +
              `printf %s подстановка > '${globDir}/$(id).txt'`,
            { profileName: server.name }
          );
        });

        afterAll(async () => {
          await executor
            .execute(config, `rm -rf '${globDir}'`, { profileName: server.name })
            .catch(() => undefined);
        });

        /**
         * Обратная сторона той же задачи: цель загрузки в этом режиме уходит
         * буквально, и экранирование сделало бы обратный слэш частью имени —
         * файл лёг бы как `a\ b.txt`, а сверка, переименование и уборка искали
         * бы его без слэша. Замерено: так и было, пока правка экранировала оба
         * направления одинаково.
         */
        it('файл уезжает в путь с пробелом, а не в путь с обратным слэшем', async () => {
          const answer = await call('ssh_upload', {
            profile: server.name,
            local_path: join(source, 'index.js'),
            remote_path: `${globDir}/ц ель.txt`,
            verify: true,
          });

          expect(answer.content[0].text).toContain('verified');
          const listing = await executor.execute(
            config,
            `ls -a '${globDir}' | grep -c 'ц ель.txt'`,
            { profileName: server.name }
          );
          expect(listing.stdout.trim()).toBe('1');
        });

        it('каталог уезжает в путь с пробелом целиком', async () => {
          const answer = await call('ssh_upload', {
            profile: server.name,
            local_path: source,
            remote_path: `${globDir}/моё приложение`,
            recursive: true,
            verify: true,
          });

          expect(answer.content[0].text).toContain('verified');
          const listing = await executor.execute(
            config,
            `ls '${globDir}/моё приложение' | sort | tr '\\n' ' '`,
            { profileName: server.name }
          );
          expect(listing.stdout.trim()).toBe('conf index.js');
        });

        it('звёздочка в имени берёт один файл, а не всё похожее рядом', async () => {
          const target = join(workDir, `glob-${server.port}`);

          await call('ssh_download', {
            profile: server.name,
            remote_path: `${globDir}/star*name.txt`,
            local_path: target,
          });

          expect(await readFile(target, 'utf8')).toBe('настоящий');
        });

        /**
         * Здесь проверяется только то, что экранирование не испортило такое
         * имя: клиент лаборатории один (10.2, передача поверх SFTP), и в этом
         * режиме `$(id)` не исполняется и без экранирования — негативный
         * контроль теста красным не становится. Само исполнение проверяется
         * в legacy-scp.live.test.ts — там клиенту подсовывают классический
         * протокол, и негативный контроль там краснеет.
         */
        it('имя с подстановкой команды доезжает как имя', async () => {
          const target = join(workDir, `subst-${server.port}`);

          await call('ssh_download', {
            profile: server.name,
            remote_path: `${globDir}/$(id).txt`,
            local_path: target,
          });

          expect(await readFile(target, 'utf8')).toBe('подстановка');
        });
      });

      /**
       * Тильда в удалённом пути.
       *
       * Передачу делает scp: он отдаёт путь shell-у сервера и `~` раскрывает.
       * Всё остальное — сверка, уборка, создание каталога — шлёт путь в
       * одинарных кавычках, где `~` остаётся буквой. Пока эти две стороны
       * расходились, скачивание со сверкой (а она включена по умолчанию)
       * привозило файл и тут же его выбрасывало: сверка не находила на сервере
       * файл с именем «~» и объявляла расхождение.
       */
      describe('тильда в удалённом пути', () => {
        const homeFile = 'tool-paths-tilde.txt';

        beforeAll(async () => {
          await executor.execute(config, `printf %s ЭТАЛОН > ~/'${homeFile}'`, {
            profileName: server.name,
          });
        });

        afterAll(async () => {
          await executor
            .execute(config, `rm -rf ~/'${homeFile}' ~/'${homeFile}.up' ~/.upload-* './~'`, {
              profileName: server.name,
            })
            .catch(() => undefined);
        });

        it('скачивание со сверкой привозит файл, а не уносит его', async () => {
          const target = join(workDir, `tilde-down-${server.port}`);

          const answer = await call('ssh_download', {
            profile: server.name,
            remote_path: `~/${homeFile}`,
            local_path: target,
            verify: true,
          });

          expect(answer.content[0].text).toContain('verified');
          expect(await readFile(target, 'utf8')).toBe('ЭТАЛОН');
        });

        it('загрузка кладёт файл в дом и не оставляет рядом следов', async () => {
          const answer = await call('ssh_upload', {
            profile: server.name,
            local_path: join(source, 'index.js'),
            remote_path: `~/${homeFile}.up`,
            verify: true,
          });

          expect(answer.content[0].text).toContain('verified');

          // Файл лежит в доме целым
          const content = await executor.execute(config, `cat ~/'${homeFile}.up'`, {
            profileName: server.name,
          });
          expect(content.stdout).toBe('новая версия\n');

          // Ни каталога с именем «~», ни брошенного временного пути
          const traces = await executor.execute(
            config,
            `ls -a ~ | grep -c -e '^~$' -e '^\\.upload-' || true`,
            { profileName: server.name }
          );
          expect(traces.stdout.trim()).toBe('0');
        });
      });
    });
  }

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });
}
