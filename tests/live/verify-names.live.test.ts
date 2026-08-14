/**
 * Сверка дерева, в именах которого есть символы, ломающие вывод утилиты.
 *
 * Замерено на живых серверах: coreutils для имени с обратным слэшем, переводом
 * строки или возвратом каретки печатает строку в экранированном виде, BusyBox —
 * как есть, вместе с настоящим переводом строки. Разбор такую строку терял, файл
 * считался несовпавшим, и установщик сносил уже уехавшее дерево целиком. Debian
 * ломался там, где Alpine работал.
 *
 * Мок здесь бесполезен: он покажет ровно ту форму вывода, которую я в него
 * положу, — а вопрос как раз в том, какую печатает настоящая утилита.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

const workDir = await mkdtemp(join(tmpdir(), 'verify-names-'));
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

/** Имена, из-за которых вывод утилиты перестаёт быть построчным */
const AWKWARD_NAMES = ['plain.txt', 'a\\b.txt', 'a\nb.txt', 'a\rb.txt', 'a b.txt'];

describe.each(LAB_SERVERS)('Сверка трудных имён — $name', { timeout: LIVE_TIMEOUT_MS }, (server) => {
  const tool = new TransferTool();
  const executor = new SSHExecutor();
  const remoteDir = `/tmp/verify-names-${server.port}`;
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

  /**
   * Сколько файлов лежит на сервере. Считаем по одной строке на файл, а не
   * именами: имя с переводом строки сделало бы `find | wc -l` бессмысленным.
   */
  const remoteFileCount = async (): Promise<number> => {
    const result = await executor.execute(config, `find '${remoteDir}' -type f -exec echo x ';'`, {
    });
    return result.stdout.split('\n').filter((line) => line.trim() === 'x').length;
  };

  beforeAll(async () => {
    if (unavailable) return;
    await mkdir(source, { recursive: true });
    for (const name of AWKWARD_NAMES) await writeFile(join(source, name), `${name}\n`);
    await executor.execute(config, `rm -rf '${remoteDir}'`, {});
  });

  afterAll(async () => {
    if (unavailable) return;
    await executor
      .execute(config, `rm -rf '${remoteDir}'`, {})
      .catch(() => undefined);
    await closeAllRunners();
  });

  it.skipIf(unavailable)('дерево доезжает целиком, и сверка его принимает', async () => {
    const answer = await call('ssh_upload', {
      profile: server.name,
      local_path: source,
      remote_path: remoteDir,
      recursive: true,
      verify: true,
    });

    expect(answer.content[0].text).toContain(`verified (${AWKWARD_NAMES.length} files)`);
    expect(await remoteFileCount()).toBe(AWKWARD_NAMES.length);
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

    expect(answer.content[0].text).toContain(`verified (${AWKWARD_NAMES.length} files)`);
    await rm(target, { recursive: true, force: true });
  });
});
