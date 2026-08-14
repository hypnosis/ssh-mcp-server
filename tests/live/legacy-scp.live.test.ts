/**
 * Живая проверка классического протокола scp (клиенты OpenSSH до 9.0)
 *
 * Ветка `prepareRemotePath(…, 'shell')` живёт в коде ради старых клиентов, и до
 * сих пор её не проверял никто: клиент лаборатории один (10.2) и в классику сам
 * не идёт. Замер показал, что защищает она не от гипотетики — в этом режиме
 * неэкранированный `$(id)` исполняется на сервере, а `*` тащит посторонние файлы.
 *
 * Как загоняем продукт в классику: два шима в PATH. `ssh` печатает версию 8.9 на
 * `-V`, `scp` дописывает `-O`. Дальше продукт всё решает сам — ровно как у
 * пользователя со старым клиентом; `src/` не трогается вовсе.
 *
 * Две вещи, без которых способ был бы ненадёжен:
 *  - шим прозрачен без SSH_MCP_LEGACY_SHIM=1. Живые файлы идут последовательно в
 *    одном воркере и делят process.env: протёкший PATH иначе стал бы классом
 *    багов, а не единичной неприятностью;
 *  - канарейка. Прежде чем что-то утверждать, тест доказывает, что режим
 *    действительно классический: неэкранированная подстановка обязана
 *    исполниться на сервере. В SFTP-режиме этого не бывает никогда, поэтому
 *    сломавшийся шим красит набор, а не оставляет его тихо зелёным.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const run = promisify(execFile);
const LIVE_TIMEOUT_MS = 60_000;

/** Версия, которую шим показывает продукту: до 9.0, но не ниже 8.4 (askpass) */
const SHIMMED_VERSION = 'OpenSSH_8.9p1';

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'legacy-scp-'));

/** Настоящие бинарники ищем до подмены PATH — иначе шим найдёт сам себя */
const realPath = async (name: string): Promise<string> =>
  (await run('/bin/sh', ['-c', `command -v ${name}`])).stdout.trim();

const shimDir = join(workDir, 'shim');
await mkdir(shimDir, { recursive: true });

await writeFile(
  join(shimDir, 'ssh'),
  `#!/bin/sh
# Шим живого теста: старым клиентом притворяется только по явному признаку
if [ "\${SSH_MCP_LEGACY_SHIM:-}" = 1 ] && [ "$1" = "-V" ]; then
  echo "${SHIMMED_VERSION}, LibreSSL 3.3.6 (legacy shim)" >&2
  exit 0
fi
exec ${await realPath('ssh')} "$@"
`,
  { mode: 0o755 }
);

await writeFile(
  join(shimDir, 'scp'),
  `#!/bin/sh
# То же самое с другой стороны: -O включает классический протокол передачи
if [ "\${SSH_MCP_LEGACY_SHIM:-}" = 1 ]; then
  exec ${await realPath('scp')} -O "$@"
fi
exec ${await realPath('scp')} "$@"
`,
  { mode: 0o755 }
);

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

const originalPath = process.env.PATH;

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;
process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
process.env.SSH_MCP_LEGACY_SHIM = '1';

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');
const { detectRuntime, resetRuntimeCache } = await import('../../src/runner/runtime-check.js');

// Версия могла быть определена и закэширована соседним набором до подмены PATH
resetRuntimeCache();

