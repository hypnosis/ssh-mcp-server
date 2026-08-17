/**
 * Живая проверка отмены вызова.
 *
 * Отмена бросает работу на нашей стороне: клиент `ssh` останавливается, не
 * досиживая срок команды. Проверяется это счётом процессов, а не временем
 * ответа: ответ клиенту приходит сразу в любом случае — его отклоняет его же
 * `AbortController`, и по нему не видно, дошла ли отмена до дела.
 *
 * Команду на машине отмена не снимает — закрытие канала не убивает то, что
 * уже запущено, — и это проверяется здесь же, чтобы граница была названа
 * замером, а не памятью о нём.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/** Команда идёт заметно дольше, чем ждём ответа после отмены */
const COMMAND_SECONDS = 20;
const ABORT_AFTER_MS = 700;

/** Сколько ждать, пока брошенный клиент `ssh` уйдёт из списка процессов */
const RELEASE_LIMIT_MS = 3_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'cancel-live-'));

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
const { LogTools } = await import('../../src/tools/log-tools.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живая отмена', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живая отмена — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  let client: Client;

  beforeAll(async () => {
    const { server } = createMcpServer('test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'cancel-live', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await closeAllRunners();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Долгий вызов, оборванный через ABORT_AFTER_MS */
  const cancelAfterStart = async (profile: string, name: string, args: object): Promise<void> => {
    const aborter = new AbortController();
    const call = client.callTool(
      { name, arguments: { profile, ...args } },
      undefined,
      { signal: aborter.signal }
    );

    await sleep(ABORT_AFTER_MS);
    aborter.abort();
    await expect(call).rejects.toThrow();
  };

  /**
   * Сколько наших клиентов `ssh` работает с этим контейнером. Master-соединение
   * мультиплексирования сюда не попадает: у него в строке запуска нет команды,
   * а считаются только те, что несут её.
   */
  const runningClients = (port: number, mark: string): number => {
    const listing = execFileSync('ps', ['-axo', 'args=']).toString().split('\n');
    return listing.filter((line) => line.includes(`-p ${port}`) && line.includes(mark)).length;
  };

  /** Дождаться, пока брошенные клиенты уйдут, но не дольше срока */
  const waitForRelease = async (port: number, mark: string): Promise<number> => {
    const deadline = Date.now() + RELEASE_LIMIT_MS;
    let left = runningClients(port, mark);
    while (left > 0 && Date.now() < deadline) {
      await sleep(200);
      left = runningClients(port, mark);
    }
    return left;
  };

  for (const server of LAB_SERVERS) {
    describe(`Отмена вызова: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      it('бросает клиента ssh, а не досиживает срок команды', async () => {
        const mark = `cancel-mark-exec-${server.port}`;
        await cancelAfterStart(server.name, 'ssh_exec', {
          command: `sleep ${COMMAND_SECONDS}; : ${mark}`,
          timeout: 60_000,
        });

        const left = await waitForRelease(server.port, mark);
        expect(left, 'клиент ssh остался ждать команду до конца').toBe(0);
      });

      /**
       * Канал без пишущей стороны — надёжный способ получить чтение, которое
       * само не кончится: обычный файл на контейнере читается мгновенно и
       * успевает ответить раньше отмены.
       */
      it('обрывает и чтение журнала — отмену берёт не только ssh_exec', async () => {
        const fifo = `/tmp/cancel-fifo-${server.port}`;
        await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `rm -f ${fifo}; mkfifo ${fifo}` },
        });

        try {
          await cancelAfterStart(server.name, 'ssh_log_tail', { path: fifo });
          const left = await waitForRelease(server.port, fifo);
          expect(left, 'чтение осталось висеть на канале').toBe(0);
        } finally {
          await client.callTool({
            name: 'ssh_exec',
            arguments: { profile: server.name, command: `rm -f ${fifo}` },
          });
        }
      });

      /**
       * Названная граница: запущенное на машине отмена не снимает. Замер прямой —
       * команда оставляет метку позже, чем приходит отмена, и метка появляется.
       * Покраснеет этот тест — значит поведение изменилось и документы врут.
       */
      it('команду на машине не снимает — это делает только её собственный срок', async () => {
        const marker = `/tmp/cancel-mark-${server.port}`;
        await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `rm -f ${marker}` },
        });

        await cancelAfterStart(server.name, 'ssh_exec', {
          command: `sleep 4; touch ${marker}`,
          timeout: 60_000,
        });
        await sleep(6_000);

        const check = (await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `test -e ${marker} && echo YES || echo NO` },
        })) as CallToolResult;
        expect((check.content as any[])[0].text).toContain('YES');

        await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `rm -f ${marker}` },
        });
      });

      /**
       * Чтение списком собирает исход по каждому пути отдельно, и сорванный
       * файл там — строка «не прочитан». Отмена в этот разряд попасть не
       * должна: иначе оборванный вызов вернулся бы списком с пробелами, где
       * пробел не отличить от настоящего отказа в доступе.
       */
      it('отмена чтения списка приходит отказом, а не списком с пробелами', async () => {
        const fifo = `/tmp/cancel-fifo-list-${server.port}`;
        await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `rm -f ${fifo}; mkfifo ${fifo}` },
        });

        // Спрашивается сам инструмент, а не клиент: отменивший вызов клиент
        // ответа уже не слушает, и по нему не видно, что именно ушло в ответ
        const logTools = new LogTools();
        const aborter = new AbortController();
        const call = logTools.handleCall(
          {
            params: {
              name: 'ssh_log_tail',
              arguments: { profile: server.name, path: ['/etc/hostname', fifo] },
            },
          } as never,
          aborter.signal
        );

        await sleep(ABORT_AFTER_MS);
        aborter.abort();
        const result = await call;

        expect(result.isError, 'отменённое чтение вернулось как удавшееся').toBe(true);

        await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: `rm -f ${fifo}` },
        });
      });

      it('следующий вызов после отмены работает', async () => {
        const result = (await client.callTool({
          name: 'ssh_exec',
          arguments: { profile: server.name, command: 'echo alive' },
        })) as CallToolResult;

        expect((result.content as any[])[0].text).toContain('alive');
        expect(result.isError).toBeFalsy();
      });
    });
  }
}
