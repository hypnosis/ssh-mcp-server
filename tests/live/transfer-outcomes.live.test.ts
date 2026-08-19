/**
 * Живая проверка трёх исходов сверки у передачи.
 *
 * Исход решает, снесёт ли установщик уехавшее, а полем он не приходит: в
 * `transferredFile` он собирается из булева и примечания, и потерянное
 * примечание молча превращает «проверить было нечем» в «никто не просил».
 * Мок этой границы не покажет — он отвечает тем, что в нём написано.
 *
 * Роутерный узел лаборатории — единственный без `sha256sum` и без `openssl`:
 * там сверка не выполняется по-настоящему, а не понарошку.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  LAB_CONTROL_DIR,
  LAB_KEY,
  LAB_REQUIRED,
  LAB_ROUTER,
  LAB_SERVERS,
  labUnavailableReason,
  routerUnavailableReason,
} from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/** Ответ передачи: одна запись на файл плюс легенда её слов */
interface FilesSummary {
  files: Array<{
    path: string;
    written: boolean;
    verified: 'verified' | 'unavailable' | 'skipped';
    reason: string | null;
    bytes: number | null;
  }>;
  legend: Record<string, string>;
}

const labReason = await labUnavailableReason();
const routerReason = await routerUnavailableReason();
const unavailable = labReason ?? routerReason;

const workDir = await mkdtemp(join(tmpdir(), 'transfer-outcomes-live-'));
const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries(
      [...LAB_SERVERS, LAB_ROUTER].map((server) => [
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

const { createMcpServer } = await import('../../src/mcp-server.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живые исходы сверки', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живые исходы сверки — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'transfer-outcomes-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Сверку ответа со схемой клиент включает, только собрав список
    // инструментов: без этого вызова поля читаются, но никем не проверяются
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });

  const callTool = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  const summaryOf = (result: CallToolResult): FilesSummary =>
    result.structuredContent as unknown as FilesSummary;

  /** Локальный файл под передачу: имя своё у каждой проверки */
  const localFile = async (name: string, text: string): Promise<string> => {
    const path = join(workDir, name);
    await writeFile(path, text);
    return path;
  };

  const remove = (profile: string, remotePath: string) =>
    callTool('ssh_exec', { profile, command: `rm -rf ${remotePath}` });

  for (const server of [...LAB_SERVERS, LAB_ROUTER]) {
    const profile = server.name;
    /** На роутере сверять нечем — там же и проверяется третий исход */
    const hashless = server === LAB_ROUTER;

    describe(`Исходы сверки: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      it('отправка со сверкой называет исход, а не молчит о нём', async () => {
        const local = await localFile(`upload-${server.container}.txt`, 'upload probe\n');
        const remotePath = `/tmp/outcomes-upload-${server.container}.txt`;

        const result = await callTool('ssh_upload', {
          profile,
          local_path: local,
          remote_path: remotePath,
        });

        const file = summaryOf(result).files[0];
        expect(file.written).toBe(true);
        expect(file.path).toBe(remotePath);
        expect(file.verified).toBe(hashless ? 'unavailable' : 'verified');
        expect(file.bytes).toBe(13);

        await remove(profile, remotePath);
      });

      it('скачивание со сверкой называет тот же исход', async () => {
        const remotePath = `/tmp/outcomes-download-${server.container}.txt`;
        await callTool('ssh_exec', {
          profile,
          command: `printf 'download probe\\n' > ${remotePath}`,
        });
        const local = join(workDir, `download-${server.container}.txt`);

        const result = await callTool('ssh_download', {
          profile,
          remote_path: remotePath,
          local_path: local,
        });

        const file = summaryOf(result).files[0];
        expect(file.written).toBe(true);
        expect(file.verified).toBe(hashless ? 'unavailable' : 'verified');
        expect(await readFile(local, 'utf8')).toBe('download probe\n');

        await remove(profile, remotePath);
      });

      it('отправка без просьбы сверять — отдельный исход, а не сверка, что прошла', async () => {
        const local = await localFile(`plain-${server.container}.txt`, 'plain probe\n');
        const remotePath = `/tmp/outcomes-plain-${server.container}.txt`;

        const result = await callTool('ssh_upload', {
          profile,
          local_path: local,
          remote_path: remotePath,
          verify: false,
        });

        const file = summaryOf(result).files[0];
        expect(file.written).toBe(true);
        expect(file.verified).toBe('skipped');
        expect(file.reason).toBeNull();

        await remove(profile, remotePath);
      });
    });
  }

  describe(`Сверять нечем: ${LAB_ROUTER.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
    const profile = LAB_ROUTER.name;

    it('пометка называет, чего не хватило, и это не отказ', async () => {
      const local = await localFile('hashless.txt', 'hashless probe\n');
      const remotePath = '/tmp/outcomes-hashless.txt';

      const result = await callTool('ssh_upload', {
        profile,
        local_path: local,
        remote_path: remotePath,
      });

      expect(result.isError).toBeFalsy();
      const file = summaryOf(result).files[0];
      expect(file.verified).toBe('unavailable');
      expect(file.reason).toContain('sha256sum');

      await remove(profile, remotePath);
    });

    it('легенда объясняет исход, которым ответ пришёл, а не соседний', async () => {
      const local = await localFile('legend.txt', 'legend probe\n');
      const remotePath = '/tmp/outcomes-legend.txt';

      const result = await callTool('ssh_upload', {
        profile,
        local_path: local,
        remote_path: remotePath,
      });

      const legend = summaryOf(result).legend;
      expect(legend['files[].verified=unavailable']).toContain('nothing to work with');
      expect(legend['files[].verified=verified']).toBeUndefined();

      await remove(profile, remotePath);
    });

    it('запись со сверкой на том же узле говорит «нечем», а не «сошлось»', async () => {
      const remotePath = '/tmp/outcomes-write.txt';

      const result = await callTool('ssh_file_write', {
        profile,
        files: { path: remotePath, content: 'write probe\n', verify: true },
      });

      expect(result.isError).toBeFalsy();
      const file = summaryOf(result).files[0];
      expect(file.written).toBe(true);
      expect(file.verified).toBe('unavailable');

      await remove(profile, remotePath);
    });
  });
}
