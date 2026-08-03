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
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';
import { localManifest } from './manifest.js';

const LIVE_TIMEOUT_MS = 60_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'tool-paths-'));

// Инструмент берёт конфиг только из файла профилей, а бэкенд — из окружения.
// Проверяем openssh: он станет дефолтом, и лишний уровень вложенности — его
// особенность, не ssh2.
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
process.env.SSH_MCP_BACKEND = 'openssh';

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
    });
  }

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });
}
