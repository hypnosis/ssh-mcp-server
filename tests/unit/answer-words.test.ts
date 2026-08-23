/**
 * Unit tests: объяснены ли слова, которыми отвечают инструменты.
 *
 * Значение вроде `lost` или `no_access` решает, что агент сделает дальше, а
 * план он строит до первого вызова — когда легенды, приезжающей вместе с
 * ответом, у него ещё нет. Замер на чистых агентах показал цену молчания:
 * шесть значений из шести полей остались нерасшифрованными, и агент честно
 * писал «не знаю, что значит X» вместо того, чтобы назвать реакцию.
 *
 * Отсюда два сторожа. Первый: у поля с перечислением названы все его
 * значения — иначе добавленное завтра значение молча приедет голым. Второй:
 * расшифровка в объявлении и расшифровка в легенде идут из одного словаря,
 * потому что двум источникам истины расходиться не запрещено ничем.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../src/mcp-server.js';
import { meaningsList } from '../../src/tools/legend.js';

/**
 * Поля ответа с перечислением, у которых значение меняет план вызывающего.
 * Список поимённый: новое поле обязано попасть либо сюда, либо в соседний
 * список самоочевидных — молча проскочить оно не может.
 */
const EXPLAINED = [
  'ssh_job_status: jobs[].state',
  'ssh_job_list: jobs[].state',
  'ssh_job_kill: outcome',
  'ssh_monitor: state',
  'ssh_service_status: outcome',
  'ssh_audit_baseline: firewall.ufw.status',
  'ssh_audit_baseline: firewall.iptables.status',
  'ssh_file_list: entries[].type',
  'ssh_file_write: files[].verified',
  'ssh_upload: files[].verified',
  'ssh_download: files[].verified',
];

/**
 * Поля, где перечисление ничего не решает: `action` повторяет то, о чём
 * попросили, а `signal` называет два общеизвестных сигнала — там важно не
 * значение, а то, что отправленное могло разойтись с заказанным.
 */
const SELF_EVIDENT = ['ssh_monitor: action', 'ssh_job_kill: signal'];

let client: Client;
let previousProfilesFile: string | undefined;

beforeAll(async () => {
  previousProfilesFile = process.env.SSH_PROFILES_FILE;
  process.env.SSH_PROFILES_FILE = '/nonexistent/ssh-mcp-words-profiles.json';

  const { server } = createMcpServer('test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'words-test', version: '1.0.0' }, { capabilities: {} });
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

interface EnumField {
  /** Инструмент и путь до поля — то, чем поле названо в списках выше */
  name: string;
  values: string[];
  description?: string;
}

/** Все поля с перечислением из схем ответа, вместе с путём до каждого */
function enumFields(tools: Tool[]): EnumField[] {
  const found: EnumField[] = [];

  const walk = (node: any, tool: string, path: string): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node.enum) && path) {
      found.push({
        name: `${tool}: ${path}`,
        values: node.enum.filter((value: unknown) => typeof value === 'string'),
        description: node.description,
      });
    }

    for (const [key, value] of Object.entries(node.properties ?? {})) {
      walk(value, tool, path ? `${path}.${key}` : key);
    }
    if (node.items) walk(node.items, tool, `${path}[]`);
  };

  for (const tool of tools) walk(tool.outputSchema, tool.name, '');
  return found;
}

describe('Слова ответа объяснены до вызова', () => {
  it('каждое поле с перечислением отнесено к объяснённым или к самоочевидным', async () => {
    const { tools } = await client.listTools();

    expect(enumFields(tools).map((field) => field.name).sort()).toEqual(
      [...EXPLAINED, ...SELF_EVIDENT].sort()
    );
  });

  it('у объяснённого поля названо каждое значение, а не часть из них', async () => {
    const { tools } = await client.listTools();

    for (const field of enumFields(tools).filter((f) => EXPLAINED.includes(f.name))) {
      expect(field.description, `${field.name} без описания`).toBeDefined();
      for (const value of field.values) {
        expect(field.description, `${field.name}: значение ${value} не объяснено`).toContain(value);
      }
    }
  });
});

describe('Объявление и легенда говорят одно и то же', () => {
  /**
   * Словарь один, но собран он в разных модулях. Проверяется совпадение
   * текста: разойдясь, объявление и легенда объяснят одно слово по-разному,
   * и вызывающий поверит тому, что прочёл раньше.
   */
  it('расшифровка в схеме собрана тем же словарём, что и легенда', async () => {
    const { tools } = await client.listTools();
    const fields = enumFields(tools);

    const state = fields.find((f) => f.name === 'ssh_job_status: jobs[].state')!;
    expect(state.description).toBe(
      meaningsList({
        running: 'started and still running: this is not the outcome, come back later',
        finished: 'the job ended and reported its exit code',
        lost: 'the job is gone and left no exit code behind',
        missing: 'the server knows no job under this id',
      })
    );

    const firewall = fields.find((f) => f.name === 'ssh_audit_baseline: firewall.ufw.status')!;
    expect(firewall.description).toBe(
      meaningsList({
        not_installed: 'the tool is absent from the server, so it filters nothing here',
        no_access: 'the tool is there, but reading its rules needs root: what it allows is unknown',
        read: 'the rules were read, and the fields beside this one come from them',
      })
    );
  });

  it('оба экрана объясняются одинаково, а не только первый', async () => {
    const { tools } = await client.listTools();
    const fields = enumFields(tools);

    expect(fields.find((f) => f.name === 'ssh_audit_baseline: firewall.iptables.status')!.description).toBe(
      fields.find((f) => f.name === 'ssh_audit_baseline: firewall.ufw.status')!.description
    );
  });
});
