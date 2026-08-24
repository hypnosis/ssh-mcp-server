/**
 * Живая проверка показа цели вместо слепого удара
 *
 * Юниты проверяют разбор и текст; здесь проверяется последствие. Отказ,
 * напечатанный в ответе, ничего не доказывает: инструмент мог показать
 * список и всё равно отправить команду. Поэтому цель после отказа
 * спрашивается мимо инструмента — жива ли она на самом деле.
 *
 * Жертва поднимается своя и с уникальным именем: удар по чужому процессу
 * лаборатории убил бы сам канал проверки.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LAB_CONTROL_DIR,
  LAB_DOCKER,
  LAB_KEY,
  LAB_REQUIRED,
  LAB_SERVERS,
  labUnavailableReason,
} from './lab.js';

const LIVE_TIMEOUT_MS = 90_000;

/** Метка жертвы: по ней её находит проба, и по ней же она узнаётся в ответе */
const VICTIM_MARK = 'blind-strike-victim-7731';

/**
 * Тот же образец, прикрытый классом из одного знака.
 *
 * Проверочные вызовы ищут жертву им, а не чистой меткой: иначе они сами
 * несут метку в командной строке и попадают под собственный удар — ровно то,
 * что сторож и ловит.
 */
const VICTIM_SHIELDED = `[${VICTIM_MARK[0]}]${VICTIM_MARK.slice(1)}`;

/** Длительность жертвы: короче прогона она быть не должна, дольше — незачем */
const VICTIM_SLEEP = 240;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'blind-strike-'));

