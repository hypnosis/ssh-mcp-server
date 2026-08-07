/**
 * Перечитывание профилей живьём: что остаётся от прежних.
 *
 * Паспорт сервера снимается один раз на назначение и живёт до конца процесса.
 * Пока профили не перечитывали — это верно; после перечитывания сервер уже мог
 * стать другим, и отвечать по старому паспорту нельзя: команда оборачивается в
 * `timeout`, которого там больше нет, и падает с «command not found».
 *
 * Сервер меняется по-настоящему — утилита убирается мимо проверяемого кода и
 * возвращается после. Живые файлы идут по одному (`fileParallelism: false`),
 * поэтому соседям эта подмена не мешает.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason, type LabServer } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Свой каталог управления: соседние наборы держат сокеты в общем */
const CONTROL_DIR = '/tmp/mcp-lab-reload';

/** Куда прячется утилита на время проверки */
const HIDDEN_TIMEOUT = '/usr/bin/timeout.reload-test';

const unavailable = await labUnavailableReason();

const localDir = mkdtempSync(join(tmpdir(), 'mcp-lab-reload-'));
const profilesFile = join(localDir, 'profiles.json');
const previousProfilesFile = process.env.SSH_PROFILES_FILE;

process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;
process.env.SSH_PROFILES_FILE = profilesFile;
// Наблюдатель за файлом держал бы процесс и перечитывал профили сам,
// а проверяется здесь именно наш вызов
process.env.SSH_MCP_PROFILES_WATCH = 'false';

function writeProfile(server: LabServer): void {
  writeFileSync(profilesFile, JSON.stringify({
    default: 'lab',
    profiles: {
      lab: {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no',
        ignoreUserConfig: true,
      },
    },
  }));
}

if (!unavailable) writeProfile(LAB_SERVERS[0]);

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');
const { reloadProfiles, resolveSSHConfig } = await import('../../src/utils/profile-resolver.js');

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
  await closeAllRunners();
  if (!unavailable) {
    for (const server of LAB_SERVERS) {
      // Подстраховка: если тест упал между подменой и возвратом, утилита
      // осталась бы спрятанной и сломала бы всё, что идёт следом
      await sshRoot(server.port, `[ -e ${HIDDEN_TIMEOUT} ] && mv ${HIDDEN_TIMEOUT} /usr/bin/timeout; true`);
    }
  }
  rmSync(localDir, { recursive: true, force: true });
  await run('rm', ['-rf', CONTROL_DIR]);
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;
});

if (unavailable && LAB_REQUIRED) {
  describe('перечитывание профилей живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`перечитывание профилей — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Перечитывание профилей: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      it('паспорт сервера снимается заново, а не берётся от прежних профилей', async () => {
        writeProfile(server);
        reloadProfiles();

        const before = await (await getOpenSshRunner(resolveSSHConfig({ profile: 'lab' }))).exec('echo first');
        expect(before.exitCode).toBe(0);
        expect(before.stdout.trim()).toBe('first');

        await sshRoot(server.port, `mv /usr/bin/timeout ${HIDDEN_TIMEOUT}`);
        try {
          // Негативный контроль: пока профили не перечитывали, паспорт по-прежнему
          // обещает `timeout`, и команда об это спотыкается. Без этой проверки
          // следующая ничего не значила бы — сцена могла и не собраться
          const stale = await (await getOpenSshRunner(resolveSSHConfig({ profile: 'lab' }))).exec('echo stale');
          expect(stale.exitCode).toBe(127);
          expect(stale.stderr).toMatch(/timeout: (command )?not found/);

          reloadProfiles();

          const after = await (await getOpenSshRunner(resolveSSHConfig({ profile: 'lab' }))).exec('echo after');
          expect(after.exitCode).toBe(0);
          expect(after.stdout.trim()).toBe('after');
        } finally {
          await sshRoot(server.port, `mv ${HIDDEN_TIMEOUT} /usr/bin/timeout`);
        }
      });

      it('утилита вернулась на место', async () => {
        const found = await sshRoot(server.port, 'command -v timeout || echo нет');

        expect(found.trim()).toBe('/usr/bin/timeout');
      });
    });
  }
}
