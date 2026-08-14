/**
 * Сверка дерева, у которого имена весят больше своей длины в знаках.
 *
 * Предел у сервера в байтах: замерено на обоих серверах лаборатории, что
 * строка длиннее 128 KiB не доезжает вовсе — `Argument list too long` с пустым
 * выводом. Пустой вывод читается как расхождение, а по расхождению установщик
 * сносит уже уехавшее дерево.
 *
 * Русская буква в UTF-8 весит два байта, апостроф после экранирования — четыре,
 * поэтому дерево здесь набрано именно из них: команда дробится на несколько,
 * и каждая обязана вернуться с хэшами.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 180_000;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

const workDir = await mkdtemp(join(tmpdir(), 'verify-length-'));
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
const { verifyRemoteFiles } = await import('../../src/managers/remote-verify.js');
const { sha256OfFile } = await import('../../src/utils/sha256.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

/** Сколько файлов в дереве: хватает, чтобы список не поместился в одну команду */
const FILE_COUNT = 300;
/** Длина тяжёлой части имени; предел имени в файловой системе — 255 байт */
const HEAVY_LENGTH = 100;

/**
 * Имена трёх сортов вперемешку: латиница весит знак в знак, кириллица вдвое,
 * апостроф после экранирования вчетверо.
 */
function heavyName(index: number): string {
  const body = ['a', 'я', "'"][index % 3];
  return `${String(index).padStart(3, '0')}-${body.repeat(HEAVY_LENGTH)}.txt`;
}

describe.each(LAB_SERVERS)('Длина команды сверки — $name', { timeout: LIVE_TIMEOUT_MS }, (server) => {
  const tool = new TransferTool();
  const executor = new SSHExecutor();
  const remoteDir = `/tmp/verify-length-${server.port}`;
  const source = join(workDir, `tree-${server.port}`);
  const config = {
    host: '127.0.0.1',
    port: server.port,
    username: 'root',
    privateKeyPath: LAB_KEY,
    strictHostKeyChecking: 'no' as const,
    ignoreUserConfig: true,
  };

  const call = (name: string, args: Record<string, unknown>) =>
    tool.handleCall({ params: { name, arguments: args } } as never);

  /** Сколько файлов на сервере — по одной строке на файл, без разбора имён */
  const remoteFileCount = async (): Promise<number> => {
    const result = await executor.execute(config, `find '${remoteDir}' -type f -exec echo x ';'`, {
    });
    return result.stdout.split('\n').filter((line) => line.trim() === 'x').length;
  };

  beforeAll(async () => {
    if (unavailable) return;
    await mkdir(source, { recursive: true });
    for (let index = 0; index < FILE_COUNT; index++) {
      await writeFile(join(source, heavyName(index)), `content-${index}\n`);
    }
    await executor.execute(config, `rm -rf '${remoteDir}'`, {});
  });

  afterAll(async () => {
    if (unavailable) return;
    await executor
      .execute(config, `rm -rf '${remoteDir}'`, {})
      .catch(() => undefined);
    await closeAllRunners();
  });

  it.skipIf(unavailable)('тяжёлое дерево доезжает целиком, и сверка его принимает', async () => {
    const answer = await call('ssh_upload', {
      profile: server.name,
      local_path: source,
      remote_path: remoteDir,
      recursive: true,
      verify: true,
    });

    expect(answer.content[0].text).toContain(`verified (${FILE_COUNT} files)`);
    expect(await remoteFileCount()).toBe(FILE_COUNT);
  });

  it.skipIf(unavailable)('то же дерево сходится и при скачивании обратно', async () => {
    const target = join(workDir, `back-${server.port}`);

    const answer = await call('ssh_download', {
      profile: server.name,
      remote_path: remoteDir,
      local_path: target,
      recursive: true,
      verify: true,
    });

    expect(answer.content[0].text).toContain(`verified (${FILE_COUNT} files)`);
    await rm(target, { recursive: true, force: true });
  });

  /**
   * Здесь важно не только «сошлось», но и что список действительно уехал
   * несколькими командами: одна команда ничего не сказала бы о дроблении.
   */
  it.skipIf(unavailable)('список уезжает несколькими командами, и все они отвечают', async () => {
    const entries = await Promise.all(
      Array.from({ length: FILE_COUNT }, async (_unused, index) => ({
        path: `${remoteDir}/${heavyName(index)}`,
        hash: await sha256OfFile(join(source, heavyName(index))),
      }))
    );

    let commands = 0;
    const counting = {
      passport: (config: unknown) => executor.passport(config as never),
      execute: (...args: unknown[]) => {
        commands += 1;
        return (executor.execute as (...rest: unknown[]) => unknown)(...args);
      },
    };

    const outcome = await verifyRemoteFiles(counting as never, config, entries, {
    });

    expect(outcome).toEqual({ status: 'matched' });
    expect(commands).toBeGreaterThan(1);
  });
});
