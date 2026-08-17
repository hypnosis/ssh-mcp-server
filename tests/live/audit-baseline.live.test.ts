/**
 * Живая проверка: обзор сервера собирается из настоящего вывода, а не из
 * представлений о нём.
 *
 * Наборы утилит на двух серверах расходятся молча: на одном сокеты показывает
 * `netstat` с выравниванием в несколько пробелов, на другом нет ни его, ни `ss`.
 * Юниты подают заготовленный текст и такого расхождения не видят.
 *
 * Главное здесь — инвариант честного ответа: пустой список либо объяснён, либо
 * это настоящая пустота. Молча пустой раздел агент прочитает как «на сервере
 * ничего такого нет».
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'audit-live-'));

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

const { AuditTool } = await import('../../src/tools/audit-tool.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живой обзор сервера', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой обзор сервера — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  afterAll(async () => {
    await closeAllRunners();
  });

  for (const server of LAB_SERVERS) {
    describe(`Обзор сервера: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const audit = new AuditTool();

      const baseline = async (): Promise<any> => {
        const response = await audit.handleCall({
          params: { name: 'ssh_audit_baseline', arguments: { profile: server.name } },
        } as never);
        const text = response.content[0].text;
        return { text, parsed: JSON.parse(text.split('--- raw JSON ---')[1]) };
      };

      it('узнаёт машину, на которой побывал', async () => {
        const { parsed } = await baseline();

        expect(parsed.hostname).not.toBe('');
        expect(parsed.kernel).not.toBe('');
        expect(parsed.os).not.toBe('');
      });

      it('разбирает диски настоящего df, а не оставляет их строкой', async () => {
        const { parsed } = await baseline();

        expect(parsed.disk.length).toBeGreaterThan(0);
        for (const disk of parsed.disk) {
          expect(disk.mount.startsWith('/')).toBe(true);
          expect(Number.isInteger(disk.pct)).toBe(true);
          expect(disk.pct).toBeGreaterThanOrEqual(0);
          expect(disk.pct).toBeLessThanOrEqual(100);
        }
      });

      it('разбирает память настоящего free, а не отвечает «n/a»', async () => {
        const { parsed } = await baseline();

        expect(parsed.memory.total).not.toBe('n/a');
        expect(parsed.memory.available).not.toBe('n/a');
      });

      /**
       * Половина серверов лаборатории отвечает `netstat`, половина не отвечает
       * ничем — и оба исхода допустимы. Недопустим третий: пусто и без причины.
       */
      it('пустой список слушателей объяснён, а не оставлен молча', async () => {
        const { parsed, text } = await baseline();

        if (parsed.net.listeners.length === 0) {
          expect(parsed.unavailable).toContain(
            'listeners (neither ss nor netstat on the server)'
          );
          expect(text).toContain('NOT CHECKED:');
        } else {
          for (const listener of parsed.net.listeners) {
            expect(listener.address).toMatch(/:\d+$/);
          }
        }
      });

      it('о разделах, которые проверить было чем, не пишет «нечем»', async () => {
        const { parsed } = await baseline();

        expect(parsed.unavailable).not.toContain('disk (df gave no output)');
      });

      it('сводка и её разбор говорят одно и то же', async () => {
        const { parsed, text } = await baseline();

        expect(text).toContain(`host:    ${parsed.hostname}`);
        expect(text).toContain(`listeners (${parsed.net.listeners.length}):`);
      });
    });
  }
}
