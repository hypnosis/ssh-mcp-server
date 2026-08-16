/**
 * Обещанный срок сверки: он один на всю операцию, и его исчерпание не портит данные.
 *
 * Список дробится на несколько команд, поэтому потолок на каждой означал бы,
 * что названные пользователем секунды множатся на их число. И второе, важнее
 * первого: когда срок кончился, ответ — «проверить нечем». Расхождение здесь
 * недопустимо, по нему установщик сносит уже уехавшее дерево.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 180_000;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

const workDir = await mkdtemp(join(tmpdir(), 'verify-deadline-'));
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

/** Файлов столько, чтобы список не поместился в одну команду */
const FILE_COUNT = 250;
/** Срок, которого заведомо не хватит даже на первую команду */
const HOPELESS_MS = 1;
/** Срок, которого хватит на всю сверку с запасом */
const AMPLE_MS = 60_000;

const fileName = (index: number) => `file-${String(index).padStart(3, '0')}.txt`;

describe.each(LAB_SERVERS)('Срок сверки — $name', { timeout: LIVE_TIMEOUT_MS }, (server) => {
  const executor = new SSHExecutor();
  const remoteDir = `/tmp/verify-deadline-${server.port}`;
  const source = join(workDir, `tree-${server.port}`);
  const config = {
    host: '127.0.0.1',
    port: server.port,
    username: 'root',
    privateKeyPath: LAB_KEY,
    strictHostKeyChecking: 'no' as const,
    ignoreUserConfig: true,
  };

  let entries: { path: string; hash: string }[] = [];

  /** Сколько файлов на сервере — по одной строке на файл, без разбора имён */
  const remoteFileCount = async (): Promise<number> => {
    const result = await executor.execute(config, `find '${remoteDir}' -type f -exec echo x ';'`, {
    });
    return result.stdout.split('\n').filter((line) => line.trim() === 'x').length;
  };

  /**
   * Исполнитель, запоминающий срок каждой команды: утверждение о дроблении
   * срока проверяется по отправленному, а не выводится из ответа.
   */
  const recording = () => {
    const timeouts: number[] = [];
    const proxy = {
      passport: (target: unknown) => executor.passport(target as never),
      execute: (...args: unknown[]) => {
        timeouts.push((args[2] as { timeout: number }).timeout);
        return (executor.execute as (...rest: unknown[]) => unknown)(...args);
      },
    };
    return { proxy, timeouts };
  };

  beforeAll(async () => {
    if (unavailable) return;
    await mkdir(source, { recursive: true });
    await executor.execute(config, `rm -rf '${remoteDir}'`, {});

    entries = [];
    for (let index = 0; index < FILE_COUNT; index++) {
      const local = join(source, fileName(index));
      await writeFile(local, `content-${index}\n`);
      entries.push({ path: `${remoteDir}/${fileName(index)}`, hash: await sha256OfFile(local) });
    }

    // Дерево доставляется без сверки: она здесь предмет проверки, и заводить её
    // на подготовке значило бы проверять себя собой
    await new TransferTool().handleCall({
      params: {
        name: 'ssh_upload',
        arguments: {
          profile: server.name,
          local_path: source,
          remote_path: remoteDir,
          recursive: true,
          verify: false,
        },
      },
    } as never);
  });

  afterAll(async () => {
    if (unavailable) return;
    await executor
      .execute(config, `rm -rf '${remoteDir}'`, {})
      .catch(() => undefined);
    await closeAllRunners();
  });

  it.skipIf(unavailable)('честного срока хватает, и каждой команде достаётся остаток', async () => {
    const { proxy, timeouts } = recording();

    const outcome = await verifyRemoteFiles(proxy as never, config, entries, {
      timeoutMs: AMPLE_MS,
    });

    expect(outcome).toEqual({ status: 'matched' });
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts[0]).toBeLessThanOrEqual(AMPLE_MS);
    // Строгое убывание и есть отсутствие множителя: иначе каждая получила бы AMPLE_MS
    for (let index = 1; index < timeouts.length; index++) {
      expect(timeouts[index]).toBeLessThan(timeouts[index - 1]);
    }
  });

  it.skipIf(unavailable)('исчерпанный срок — «проверить нечем», и дерево остаётся целым', async () => {
    const outcome = await verifyRemoteFiles(executor, config, entries, {
      timeoutMs: HOPELESS_MS,
    });

    expect(outcome.status).toBe('unavailable');
    expect(await remoteFileCount()).toBe(FILE_COUNT);
  });

  it.skipIf(unavailable)('после исчерпанного срока сверка тем же списком сходится', async () => {
    // Убитая по сроку команда не должна ломать соединение: следующая сверка
    // без потолка обязана пройти обычным порядком
    const outcome = await verifyRemoteFiles(executor, config, entries, {
    });

    expect(outcome).toEqual({ status: 'matched' });
  });
});
