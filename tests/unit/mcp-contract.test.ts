/**
 * Контракт MCP-слоя: что клиент видит в списке и что получает на вызов.
 *
 * Имена инструментов — часть опубликованного пакета, поэтому список здесь
 * заведён поимённо: пропажа и переименование должны краснеть, а не
 * подстраиваться под код.
 *
 * Профили уводятся на несуществующий файл: инструменты обязаны отказать до
 * первой сетевой попытки, и тест остаётся чистым юнитом.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../src/mcp-server.js';

/** Полный список инструментов пакета */
const PUBLISHED_TOOLS = [
  'ssh_audit_baseline',
  'ssh_disk_breakdown',
  'ssh_download',
  'ssh_exec',
  'ssh_file_list',
  'ssh_file_read',
  'ssh_file_write',
  'ssh_job_kill',
  'ssh_job_list',
  'ssh_job_output',
  'ssh_job_status',
  'ssh_log_search',
  'ssh_log_tail',
  'ssh_monitor',
  'ssh_service_status',
  'ssh_snapshot',
  'ssh_tls_check',
  'ssh_upload',
];

/**
 * Инструменты, обещающие клиенту разбор ответа. Обещание проверяется на месте:
 * клиент требует разбор от каждого ответа такого инструмента, поэтому снятая
 * схема — молчаливая смена контракта, а не мелкая правка объявления.
 */
const TOOLS_WITH_OUTPUT_SCHEMA = ['ssh_audit_baseline', 'ssh_tls_check'];

const MISSING_PROFILES_FILE = '/nonexistent/ssh-mcp-contract-profiles.json';

let client: Client;
let previousProfilesFile: string | undefined;

beforeAll(async () => {
  previousProfilesFile = process.env.SSH_PROFILES_FILE;
  process.env.SSH_PROFILES_FILE = MISSING_PROFILES_FILE;

  const { server } = createMcpServer('test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'contract-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  if (previousProfilesFile === undefined) {
    delete process.env.SSH_PROFILES_FILE;
  } else {
    process.env.SSH_PROFILES_FILE = previousProfilesFile;
  }
});

describe('Список инструментов', () => {
  it('отдаёт ровно те имена, что обещает пакет', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool: Tool) => tool.name).sort()).toEqual(PUBLISHED_TOOLS);
  });

  it('у каждого инструмента есть описание и схема входа', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name}: пустое описание`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name}: схема не объект`).toBe('object');
    }
  });

  it('схему ответа объявляют ровно те инструменты, что её обещают', async () => {
    const { tools } = await client.listTools();
    const withSchema = tools
      .filter((tool: Tool) => tool.outputSchema !== undefined)
      .map((tool: Tool) => tool.name)
      .sort();

    expect(withSchema).toEqual(TOOLS_WITH_OUTPUT_SCHEMA);
  });
});

describe('Маршрут вызова', () => {
  it.each(PUBLISHED_TOOLS)('%s объявлен, подключён и отказывает с признаком провала', async (name) => {
    const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
    expect(Array.isArray(result.content), `${name}: ответ без содержимого`).toBe(true);
    // профилей нет, поэтому любой вызов здесь — отказ, и он обязан быть виден флагом
    expect(result.isError, `${name}: отказ пришёл без isError`).toBe(true);
  });

  it('незнакомое имя получает отказ протокола', async () => {
    await expect(client.callTool({ name: 'ssh_not_a_tool', arguments: {} })).rejects.toThrow(
      /Unknown tool: ssh_not_a_tool/
    );
  });
});
