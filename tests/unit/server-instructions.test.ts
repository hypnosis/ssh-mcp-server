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

/**
 * Карта отвечает и на вопросы, которые агент иначе задаёт человеку: где вход,
 * откуда взять имена машин и как читать ответ.
 *
 * Повод — живой случай: агент пошёл просить пароль у владельца, потому что в
 * карте не было сказано ни что вход уже лежит в профиле, ни что список имён
 * можно спросить у сервера.
 */
describe('карта о самой настройке', () => {
  it('запрещает выпрашивать секрет — вход уже в профиле', () => {
    const text = client.getInstructions() ?? '';

    expect(text).toContain('Never ask anyone for a secret');
    expect(text).toContain('key, passphrase or password');
  });

  it('называет, у кого спросить имена профилей', () => {
    expect(client.getInstructions()).toContain('ssh_monitor action:list');
  });

  /**
   * Два роутера на одном адресе различаются только именем профиля. Перенос
   * строки внутри фразы — форматирование, поэтому сторожится смысл, а не вёрстка.
   */
  it('предупреждает, что адрес не различает машины', () => {
    expect(client.getInstructions()?.replace(/\s+/g, ' ')).toContain(
      'point at the same address and differ only by name'
    );
  });

  it.each([['ssh://profiles/current'], ['ssh://profiles/example']])(
    'называет ресурс %s, иначе агент его не откроет',
    (uri) => {
      expect(client.getInstructions()).toContain(uri);
    }
  );

  it('велит читать поля ответа, а не разбирать текст', () => {
    const text = client.getInstructions() ?? '';

    expect(text).toContain('structuredContent');
    expect(text).toContain('legend');
  });
});
