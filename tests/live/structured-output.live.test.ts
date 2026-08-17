/**
 * Живая проверка: разбор ответа достаётся клиенту готовым, а не выковыривается
 * из текста.
 *
 * Сетка поднимает настоящего клиента поверх настоящего сервера, поэтому здесь
 * работает клиентская проверка схемы: расхождение объявленного с уехавшим
 * возвращается ошибкой протокола вместо ответа. Ни юнит с моком, ни прямой
 * вызов класса такого не покажут — там объявление и данные никто не сверяет.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/** Инструменты, чей ответ обязан приезжать разобранным */
const STRUCTURED_TOOLS = ['ssh_audit_baseline', 'ssh_tls_check'];

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'structured-live-'));

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
  describe('живой разбор ответа', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой разбор ответа — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'structured-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
  });

  describe('Объявление схемы ответа', () => {
    it.each(STRUCTURED_TOOLS)('%s обещает клиенту разбор', async (name) => {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate: Tool) => candidate.name === name);

      expect(tool?.outputSchema, `${name}: схемы ответа нет в списке`).toBeDefined();
      expect(tool?.outputSchema?.type).toBe('object');
    });
  });

  for (const server of LAB_SERVERS) {
    describe(`Разбор ответа: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      it('обзор сервера приезжает разобранным и совпадает с текстом', async () => {
        const result = (await client.callTool({
          name: 'ssh_audit_baseline',
          arguments: { profile: server.name },
        })) as CallToolResult;

        const parsed = result.structuredContent as any;
        expect(parsed, 'обзор пришёл без разбора').toBeDefined();
        expect(parsed.hostname).not.toBe('');
        expect(Array.isArray(parsed.unavailable)).toBe(true);
        expect(Array.isArray(parsed.red_flags.critical)).toBe(true);

        const text = (result.content as any[])[0].text as string;
        expect(text).toContain(`host:    ${parsed.hostname}`);
      });

      /**
       * Разбор добавлен, а текст оставлен: клиент, который читал JSON из него,
       * работать не перестал.
       */
      it('текст обзора по-прежнему несёт тот же JSON', async () => {
        const result = (await client.callTool({
          name: 'ssh_audit_baseline',
          arguments: { profile: server.name },
        })) as CallToolResult;

        const text = (result.content as any[])[0].text as string;
        const fromText = JSON.parse(text.split('--- raw JSON ---')[1]);
        expect(fromText).toEqual(result.structuredContent);
      });

      /**
       * Сертификата на контейнере нет, поэтому здесь проверяется третий исход:
       * «проверить нечем» уезжает разбором с пустыми полями, а не отказом.
       */
      it('непрочитанный сертификат приезжает разбором, а не отказом', async () => {
        const result = (await client.callTool({
          name: 'ssh_tls_check',
          arguments: { profile: server.name, domain: 'localhost' },
        })) as CallToolResult;

        expect(result.isError, 'нечем проверить — это не провал').toBeFalsy();
        const parsed = result.structuredContent as any;
        expect(parsed.domain).toBe('localhost');
        expect(parsed.not_after).toBeNull();
        expect(parsed.days_until_expiry).toBeNull();
        expect(parsed.san_includes_hostname).toBeNull();
      });
    });
  }

  describe('Отказ при объявленной схеме ответа', () => {
    it.each(STRUCTURED_TOOLS)('%s отказывает флагом, а не ошибкой протокола', async (name) => {
      const result = (await client.callTool({
        name,
        arguments: { profile: 'no-such-profile-here', domain: 'localhost' },
      })) as CallToolResult;

      expect(result.isError, `${name}: отказ пришёл без признака провала`).toBe(true);
      expect(result.structuredContent, `${name}: у отказа разбора быть не должно`).toBeUndefined();
    });
  });
}
