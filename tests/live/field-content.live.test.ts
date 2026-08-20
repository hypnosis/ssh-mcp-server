/**
 * Живая проверка: содержание ответа едет в полях, а не только в тексте.
 *
 * Клиент, у которого инструмент объявил схему, показывает вызывающему одни
 * поля и отбрасывает текстовый блок целиком. Всё, что мы оставляли в тексте —
 * вывод команды, найденные строки, имена машин, секции обзора, — до него не
 * доезжало вовсе.
 *
 * Юнит с моком этого не докажет: там ответ собирает тот же человек, что и
 * ожидание. Здесь вывод печатает настоящий сервер, и наборы утилит на двух
 * контейнерах расходятся молча, поэтому каждый вызов идёт на оба.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  LAB_CONTROL_DIR,
  LAB_KEY,
  LAB_PASSWORD,
  LAB_REQUIRED,
  LAB_SERVERS,
  labUnavailableReason,
} from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'field-content-live-'));

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries([
      ...LAB_SERVERS.map((server) => [
        server.name,
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'root',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        },
      ]),
      // Пароль до sudo доходит только отсюда: у ключевого профиля его нет вовсе
      ...LAB_SERVERS.map((server) => [
        `${server.name}/pw`,
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'pwuser',
          password: LAB_PASSWORD,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        },
      ]),
    ]),
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { createMcpServer } = await import('../../src/mcp-server.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живое содержание полей', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живое содержание полей — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'field-content-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Сверку ответа со схемой клиент включает, только собрав список инструментов
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
  });

  const callTool = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  describe('имена машин', { timeout: LIVE_TIMEOUT_MS }, () => {
    it('листинг отдаёт имена полем, а не одним словом «list»', async () => {
      const result = await callTool('ssh_monitor', { action: 'list' });
      const summary = result.structuredContent as any;

      expect(summary.profiles).toContain(LAB_SERVERS[0].name);
      expect(summary.profiles).toContain(LAB_SERVERS[1].name);
    });
  });

  for (const server of LAB_SERVERS) {
    describe(`Содержание в полях: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const profile = server.name;
      const passwordProfile = `${server.name}/pw`;

      it('вывод команды приезжает в полях', async () => {
        const result = await callTool('ssh_exec', { profile, command: 'echo метка-вывода' });
        const command = (result.structuredContent as any).commands[0];

        expect(command.stdout).toContain('метка-вывода');
        expect(command.clipped_bytes).toBe(0);
      });

      it('поток ошибок приезжает отдельно от обычного', async () => {
        const result = await callTool('ssh_exec', {
          profile,
          command: 'echo в-вывод; echo в-ошибки >&2',
        });
        const command = (result.structuredContent as any).commands[0];

        expect(command.stdout).toContain('в-вывод');
        expect(command.stderr).toContain('в-ошибки');
      });

      /** Пустая строка — «команда промолчала», отсутствие поля — «не выполнялась» */
      it('молчаливая команда даёт пустую строку, а не отсутствие поля', async () => {
        const result = await callTool('ssh_exec', { profile, command: 'true' });
        const command = (result.structuredContent as any).commands[0];

        expect(command.stdout).toBe('');
        expect(command.stderr).toBe('');
      });

      it('длинный вывод обрезается, и вырезанное названо числом', async () => {
        const result = await callTool('ssh_exec', { profile, command: 'seq 1 60000' });
        const command = (result.structuredContent as any).commands[0];

        expect(command.clipped_bytes).toBeGreaterThan(0);
        expect(command.stdout).toContain('── clipped');
        // Оба конца на месте: у таблиц смысл в начале, у логов — в конце
        expect(command.stdout.startsWith('1\n')).toBe(true);
        expect(command.stdout.trimEnd().endsWith('60000')).toBe(true);
      });

      it('обрезка не оставляет следов разрезанного знака', async () => {
        const result = await callTool('ssh_exec', {
          profile,
          command: 'i=0; while [ $i -lt 20000 ]; do echo "строка-$i-текст"; i=$((i+1)); done',
        });
        const command = (result.structuredContent as any).commands[0];

        expect(command.clipped_bytes).toBeGreaterThan(0);
        expect(command.stdout).not.toContain('�');
      });

      it('найденные строки приезжают с номерами, а соседи помечены', async () => {
        const path = `/tmp/field-content-${process.pid}.log`;
        await callTool('ssh_exec', {
          profile,
          command: `printf 'один\\nERROR два\\nтри\\n' > ${path}`,
        });

        const result = await callTool('ssh_log_search', {
          profile,
          path,
          query: 'ERROR',
          context: 1,
        });
        const outcome = result.structuredContent as any;

        const match = outcome.lines.find((line: any) => line.context === false);
        expect(match.text).toContain('ERROR');
        expect(match.line).toBe(2);
        expect(match.file).toBe(path);
        expect(outcome.lines.filter((line: any) => line.context === true)).toHaveLength(2);

        await callTool('ssh_exec', { profile, command: `rm -f ${path}` });
      });

      /**
       * Пароль профиля — единственное, что можно предъявить sudo: терминала,
       * на котором он спросил бы сам, у нас нет, и без пароля он отказывает.
       */
      it('sudo на парольном профиле поднимает права', async () => {
        const result = await callTool('ssh_exec', {
          profile: passwordProfile,
          command: 'id -un',
          sudo: true,
        });
        const command = (result.structuredContent as any).commands[0];

        expect(command.stdout.trim()).toBe('root');
        expect(command.exit_code).toBe(0);
      });

      it('пароль не подмешивается к данным, которые команда читает с ввода', async () => {
        const path = `/tmp/field-content-stdin-${process.pid}.conf`;
        await callTool('ssh_file_write', {
          profile: passwordProfile,
          files: [{ path, content: 'key = value\n' }],
          sudo: true,
        });

        const read = await callTool('ssh_file_read', { profile: passwordProfile, path, sudo: true });
        const text = (read.content as Array<{ text: string }>).map((part) => part.text).join('');

        expect(text).toContain('key = value');
        expect(text).not.toContain(LAB_PASSWORD);

        await callTool('ssh_exec', { profile: passwordProfile, command: `rm -f ${path}`, sudo: true });
      });
    });
  }
}