if (unavailable && LAB_REQUIRED) {
  describe('классический scp живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`классический scp живьём — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  describe('шим показывает продукту старого клиента', () => {
    it('передача идёт классическим протоколом, а не поверх SFTP', async () => {
      const runtime = await detectRuntime({ force: true });

      expect(runtime.version?.raw).toContain(SHIMMED_VERSION);
      expect(runtime.scpOverSftp).toBe(false);
      // Пароль в классическом режиме всё равно должен быть подаваем:
      // 8.9 выше порога SSH_ASKPASS_REQUIRE, иначе проверялся бы не тот клиент
      expect(runtime.askpassForce).toBe(true);
    });
  });

  for (const server of LAB_SERVERS) {
    describe(`Классический scp @ ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new TransferTool();
      const executor = new SSHExecutor();
      const remoteDir = `/tmp/legacy-scp-${server.port}`;
      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const source = join(workDir, `src-${server.port}.txt`);

      const call = (name: string, args: Record<string, unknown>) =>
        tool.handleCall({ params: { name, arguments: args } } as never);

      const remoteList = async (): Promise<string[]> => {
        const result = await executor.execute(config, `ls -a '${remoteDir}'`, {
        });
        return result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && line !== '.' && line !== '..');
      };

      beforeAll(async () => {
        await writeFile(source, 'новая версия\n');
        await executor.execute(
          config,
          `rm -rf '${remoteDir}' && mkdir -p '${remoteDir}' && ` +
            `echo сосед > '${remoteDir}/star1name.txt' && ` +
            `echo сосед > '${remoteDir}/star2name.txt' && ` +
            `printf %s настоящий > '${remoteDir}/star*name.txt' && ` +
            `printf %s подстановка > '${remoteDir}/$(id).txt'`
        );
      });

      afterAll(async () => {
        await executor
          .execute(config, `rm -rf '${remoteDir}'`, {})
          .catch(() => undefined);
      });

      /**
       * Канарейка. Прямой вызов scp через шим, путь не экранирован — сервер
       * обязан выполнить подстановку и развалить путь на слова вывода `id`.
       * Если этого не произошло, режим не классический, и всё, что ниже,
       * проверяет не то, что заявлено.
       */
      it('канарейка: неэкранированная подстановка исполняется на сервере', async () => {
        const target = join(workDir, `canary-${server.port}.txt`);
        const outcome = await run(
          'scp',
          [
            '-i', LAB_KEY,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ControlPath=none',
            '-o', 'LogLevel=ERROR',
            '-P', String(server.port),
            `root@127.0.0.1:${remoteDir}/$(id).txt`,
            target,
          ],
          { encoding: 'utf8' }
        ).catch((error: { stderr?: string }) => ({ stdout: '', stderr: error.stderr ?? '' }));

        expect(outcome.stderr).toMatch(/uid=\d+\(/);
      });

      it('файл уезжает в путь с пробелом, а не разваливается на два аргумента', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: `${remoteDir}/ц ель.txt`,
          verify: true,
        });

        expect(answer.content[0].text).toContain('verified');
        expect(await remoteList()).toContain('ц ель.txt');
      });

      it('звёздочка в имени берёт один файл, а не всё похожее рядом', async () => {
        const target = join(workDir, `star-${server.port}.txt`);

        await call('ssh_download', {
          profile: server.name,
          remote_path: `${remoteDir}/star*name.txt`,
          local_path: target,
        });

        expect(await readFile(target, 'utf8')).toBe('настоящий');
      });

      it('имя с подстановкой команды доезжает как имя, а не выполняется', async () => {
        const target = join(workDir, `subst-${server.port}.txt`);

        await call('ssh_download', {
          profile: server.name,
          remote_path: `${remoteDir}/$(id).txt`,
          local_path: target,
        });

        expect(await readFile(target, 'utf8')).toBe('подстановка');
      });

      /**
       * Перевод строки экранировать нечем: `\` перед ним означает продолжение
       * строки, символ исчезает, и остаток уходит серверу отдельной командой.
       * Поэтому в этом режиме такой путь отклоняется, а не отправляется.
       */
      it('перевод строки в имени отклоняется, а не уезжает на сервер', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: `${remoteDir}/пере\nвод.txt`,
          verify: true,
        });

        expect(answer.content[0].text).toContain('Error:');
        expect(answer.content[0].text).toContain('newline');
        // На сервере не должно остаться ни файла, ни брошенного staging
        const listing = await remoteList();
        expect(listing.filter((name) => name.includes('вод.txt'))).toEqual([]);
        expect(listing.filter((name) => name.startsWith('.upload-'))).toEqual([]);
      });
    });
  }

  afterAll(async () => {
    await closeAllRunners();
    // Кэш возвращаем настоящему клиенту: PATH общий на воркер, и следующий
    // набор не должен унаследовать чужую версию
    resetRuntimeCache();
    delete process.env.SSH_MCP_LEGACY_SHIM;
    process.env.PATH = originalPath;
    await rm(workDir, { recursive: true, force: true });
  });
}
