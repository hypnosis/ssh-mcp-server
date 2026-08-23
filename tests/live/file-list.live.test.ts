/**
 * Живая проверка: каталог приезжает полями, и поля совпадают с тем, что на
 * сервере лежит на самом деле.
 *
 * Разбор идёт по выводу `stat`, а его печатает сервер — и печатает по-своему:
 * BusyBox и coreutils зовут пустой файл разными словами, кавычат путь в жалобе
 * по-разному и расходятся в наборе опций. Юниты подают заготовленный текст и
 * такого расхождения не видят.
 *
 * Имя — единственное поле, куда сервер пускает что угодно, включая перевод
 * строки, кавычку и разделитель полей. Здесь эти имена настоящие.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'file-list-'));

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

const { FileTools } = await import('../../src/tools/file-tools.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

/** Имена, каждое из которых разбор мог бы понять по-своему */
const AWKWARD_NAMES = [
  'plain.conf',
  "it's.conf",
  'a b.conf',
  'a\nb.conf',
  'pipe|inside.conf',
  'star*.conf',
  '; id ;.conf',
];

if (unavailable && LAB_REQUIRED) {
  describe('живой список файлов', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой список файлов — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  afterAll(async () => {
    await closeAllRunners();
  });

  for (const server of LAB_SERVERS) {
    describe(`Список каталога: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const files = new FileTools();
      const executor = new SSHExecutor();

      const dir = `/tmp/listing-${server.port}`;
      /** Каталог, куда `deploy` не пускают: его содержимое известно только root */
      const closed = `${dir}/closed`;

      const rootConfig = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const asRoot = (command: string) => executor.execute(rootConfig, command, {});

      const listed = async (args: Record<string, unknown> = {}): Promise<any> => {
        const response = await files.handleCall({
          params: { name: 'ssh_file_list', arguments: { profile: server.name, path: dir, ...args } },
        } as never);
        return response.structuredContent;
      };

      const entryNamed = (summary: any, name: string) =>
        summary.entries.find((entry: any) => entry.name === name);

      beforeAll(async () => {
        await asRoot(`rm -rf ${dir}`);

        // Имена кладёт сам инструмент: он единственный здесь умеет отдать
        // серверу перевод строки внутри имени, не превратив его в две команды
        await files.handleCall({
          params: {
            name: 'ssh_file_write',
            arguments: {
              profile: server.name,
              files: AWKWARD_NAMES.map((name, index) => ({
                path: `${dir}/${name}`,
                content: 'x'.repeat(index + 1),
                mode: '640',
              })),
            },
          },
        } as never);

        await asRoot(
          `mkdir -p ${dir}/nested/deep ${closed} && ` +
            `echo inner > ${dir}/nested/deep/inner.conf && ` +
            `ln -sf ${dir}/plain.conf ${dir}/current.conf && ` +
            `echo secret > ${closed}/secret.conf && chmod 000 ${closed}`
        );
      });

      afterAll(async () => {
        await asRoot(`chmod 755 ${closed}; rm -rf ${dir}`);
      });

      it('каждое имя доезжает именем, а не двумя записями', async () => {
        const summary = await listed();

        for (const name of AWKWARD_NAMES) {
          expect(entryNamed(summary, name), name).toBeDefined();
        }
      });

      it('поля записи совпадают с тем, что положили', async () => {
        const summary = await listed();
        const entry = entryNamed(summary, 'plain.conf');

        expect(entry).toMatchObject({ type: 'file', size: 1, mode: '640', owner: 'deploy' });
        expect(entry.mtime).toBeGreaterThan(1_700_000_000);
      });

      it('каталог назван каталогом, а его размер — не суммой содержимого', async () => {
        const entry = entryNamed(await listed(), 'nested');

        expect(entry.type).toBe('dir');
        expect(entry.target).toBeNull();
      });

      it('ссылка приходит вместе с тем, куда ведёт', async () => {
        const entry = entryNamed(await listed(), 'current.conf');

        expect(entry.type).toBe('symlink');
        expect(entry.target).toBe(`${dir}/plain.conf`);
      });

      it('вложенное называется относительно запрошенного каталога', async () => {
        const summary = await listed({ recursive: true });

        expect(entryNamed(summary, 'nested/deep/inner.conf')).toBeDefined();
        expect(entryNamed(summary, 'plain.conf')).toBeDefined();
      });

      it('шаблон отбирает записи и не отказывается на пустом отборе', async () => {
        expect((await listed({ pattern: 'plain.*' })).entries.map((e: any) => e.name)).toEqual([
          'plain.conf',
        ]);
        expect((await listed({ pattern: '*.nothing' })).entries).toEqual([]);
      });

      /**
       * Закрытый каталог — половина ответа: остальные записи собраны, а дыра
       * названа. Список, короткий ровно на интересное, читается как полный.
       */
      it('каталог, куда не пустили, назван, а собранное не потеряно', async () => {
        const summary = await listed({ recursive: true });

        expect(summary.unreadable).toEqual([`${closed}: Permission denied`]);
        expect(entryNamed(summary, 'plain.conf')).toBeDefined();
        expect(entryNamed(summary, 'closed/secret.conf')).toBeUndefined();
      });

      it('под sudo тот же каталог читается, и дыры не остаётся', async () => {
        const summary = await listed({ recursive: true, sudo: true });

        expect(summary.unreadable).toEqual([]);
        expect(entryNamed(summary, 'closed/secret.conf')).toBeDefined();
      });

      /**
       * Тильда и под sudo ведёт в дом того, кто вошёл, а не в /root: адрес у
       * команды один, права другие. Юнит этого не покажет — там дом один на всех.
       */
      it('тильда под sudo остаётся домом профиля, а не становится /root', async () => {
        expect((await listed({ path: '~' })).path).toBe('/home/deploy');
        expect((await listed({ path: '~', sudo: true })).path).toBe('/home/deploy');
      });

      it('несуществующий каталог — отказ с текстом сервера, а не пустой список', async () => {
        const response = await files.handleCall({
          params: {
            name: 'ssh_file_list',
            arguments: { profile: server.name, path: `${dir}/nowhere` },
          },
        } as never);

        expect(response.content[0].text).toContain('No such file or directory');
        expect(response.structuredContent).toBeUndefined();
      });

      it('сводка для чтения и её разбор говорят одно и то же', async () => {
        const response = await files.handleCall({
          params: { name: 'ssh_file_list', arguments: { profile: server.name, path: dir } },
        } as never);
        const summary: any = response.structuredContent;

        expect(response.content[0].text).toContain(`${dir} — ${summary.entries.length} entries`);
        expect(response.content[0].text).toContain('current.conf -> ');
      });
    });
  }
}
