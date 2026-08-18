/**
 * Живая проверка сводки: клиент сверяет пришедшее с объявленной схемой.
 *
 * Юнит с моком этого не покажет — там объявление и данные никто не сверяет, и
 * лишнее поле или `null` там, где схема его не допускает, доезжают молча. Здесь
 * расхождение возвращается ошибкой протокола вместо ответа.
 *
 * Наборы утилит на контейнерах расходятся молча, поэтому каждый вызов идёт на
 * оба: сторож времени отвечает кодом 124 на coreutils и 143 на BusyBox.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'answer-summary-live-'));

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
  describe('живая сводка ответа', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живая сводка ответа — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'answer-summary-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
  });

  const callTool = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  for (const server of LAB_SERVERS) {
    describe(`Сводка ответа: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const profile = server.name;

      it('в пачке видно, какая команда упала, без чтения блоков', async () => {
        const result = await callTool('ssh_exec', {
          profile,
          command: ['echo one', 'exit 7', 'echo three'],
        });

        const summary = result.structuredContent as any;
        expect(summary.commands.map((entry: any) => entry.exit_code)).toEqual([0, 7, 0]);
        expect(summary.job_id).toBeNull();
      });

      /** Ноль в поле есть всегда, хотя текст его при успехе не печатает */
      it('успешная одиночная команда названа нулём, а не молчанием', async () => {
        const result = await callTool('ssh_exec', { profile, command: 'true' });

        const summary = result.structuredContent as any;
        expect(summary.commands).toHaveLength(1);
        expect(summary.commands[0].exit_code).toBe(0);
        expect(summary.commands[0].timed_out).toBe(false);
      });

      /**
       * Сторож времени на сервере отвечает 124 у coreutils и 143 у BusyBox —
       * оба обязаны читаться как «мы не дождались», а не как ответ команды.
       */
      it('убитая сторожем команда помечена, а её код доезжает как есть', async () => {
        const result = await callTool('ssh_exec', {
          profile,
          command: 'sleep 5',
          timeout: 1500,
        });

        const summary = result.structuredContent as any;
        const first = summary.commands[0];
        expect([124, 143, null]).toContain(first.exit_code);
        expect(first.timed_out).toBe(true);
      });

      it('отказ сторожа удаления называет виновную команду и невыполненные', async () => {
        const result = await callTool('ssh_exec', {
          profile,
          command: ['echo before', 'rm -rf /', 'echo after'],
        });

        const summary = result.structuredContent as any;
        expect(result.isError).toBe(true);
        expect(summary.commands[1].blocked).toBe(true);
        expect(summary.commands[1].blocked_reason).toBeTruthy();
        expect(summary.commands.map((entry: any) => entry.not_run)).toEqual([true, false, true]);
      });

      it('связь названа состоянием, а не первой строкой текста', async () => {
        const result = await callTool('ssh_monitor', { action: 'test', profile });

        const summary = result.structuredContent as any;
        expect(summary.state).toBe('ready');
        expect(summary.profile).toBe(profile);
        expect(summary.latency_ms).toBeGreaterThan(0);
      });

      it('сверенная запись говорит об этом словом', async () => {
        const path = `/tmp/summary-live-${Date.now()}.txt`;
        const result = await callTool('ssh_file_write', {
          profile,
          files: { path, content: 'summary probe\n', verify: true },
        });

        const summary = result.structuredContent as any;
        expect(summary.files[0]).toMatchObject({ path, written: true, verified: 'verified' });
        expect(summary.files[0].bytes).toBe(14);

        await callTool('ssh_exec', { profile, command: `rm -f ${path}` });
      });

      it('запись без просьбы сверять — отдельный исход, а не сверка, что прошла', async () => {
        const path = `/tmp/summary-live-plain-${Date.now()}.txt`;
        const result = await callTool('ssh_file_write', {
          profile,
          files: { path, content: 'plain\n' },
        });

        expect((result.structuredContent as any).files[0].verified).toBe('skipped');

        await callTool('ssh_exec', { profile, command: `rm -f ${path}` });
      });

      it('фоновая задача приходит с идентификатором и без выдуманного кода', async () => {
        const started = await callTool('ssh_exec', {
          profile,
          command: 'sleep 2',
          detach: true,
        });

        const summary = started.structuredContent as any;
        expect(summary.job_id).toBeTruthy();
        expect(summary.commands[0].exit_code).toBeNull();

        const status = await callTool('ssh_job_status', { profile, id: summary.job_id });
        const job = (status.structuredContent as any).jobs[0];
        expect(job.id).toBe(summary.job_id);
        expect(['running', 'finished']).toContain(job.state);

        const listed = await callTool('ssh_job_list', { profile });
        const ids = (listed.structuredContent as any).jobs.map((entry: any) => entry.id);
        expect(ids).toContain(summary.job_id);

        await callTool('ssh_job_kill', { profile, id: summary.job_id });
      });

      it('несуществующая задача названа словом missing, а не пропажей', async () => {
        const result = await callTool('ssh_job_status', { profile, id: 'nosuchjob-00000000' });

        expect((result.structuredContent as any).jobs[0]).toMatchObject({
          state: 'missing',
          exit_code: null,
          pid: null,
        });
      });

      it('шапка снимка приходит числами, а непроверенное — списком', async () => {
        const result = await callTool('ssh_snapshot', { profile });

        const summary = result.structuredContent as any;
        expect(Array.isArray(summary.unavailable)).toBe(true);
        for (const field of ['disk_pct', 'mem_pct', 'cpu_pct', 'ports']) {
          const measured = summary[field] !== null;
          expect(
            measured || summary.unavailable.includes(field),
            `${field}: пусто и не названо в unavailable`
          ).toBe(true);
        }
      });
    });
  }
}
