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
const TOOLS_WITH_OUTPUT_SCHEMA = [
  'ssh_audit_baseline',
  'ssh_disk_breakdown',
  'ssh_download',
  'ssh_exec',
  'ssh_file_write',
  'ssh_job_list',
  'ssh_job_status',
  'ssh_monitor',
  'ssh_service_status',
  'ssh_snapshot',
  'ssh_tls_check',
  'ssh_upload',
];

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

describe('Кто отвечает', () => {
  it('называет себя именем пакета', () => {
    expect(client.getServerVersion()?.name).toBe('ssh-mcp-server');
  });
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

/**
 * Схема ответа — обещание клиенту: он сверяет пришедшее с объявленным и на
 * расхождении возвращает ошибку протокола вместо ответа. Поэтому здесь
 * сторожатся сами обязательные поля, а не только факт объявления схемы.
 */
describe('Обещанные поля ответа', () => {
  it('разбор службы обязан нести исход и все пять полей', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_service_status')?.outputSchema as any;

    expect(schema.required).toEqual([
      'unit',
      'outcome',
      'enabled',
      'active_state',
      'sub_state',
      'restart',
      'restart_after',
      'status_head',
      'recent_log',
    ]);
    expect(schema.properties.outcome.enum).toEqual(['checked', 'no_systemd', 'no_unit']);
  });

  it('сводка команд обязана нести список команд и место под задачу', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_exec')?.outputSchema as any;

    expect(schema.required).toEqual(['commands', 'job_id']);
    expect(schema.properties.commands.items.required).toEqual([
      'command',
      'exit_code',
      'truncated',
      'timed_out',
      'blocked',
      'blocked_reason',
      'not_run',
      'warning',
    ]);
  });

  /**
   * Ноль это факт о команде, `null` — признание, что кода нет вовсе. Схема,
   * запрещающая `null`, превратила бы честный ответ об оборванном вызове
   * в ошибку протокола.
   */
  it('код команды объявлен и числом, и пустотой', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_exec')?.outputSchema as any;

    expect(schema.properties.commands.items.properties.exit_code.type).toEqual(['number', 'null']);
  });

  /**
   * Состояние решает, чем на этой машине вообще можно пользоваться, поэтому
   * список его значений — часть обещания, а не подробность реализации.
   */
  it('сводка связи обязана нести состояние и все четыре поля', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_monitor')?.outputSchema as any;

    expect(schema.required).toEqual([
      'action',
      'profile',
      'state',
      'latency_ms',
      'exit_code',
      'legend',
    ]);
    expect(schema.properties.state.enum).toEqual(['ready', 'limited', 'no-route', 'rejected', null]);
  });

  /**
   * Действие выбирает вызывающий, и список — часть обещания наравне с
   * состоянием: пропавшее имя читается как «такого действия нет».
   */
  it('сводка связи обещает все пять действий', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_monitor')?.outputSchema as any;

    expect(schema.properties.action.enum).toEqual(['stats', 'reload', 'test', 'list', 'close']);
  });

  /**
   * Легенда обещана схемой, иначе клиент отбракует ответ с ней как лишнее
   * поле, а не расшифрует слово.
   */
  it.each([
    ['ssh_monitor'],
    ['ssh_job_status'],
    ['ssh_job_list'],
    ['ssh_file_write'],
    ['ssh_upload'],
    ['ssh_download'],
  ])('%s объявляет легенду словарём строк', async (name) => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === name)?.outputSchema as any;

    expect(schema.properties.legend.type).toBe('object');
    expect(schema.properties.legend.additionalProperties).toEqual({ type: 'string' });
  });

  /**
   * «Не просили проверять» и «проверили, сошлось» в тексте различаются
   * пустотой в конце строки. Три исхода обещаны полем, поэтому их набор
   * сторожится у всех трёх инструментов сразу.
   */
  it.each([['ssh_file_write'], ['ssh_upload'], ['ssh_download']])(
    '%s обещает исход сверки одним из трёх слов',
    async (name) => {
      const { tools } = await client.listTools();
      const schema = tools.find((tool: Tool) => tool.name === name)?.outputSchema as any;

      expect(schema.required).toEqual(['files', 'legend']);
      expect(schema.properties.files.items.required).toEqual([
        'path',
        'written',
        'verified',
        'reason',
        'bytes',
      ]);
      expect(schema.properties.files.items.properties.verified.enum).toEqual([
        'verified',
        'unavailable',
        'skipped',
      ]);
    }
  );

  /**
   * Исходов четыре, и описание инструмента раньше обещало три. Набор значений
   * стережётся здесь, чтобы обещание и код расходились не молча.
   */
  it.each([['ssh_job_status'], ['ssh_job_list']])('%s обещает четыре состояния задачи', async (name) => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === name)?.outputSchema as any;

    expect(schema.required).toEqual(['jobs', 'legend']);
    expect(schema.properties.jobs.items.required).toEqual([
      'id',
      'state',
      'exit_code',
      'pid',
      'started_at',
    ]);
    expect(schema.properties.jobs.items.properties.state.enum).toEqual([
      'running',
      'finished',
      'lost',
      'missing',
    ]);
  });

  it('шапка снимка обязана нести числа и список непроверенного', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_snapshot')?.outputSchema as any;

    expect(schema.required).toEqual([
      'disk_pct',
      'mem_pct',
      'cpu_pct',
      'load',
      'containers',
      'ports',
      'unavailable',
    ]);
  });

  it('разбор диска обязан нести секции и список непроверенного', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool: Tool) => tool.name === 'ssh_disk_breakdown')?.outputSchema as any;

    expect(schema.required).toEqual([
      'filesystems',
      'largest',
      'var_log',
      'cache',
      'docker',
      'journald',
      'unavailable',
    ]);
    expect(schema.properties.filesystems.items.required).toEqual([
      'filesystem',
      'type',
      'size',
      'used',
      'avail',
      'pct',
      'mount',
    ]);
    expect(schema.properties.docker.type).toEqual(['string', 'null']);
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
