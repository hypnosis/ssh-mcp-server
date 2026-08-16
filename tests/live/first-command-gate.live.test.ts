/**
 * Шлюз первой команды живьём: сколько входов видит сервер.
 *
 * Считаем не наши вызовы, а строки sshd в логе контейнера — залп из пяти
 * команд и пять команд по очереди дают одинаковый счёт вызовов, но разное
 * число входов, а важно именно оно: каждый вход это отдельная аутентификация,
 * и на сервере со счётчиком неудачных попыток залп выглядит как перебор.
 *
 * Замер до правки: холодный старт на свежем транспорте давал один вход, но
 * второй холодный старт на том же транспорте — пять. Шлюз закрывался однажды
 * за жизнь объекта, а профиль остывает каждый раз, когда соединение закрыли
 * или оно истекло по сроку простоя.
 *
 * Пользователь заводится тестом и удаляется после: под `root` и `deploy` ходят
 * соседние живые наборы, и их входы попали бы в тот же счёт.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
import {
  LAB_KEY,
  LAB_REQUIRED,
  LAB_SERVERS,
  labConfig,
  labUnavailableReason,
  type LabServer,
} from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Свой каталог управления: соседние наборы держат сокеты в общем */
const CONTROL_DIR = '/tmp/mcp-lab-gate';

/** Пользователь только этого файла — по нему и считаются входы в логе */
const GATE_USER = 'gateuser';

/** Сколько команд уходит залпом */
const BURST = 5;

const unavailable = await labUnavailableReason();

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (_error, stdout, stderr) =>
      resolve(`${stdout}${stderr}`)
    );
  });
}

/** Команда на сервере мимо проверяемого кода */
function sshRoot(port: number, command: string): Promise<string> {
  return run('ssh', [
    '-o', 'ControlPath=none',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-i', LAB_KEY,
    '-p', String(port),
    'root@127.0.0.1',
    command,
  ]);
}

/** Сколько раз sshd пустил нашего пользователя за всё время жизни контейнера */
async function loginCount(server: LabServer): Promise<number> {
  const log = await run('docker', ['logs', server.container]);
  return log.split('\n').filter((line) => line.includes(`Accepted publickey for ${GATE_USER}`)).length;
}

if (!unavailable) {
  for (const server of LAB_SERVERS) {
    await sshRoot(
      server.port,
      `id ${GATE_USER} >/dev/null 2>&1 || adduser -D ${GATE_USER} 2>/dev/null || useradd -m -s /bin/sh ${GATE_USER}; ` +
        // Пользователь без пароля получает «!» в shadow — это запертая учётка, и
        // Alpine не пускает такую даже по ключу; «*» запрещает только пароль
        `sed -i "s/^${GATE_USER}:!:/${GATE_USER}:*:/" /etc/shadow; ` +
        `mkdir -p /home/${GATE_USER}/.ssh; cp /root/.ssh/authorized_keys /home/${GATE_USER}/.ssh/authorized_keys; ` +
        `chown -R ${GATE_USER} /home/${GATE_USER}/.ssh; chmod 700 /home/${GATE_USER}/.ssh; ` +
        `chmod 600 /home/${GATE_USER}/.ssh/authorized_keys`
    );
  }
}

process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');

afterAll(async () => {
  await closeAllRunners();
  if (!unavailable) {
    for (const server of LAB_SERVERS) {
      await sshRoot(server.port, `deluser ${GATE_USER} 2>/dev/null || userdel -r ${GATE_USER} 2>/dev/null; rm -rf /home/${GATE_USER}`);
    }
  }
  await run('rm', ['-rf', CONTROL_DIR]);
});

if (unavailable && LAB_REQUIRED) {
  describe('шлюз первой команды живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`шлюз первой команды — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Шлюз первой команды: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const runner = () => getOpenSshRunner(labConfig(server, GATE_USER));

      /** Залп команд, вернуть число новых входов в логе сервера */
      const loginsDuringBurst = async (): Promise<number> => {
        const before = await loginCount(server);
        const results = await Promise.all(
          Array.from({ length: BURST }, async () =>
            (await runner()).exec('true', { remoteTimeout: false })
          )
        );

        // Без этого счёт нуля означал бы и «вошли один раз», и «команды не дошли»
        expect(results.every((result) => result.exitCode === 0)).toBe(true);
        return (await loginCount(server)) - before;
      };

      it('холодный залп входит один раз', async () => {
        await (await runner()).closeMaster();

        expect(await loginsDuringBurst()).toBe(1);
      });

      it('второй холодный залп на том же транспорте тоже входит один раз', async () => {
        await (await runner()).closeMaster();

        expect(await loginsDuringBurst()).toBe(1);
      });

      it('пока соединение живо, залп не входит вовсе', async () => {
        expect(await loginsDuringBurst()).toBe(0);
      });
    });
  }
}
