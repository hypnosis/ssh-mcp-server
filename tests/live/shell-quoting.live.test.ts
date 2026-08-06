/**
 * Имя файла на сервере остаётся именем, а не становится командой.
 *
 * Значение уезжает в строку, которую разбирает shell сервера, и защита у него
 * одна — одинарные кавычки. Пока правило было записано тремя способами в трёх
 * местах, спрашивать «работает ли оно» приходилось про каждое место отдельно.
 *
 * Проверяется последствие на сервере: сколько файлов появилось, что в них лежит
 * и не выполнилось ли по дороге то, чего никто не заказывал. Текст ответа
 * инструмента здесь ничего не доказывает — он рапортует и о невыполненной работе.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'shell-quoting-'));

// Профиль ходит под `deploy`: только у него sudo-путь настоящий — команда
// уезжает внутрь `sudo sh -c '…'`, то есть закавычивается второй раз
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

const { FileTools } = await import('../../src/tools/file-tools.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

/** Имена, каждое из которых shell при недостаточной защите понял бы по-своему */
const AWKWARD_NAMES = [
  'plain.txt',
  "it's.txt",
  'a b.txt',
  'a\\b.txt',
  'a\nb.txt',
  '$HOME.txt',
  '`hostname`.txt',
  '~tilde.txt',
  'star*.txt',
  '; id ;.txt',
  'dollar$paren(.txt',
];

/** Содержимое своё у каждого имени: по нему файл узнаётся без упоминания имени */
const contentFor = (index: number): string => `content-${index}\n`;

if (unavailable && LAB_REQUIRED) {
  describe('живая защита имён', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живая защита имён — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Защита имени для shell: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const files = new FileTools();
      const executor = new SSHExecutor();

      const openDir = `/tmp/quoting-${server.port}`;
      /** Каталог root: путь сюда идёт только через sudo, то есть через вторые кавычки */
      const guardedDir = `/opt/quoting-${server.port}`;
      /** Появление этого файла означает, что имя выполнилось как команда */
      const marker = `/tmp/quoting-marker-${server.port}`;

      const rootConfig = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const asRoot = async (command: string): Promise<string> => {
        const result = await executor.execute(rootConfig, command, {
          profileName: `${server.name}-root`,
        });
        return result.stdout;
      };

      const call = (name: string, args: Record<string, unknown>) =>
        files.handleCall({ params: { name, arguments: args } } as never);

      /**
       * Что лежит в каталоге, без единого упоминания имён: они и есть предмет
       * спора, и печатать их пришлось бы тем же способом, который проверяем.
       */
      const contentsIn = async (dir: string): Promise<string[]> => {
        const printed = await asRoot(`find ${dir} -type f -exec cat {} ';'`);
        return printed.split('\n').filter((line) => line.startsWith('content-')).sort();
      };

      const expectedContents = AWKWARD_NAMES.map((_, index) => contentFor(index).trim()).sort();

      beforeAll(async () => {
        await asRoot(
          `rm -rf ${openDir} ${guardedDir} ${marker} && ` +
            `mkdir -p ${openDir} ${guardedDir} && chown deploy ${openDir}`
        );
      });

      afterAll(async () => {
        await asRoot(`rm -rf ${openDir} ${guardedDir} ${marker}`).catch(() => undefined);
        await closeAllRunners();
      });

      it('каждое имя становится файлом — ровно одним и с своим содержимым', async () => {
        await call('ssh_file_write', {
          profile: server.name,
          files: AWKWARD_NAMES.map((name, index) => ({
            path: `${openDir}/${name}`,
            content: contentFor(index),
          })),
        });

        expect(await contentsIn(openDir)).toEqual(expectedContents);
      });

      it('файл находится обратно по тому же имени', async () => {
        for (const [index, name] of AWKWARD_NAMES.entries()) {
          const answer = JSON.stringify(
            await call('ssh_file_read', { profile: server.name, path: `${openDir}/${name}` })
          );

          expect(answer).toContain(`content-${index}`);
        }
      });

      /**
       * Отдельная проба на подстановку: имя содержит готовую команду. Счёт
       * файлов её не поймает — она создаёт файл в стороне, а не рядом.
       */
      it('подстановка команды внутри имени не выполняется', async () => {
        const armed = `${openDir}/$(touch ${marker})-name.txt`;

        await call('ssh_file_write', {
          profile: server.name,
          files: [{ path: armed, content: 'armed\n' }],
        });

        expect((await asRoot(`test -e ${marker} && echo YES || echo NO`)).trim()).toBe('NO');
      });

      it('под sudo, где кавычки накладываются дважды, имена доезжают так же', async () => {
        await call('ssh_file_write', {
          profile: server.name,
          files: AWKWARD_NAMES.map((name, index) => ({
            path: `${guardedDir}/${name}`,
            content: contentFor(index),
            sudo: true,
          })),
        });

        expect(await contentsIn(guardedDir)).toEqual(expectedContents);
      });

      it('под sudo подстановка внутри имени тоже не выполняется', async () => {
        const armed = `${guardedDir}/$(touch ${marker})-name.txt`;

        await call('ssh_file_write', {
          profile: server.name,
          files: [{ path: armed, content: 'armed\n', sudo: true }],
        });

        expect((await asRoot(`test -e ${marker} && echo YES || echo NO`)).trim()).toBe('NO');
      });
    });
  }
}
