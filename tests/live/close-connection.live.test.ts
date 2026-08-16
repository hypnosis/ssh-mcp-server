/**
 * Живая проверка действия «закрыть сейчас»
 *
 * Ответ инструмента ничего не доказывает сам по себе: он мог напечатать
 * «закрыто», не тронув соединение. Поэтому состояние спрашивается у машины —
 * лежит ли сокет в каталоге управления и принимает ли он подключение.
 *
 * Каталог здесь свой, не общий лабораторный: соседние живые файлы идут
 * параллельно и держат в общем каталоге собственные сокеты, а их присутствие
 * сделало бы счёт бессмысленным.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;
const CONTROL_DIR = '/tmp/mcp-close-ctl';

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'close-connection-'));

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    default: LAB_SERVERS[0].name,
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
process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;

const { MonitoringTool } = await import('../../src/tools/monitoring-tool.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

/** Принимает ли сокет подключение — независимо от наших модулей */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (answers: boolean): void => {
      socket.destroy();
      resolve(answers);
    };

    socket.setTimeout(1000, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/** Сколько живых управляющих сокетов лежит в каталоге прямо сейчас */
async function liveSocketCount(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(CONTROL_DIR);
  } catch {
    return 0;
  }

  let count = 0;
  for (const name of names) {
    if (name.startsWith('s-') && (await socketAnswers(join(CONTROL_DIR, name)))) count += 1;
  }
  return count;
}

if (unavailable && LAB_REQUIRED) {
  describe('закрытие соединения живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`закрытие соединения — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущена', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Закрыть сейчас: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new MonitoringTool();

      const call = async (action: string): Promise<string> => {
        const answer = await tool.handleCall({
          params: { name: 'ssh_monitor', arguments: { action, profile: server.name } },
        } as never);
        return answer.content.map((c: { text: string }) => c.text).join('\n');
      };

      beforeAll(async () => {
        await call('close');
      });

      afterAll(async () => {
        await call('close');
      });

      it('соединение, поднятое проверкой связи, закрывается по требованию', async () => {
        await call('test');
        expect(await liveSocketCount()).toBe(1);

        const answer = await call('close');

        expect(answer).toContain('Closed');
        expect(await liveSocketCount()).toBe(0);
      });

      it('после закрытия сервер по-прежнему доступен — соединение поднимается заново', async () => {
        await call('test');
        await call('close');

        const answer = await call('test');

        expect(answer).toContain('✅');
        expect(await liveSocketCount()).toBe(1);
      });

      it('закрывать нечего — это успех с пометкой, а не отказ', async () => {
        await call('test');
        await call('close');

        const answer = await call('close');

        expect(answer).toContain('idled out');
        expect(answer).not.toContain('❌');
      });

      it('состояние транспорта после закрытия честное', async () => {
        await call('test');
        await call('close');

        const answer = await call('stats');

        expect(answer).toContain('not running');
      });
    });
  }

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
    await rm(CONTROL_DIR, { recursive: true, force: true });
  });
}
