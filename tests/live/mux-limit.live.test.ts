/**
 * Исчерпание сессий управляющего соединения живьём.
 *
 * Сервер держит не больше MaxSessions сессий на одно соединение (в лаборатории
 * это 10). Когда предел выбран, клиент открывает отдельное соединение сам и
 * возвращает нулевой код — своего отката транспорту не нужно. Замерено на трёх
 * клиентах: 9.2, 9.7 и 10.2.
 *
 * Проверяется здесь именно это, плюс чистота ответа: жалобу о сессии клиент
 * печатает в stderr, и без уборки она приезжает вызывающему как вывод команды.
 *
 * Сессии занимаются голыми ssh с теми же опциями — они садятся на тот же
 * управляющий сокет. Занимать их раннером нельзя: он бы их и освобождал.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LAB_KEY,
  LAB_REQUIRED,
  LAB_SERVERS,
  labConfig,
  labUnavailableReason,
  type LabServer,
} from './lab.js';

const LIVE_TIMEOUT_MS = 90_000;

/** Свой каталог управления: соседние наборы держат сокеты в общем */
const CONTROL_DIR = '/tmp/mcp-lab-mux';

/** Держателей больше, чем MaxSessions лаборатории — последним достанется отказ */
const HOLDERS = 12;

const unavailable = await labUnavailableReason();

process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');
const { detectRuntime, toCapabilities } = await import('../../src/runner/runtime-check.js');
const { buildSshArgs } = await import('../../src/runner/ssh-args.js');

const holders: ChildProcess[] = [];
const localDir = mkdtempSync(join(tmpdir(), 'mcp-lab-mux-'));

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
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

beforeAll(async () => {
  await run('rm', ['-rf', CONTROL_DIR]);
});

afterAll(async () => {
  for (const holder of holders) holder.kill('SIGKILL');
  await closeAllRunners();
  if (!unavailable) {
    for (const server of LAB_SERVERS) {
      // Шаблон записан так, чтобы не совпасть с собственной командной строкой:
      // иначе pkill убивает свою же сессию и до уборки дело не доходит
      await sshRoot(server.port, 'rm -f /tmp/mcp-mux-uploaded; pkill -f "sleep 4[5]"');
    }
  }
  rmSync(localDir, { recursive: true, force: true });
  await run('rm', ['-rf', CONTROL_DIR]);
});

if (unavailable && LAB_REQUIRED) {
  describe('исчерпание сессий живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`исчерпание сессий — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Исчерпание сессий: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const runner = () => getOpenSshRunner(labConfig(server));
      const refusals: string[] = [];

      beforeAll(async () => {
        // Первая команда поднимает управляющее соединение — держателям нужно,
        // чтобы сокет уже существовал, иначе они пойдут своими путями
        await (await runner()).exec('true', { remoteTimeout: false });

        const runtime = await detectRuntime();
        const holderArgs = buildSshArgs(labConfig(server), toCapabilities(runtime), 'sleep 45');
        for (let i = 0; i < HOLDERS; i++) {
          const holder = spawn('ssh', holderArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
          holder.stderr?.on('data', (chunk) => {
            if (String(chunk).includes('Session open refused by peer')) refusals.push(String(chunk));
          });
          holders.push(holder);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });

      it('команда проходит, и ответ не несёт жалоб на мультиплексирование', async () => {
        const result = await (await runner()).exec('echo ok', { remoteTimeout: false });

        // Негативный контроль: без отказов сессии проверка ничего не значила бы —
        // предел просто не был бы выбран
        expect(refusals.length).toBeGreaterThan(0);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('ok');
        expect(result.stderr).toBe('');
      });

      it('передача проходит на исчерпанных сессиях', async () => {
        const localFile = join(localDir, 'payload');
        writeFileSync(localFile, 'payload\n');

        await (await runner()).upload(localFile, '/tmp/mcp-mux-uploaded');

        const delivered = await sshRoot(server.port, 'cat /tmp/mcp-mux-uploaded');
        expect(delivered.trim()).toBe('payload');
      });
    });
  }
}
