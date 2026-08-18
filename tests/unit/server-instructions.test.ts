/**
 * Карта набора, которую клиент кладёт модели в системный промпт при
 * подключении.
 *
 * Текст берётся у настоящего клиента, а не у константы: поле уезжает только в
 * ответе на initialize, и сервер, забывший его отдать, от сервера с пустым
 * текстом по константе неотличим.
 *
 * Список имён берётся из того, что сервер объявил, а не переписан рядом:
 * инструмент, не названный в карте, модель не выберет, поэтому новый
 * инструмент обязан краснеть здесь сам.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../src/mcp-server.js';

let server: Server;
let client: Client;
let tools: Tool[];

beforeEach(async () => {
  ({ server, tools } = createMcpServer('test'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'instructions-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

describe('server instructions', () => {
  it('доезжают до клиента при подключении', () => {
    expect(client.getInstructions()).toBeTruthy();
  });

  it('называют профиль обязательным', () => {
    expect(client.getInstructions()).toContain('there is no default');
  });

  it('называют каждый объявленный инструмент', () => {
    const text = client.getInstructions() ?? '';
    const unnamed = tools.map((tool) => tool.name).filter((name) => !text.includes(name));
    expect(unnamed).toEqual([]);
  });

  it('называют ssh_exec последним средством, а не первым', () => {
    const text = client.getInstructions() ?? '';
    expect(text).toContain('Reach for the specific tool before ssh_exec');
    expect(text).toContain('ssh_exec is for what has no tool of its own');
  });
});
