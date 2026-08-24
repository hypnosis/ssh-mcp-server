/**
 * Живая проверка: журнал контейнера читается там, где контейнер работает.
 *
 * Юниты подают заготовленный ответ `docker inspect` и настоящего пути не
 * видят. Здесь и движок настоящий, и файл настоящий: путь известен только
 * докеру, лежит под root и содержит записи драйвера, а не текст. Проверяется
 * вся цепочка целиком — спросили, нашли, прочитали, развернули.
 *
 * Отдельно проверяется случай без файла: контейнер с драйвером `none` пишет
 * в никуда, и ответ обязан назвать драйвер, а не приехать пустым — пустой
 * журнал читается как «ошибок нет».
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_DOCKER, LAB_KEY, LAB_REQUIRED, dockerUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

const unavailable = await dockerUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'container-logs-'));

const profilesPath = join(workDir, 'profiles.json');
await writeFile(
  profilesPath,
  JSON.stringify({
    profiles: {
      [LAB_DOCKER.name]: {
        host: '127.0.0.1',
        port: LAB_DOCKER.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no',
        ignoreUserConfig: true,
      },
    },
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { LogTools } = await import('../../src/tools/log-tools.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

/** Строки, которые печатает подопытный контейнер: одна в stdout, одна в stderr */
const QUIET_LINE = 'listening on 8080';
const LOUD_LINE = 'upstream timed out: 502 Bad Gateway';

if (unavailable && LAB_REQUIRED) {
  describe('живой журнал контейнера', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой журнал контейнера — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  afterAll(async () => {
    await closeAllRunners();
  });

  describe('Журнал контейнера: dind', { timeout: LIVE_TIMEOUT_MS }, () => {
    const tools = new LogTools();
    const executor = new SSHExecutor();

    const config = {
      host: '127.0.0.1',
      port: LAB_DOCKER.port,
      username: 'root',
      privateKeyPath: LAB_KEY,
      strictHostKeyChecking: 'no' as const,
      ignoreUserConfig: true,
    };

    const onMachine = (command: string) => executor.execute(config, command, {});

    const answer = async (name: string, args: Record<string, unknown>): Promise<any> =>
      tools.handleCall({
        params: { name, arguments: { profile: LAB_DOCKER.name, ...args } },
      } as never);

    const textOf = async (name: string, args: Record<string, unknown>): Promise<string> =>
      ((await answer(name, args)).content[0].text as string);

    /** Путь, который знает только докер — тем и ценен для сверки */
    let logPath = '';

    beforeAll(async () => {
      await onMachine('docker rm -f lab-noisy lab-silent >/dev/null 2>&1 || true');
      await onMachine(
        `docker run -d --name lab-noisy alpine:3.20 sh -c ` +
          `"echo '${QUIET_LINE}'; echo '${LOUD_LINE}' >&2; sleep 3600"`
      );
      // Драйвер, который файла не оставляет вовсе: второй исход, отличный и от
      // «прочитали», и от «пусто»
      await onMachine(
        'docker run -d --name lab-silent --log-driver none alpine:3.20 sh -c "echo hush; sleep 3600"'
      );

      const inspected = await onMachine(
        'docker inspect --format "{{.LogPath}}" -- lab-noisy'
      );
      logPath = inspected.stdout.trim();
    });

    afterAll(async () => {
      await onMachine('docker rm -f lab-noisy lab-silent >/dev/null 2>&1 || true');
    });

    it('хвост читается из файла, названного движком', async () => {
      const output = await textOf('ssh_log_tail', { container: 'lab-noisy' });

      expect(logPath).toMatch(/^\/var\/lib\/docker\/containers\/.+-json\.log$/);
      expect(output).toContain(logPath);
      expect(output).toContain(QUIET_LINE);
      expect(output).toContain(LOUD_LINE);
    });

    it('наружу выходит текст контейнера, а не запись драйвера вокруг него', async () => {
      const output = await textOf('ssh_log_tail', { container: 'lab-noisy' });

      expect(output).not.toContain('"stream"');
      expect(output).not.toContain('"time"');
      expect(output).not.toContain('\\n');
    });

    /**
     * Номер сверяется с самим файлом, а не с ожидаемой позицией: stdout и
     * stderr попадают в журнал наперегонки, и порядок двух строк от запуска к
     * запуску меняется. Жёсткая цифра тут проверяла бы гонку, а не разбор.
     */
    it('поиск находит строку и называет её настоящий номер', async () => {
      const stored = await onMachine(`cat ${logPath}`);
      const inFile = stored.stdout.split('\n').findIndex((line) => line.includes(LOUD_LINE)) + 1;

      const outcome = (await answer('ssh_log_search', { container: 'lab-noisy', query: '502' }))
        .structuredContent;

      expect(inFile).toBeGreaterThan(0);
      expect(outcome.matches).toBe(1);
      expect(outcome.lines[0].text).toBe(LOUD_LINE);
      expect(outcome.lines[0].line).toBe(inFile);
      expect(outcome.source).toBe(`docker json-file ${logPath}`);
    });

    it('драйвер без файла назван вслух, и пустого ответа не приходит', async () => {
      const output = await textOf('ssh_log_tail', { container: 'lab-silent' });

      expect(output).toContain('none');
      // Отказ называет выход: иначе агент после первого «нет» ищет обход вслепую
      expect(output).toContain('ssh_exec');
      expect(output).not.toContain('(empty log)');
    });

    it('имя, которого на машине нет, отличается от пустого журнала', async () => {
      const output = await textOf('ssh_log_tail', { container: 'lab-missing' });

      expect(output).toContain('no container named lab-missing');
    });

    it('остановленный контейнер журнал не теряет', async () => {
      await onMachine('docker stop lab-noisy >/dev/null');
      try {
        const output = await textOf('ssh_log_tail', { container: 'lab-noisy' });

        expect(output).toContain(LOUD_LINE);
        expect(output).toContain('exited');
      } finally {
        await onMachine('docker start lab-noisy >/dev/null');
      }
    });
  });
}