const servers = [...LAB_SERVERS, LAB_DOCKER];

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: Object.fromEntries(
      servers.map((server) => [
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

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { KILL_MARKER } = await import('../../src/utils/strike-refusal.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('показ цели живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`показ цели — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущена', () => undefined);
  });
} else {
  const tool = new ExecTool();
  const executor = new SSHExecutor();

  const configOf = (port: number) => ({
    host: '127.0.0.1',
    port,
    username: 'root',
    privateKeyPath: LAB_KEY,
    strictHostKeyChecking: 'no' as const,
    ignoreUserConfig: true,
  });

  /** Спросить машину мимо инструмента: проверяем последствие, а не слова */
  const onServer = async (port: number, command: string): Promise<string> => {
    const result = await executor.execute(configOf(port), command, {});
    return result.stdout.trim();
  };

  const call = async (profile: string, command: string): Promise<string> => {
    const answer = await tool.handleCall({
      params: { name: 'ssh_exec', arguments: { profile, command } },
    } as never);
    return answer.content.map((c: { text: string }) => c.text).join('\n');
  };

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });

  for (const server of LAB_SERVERS) {
    describe(`Слепой удар по процессу: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      // Метку несёт имя запускаемого файла: на BusyBox подменить нулевой
      // аргумент нечем, а имя скрипта видно в командной строке как есть
      const victimPath = `/tmp/${VICTIM_MARK}`;

      beforeAll(async () => {
        await onServer(
          server.port,
          // Номер пишет сам скрипт: `$!` дал бы setsid, а группу возглавляет
          // скрипт, и снимать её надо по нему
          `printf '#!/bin/sh\necho $$ > ${victimPath}.pid\nsleep ${VICTIM_SLEEP}\n' > ${victimPath} && ` +
            `chmod +x ${victimPath} && (setsid ${victimPath} >/dev/null 2>&1 &); sleep 1; true`
        );
      });

      // Убирать образцом нельзя: `pkill -f <метка>` снимет собственную оболочку
      // раньше жертвы — та же ловушка, ради которой писан весь сторож. Группа у
      // жертвы своя, её выдаёт setsid, и снимается она целиком
      // Убирать поиском по строке нельзя ни в каком виде: команда уборки сама
      // несёт метку и снимает себя раньше жертвы. Снимается группа по номеру,
      // а осиротевший потомок — по длительности, слова в фильтр не входят
      afterAll(async () => {
        await onServer(
          server.port,
          `kill -TERM -$(cat ${victimPath}.pid 2>/dev/null) 2>/dev/null; ` +
            `for p in $(pgrep -x sleep); do ` +
            `a=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); ` +
            `case "$a" in *${VICTIM_SLEEP}*) kill -9 "$p" 2>/dev/null;; esac; done; ` +
            `rm -f ${victimPath} ${victimPath}.pid; true`
        );
      });

      it('удар по образцу не выполняется, а цель показывается', async () => {
        const before = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);
        expect(before).not.toBe('');

        const text = await call(server.name, `pkill -f ${VICTIM_MARK}`);

        expect(text).toContain('⛔ BLOCKED');
        expect(text).toContain(before);

        const after = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);
        expect(after).toBe(before);
      });

      it('повтор той же строки проходит не больше первого раза', async () => {
        await call(server.name, `pkill -f ${VICTIM_MARK}`);
        const alive = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);

        expect(alive).not.toBe('');
      });

      // Замер на обоих контейнерах: `pkill -f <образец>` снимает собственную
      // оболочку — образец написан в её же командной строке, и ответ обрывается
      // на полуслове. Маркер тут не выход, выход — номера
      it('подтверждение своим же номером образец не открывает', async () => {
        const before = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);
        const text = await call(server.name, `pkill -f ${VICTIM_MARK} ${KILL_MARKER} ${before}`);

        expect(text).toContain('⛔ BLOCKED');
        expect(text).toContain('matches the command that carries it');
        expect(await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`)).toBe(before);
      });

      it('отказ показывает обе дороги: номер и прикрытый образец', async () => {
        const pid = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);
        const text = await call(server.name, `pkill -f ${VICTIM_MARK}`);

        expect(text).toContain(`kill ${pid}`);
        expect(text).toContain(VICTIM_SHIELDED);
      });

      // Прикрытый образец не совпадает с командой, которая его несёт: оболочка
      // договаривает ответ до конца, а цель снимается
      it('прикрытый образец с подтверждением снимает цель и не рвёт ответ', async () => {
        // Даём осесть оболочкам подготовки: путь жертвы несёт метку в чистом
        // виде, и пока они живы, удар достаёт и их — сторож это показывает
        await onServer(server.port, 'sleep 2; true');
        const listed = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | tr '\n' ' '`);
        const pids = listed.trim().split(/\s+/).filter((pid) => pid !== '');
        expect(pids.length).toBeGreaterThan(0);

        const text = await call(
          server.name,
          `pkill -f '${VICTIM_SHIELDED}'; echo finished ${KILL_MARKER} ${pids.join(', ')}`
        );

        expect(text).toContain('finished');
        await onServer(server.port, 'sleep 1; true');
        const alive = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | tr '\n' ' '`);
        expect(alive.split(/\s+/)).not.toContain(pids[0]);
      });

      it('удар по номеру проходит без вопросов и цель снимает', async () => {
        // Жертву поднимаем заново: предыдущая проверка её сняла
        await onServer(
          server.port,
          `(setsid ${victimPath} >/dev/null 2>&1 & echo $! > ${victimPath}.pid); sleep 1; true`
        );
        const pid = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | head -1`);
        await call(server.name, `kill ${pid}`);
        await onServer(server.port, 'sleep 1; true');

        // Метку несут и запускавшие оболочки, поэтому проверяется исчезновение
        // именно того номера, который был назван
        const alive = await onServer(server.port, `pgrep -f '${VICTIM_SHIELDED}' | tr '\n' ' '`);
        expect(alive.split(/\s+/)).not.toContain(pid);
      });

      it('где движка нет, ответ говорит об этом, а не о пустоте', async () => {
        const text = await call(server.name, 'docker kill $(docker ps -q)');

        expect(text).toContain('⛔ BLOCKED');
        expect(text).toContain('docker is not on the machine');
      });
    });
  }

  describe(`Слепой удар по контейнеру: ${LAB_DOCKER.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
    const port = LAB_DOCKER.port;
    const name = `blind-strike-${port}`;

    beforeAll(async () => {
      await onServer(port, `docker rm -f ${name} >/dev/null 2>&1; true`);
      await onServer(port, `docker run -d --name ${name} nginx:alpine >/dev/null 2>&1; sleep 2; true`);
    });

    afterAll(async () => {
      await onServer(port, `docker rm -f ${name} >/dev/null 2>&1; true`);
    });

    const running = async (): Promise<string> =>
      onServer(port, `docker ps --filter name=${name} --format '{{.Names}}'`);

    it('удар по маске не выполняется, а контейнер назван', async () => {
      expect(await running()).toBe(name);

      const text = await call(LAB_DOCKER.name, 'docker kill $(docker ps -q --filter ancestor=nginx:alpine)');

      expect(text).toContain('⛔ BLOCKED');
      expect(text).toContain(name);
      expect(text).toContain('nginx:alpine');
      expect(await running()).toBe(name);
    });

    it('подтверждение именем удар пропускает', async () => {
      await call(
        LAB_DOCKER.name,
        `docker kill $(docker ps -q --filter ancestor=nginx:alpine) ${KILL_MARKER} ${name}`
      );

      expect(await running()).toBe('');
    });

    it('маска, которая ни во что не попала, удар не пропускает', async () => {
      const text = await call(LAB_DOCKER.name, 'docker kill $(docker ps -q --filter ancestor=absent:none)');

      expect(text).toContain('⛔ BLOCKED');
      expect(text).toContain('reaches nothing');
    });

    it('названный контейнер останавливается без вопросов', async () => {
      await onServer(port, `docker start ${name} >/dev/null 2>&1; sleep 1; true`);
      expect(await running()).toBe(name);

      await call(LAB_DOCKER.name, `docker kill ${name}`);

      expect(await running()).toBe('');
    });
  });
}
