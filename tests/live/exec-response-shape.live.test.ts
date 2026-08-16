/**
 * Форма ответа `ssh_exec` на живом сервере.
 *
 * Юниты собирают ответ вокруг придуманного результата исполнителя, поэтому
 * форму они проверяют только до этой границы: перевод строки, пришедший от
 * самой команды, и вывод, разложенный по каналам, там задаёт тест. Здесь та же
 * форма снимается с настоящего сервера — на обоих наборах утилит, потому что
 * текст и код ошибки у них расходятся, а разбор ответа расходиться не должен.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason, type LabServer } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Свой каталог управления: соседние наборы держат сокеты в общем */
const CONTROL_DIR = '/tmp/mcp-lab-shape';

const unavailable = await labUnavailableReason();

const localDir = mkdtempSync(join(tmpdir(), 'mcp-lab-shape-'));
const profilesFile = join(localDir, 'profiles.json');
const previousProfilesFile = process.env.SSH_PROFILES_FILE;

process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;
process.env.SSH_PROFILES_FILE = profilesFile;
process.env.SSH_MCP_PROFILES_WATCH = 'false';

writeFileSync(
  profilesFile,
  JSON.stringify({
    default: LAB_SERVERS[0].container,
    profiles: Object.fromEntries(
      LAB_SERVERS.map((server: LabServer) => [
        server.container,
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

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

const tool = new ExecTool();

/** Текст ответа инструмента на один вызов */
async function answer(profile: string, args: Record<string, unknown>): Promise<string> {
  const response = await tool.handleCall({
    params: { name: 'ssh_exec', arguments: { profile, ...args } },
  } as never);
  return response.content[0].text;
}

afterAll(async () => {
  await closeAllRunners();
  rmSync(localDir, { recursive: true, force: true });
  await new Promise((resolve) => execFile('rm', ['-rf', CONTROL_DIR], () => resolve(undefined)));
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;
});

if (unavailable && LAB_REQUIRED) {
  describe('форма ответа ssh_exec живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`форма ответа ssh_exec — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Форма ответа ssh_exec: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const profile = server.container;

      it('одиночная команда отдаёт свой вывод и ничего сверх него', async () => {
        expect(await answer(profile, { command: 'echo hello' })).toBe('hello\n');
      });

      it('успех без вывода объясняется словами', async () => {
        expect(await answer(profile, { command: 'true' })).toBe(
          '(command executed successfully, no output)'
        );
      });

      it('чужой канал и ненулевой код подписаны', async () => {
        const text = await answer(profile, { command: 'ls /nope' });

        expect(text).toContain('STDERR:');
        expect(text).toContain('/nope');
        // Код у наборов разный (1 у BusyBox, 2 у coreutils) — важно, что он назван
        expect(text).toMatch(/Exit code: [12]$/);
      });

      it('пачка отвечает нумерованным разбором с кодом у каждой команды', async () => {
        const line = '─'.repeat(60);

        const text = await answer(profile, { command: ['echo one', 'echo two'] });

        expect(text).toBe(
          'Executed 2 commands:\n\n' +
            `[1/2] echo one\n${line}\none\n\nExit code: 0\n\n` +
            `[2/2] echo two\n${line}\ntwo\n\nExit code: 0\n\n`
        );
      });

      it('sudo доезжает до сервера, а не остаётся в аргументах', async () => {
        const asRoot = await answer(profile, { command: 'id -un', sudo: true });

        expect(asRoot.trim()).toBe('root');
      });

      it('рабочий каталог доезжает до сервера', async () => {
        expect(await answer(profile, { command: 'pwd', cwd: '/etc' })).toBe('/etc\n');
      });

      it('опасная команда получает предупреждение и всё равно выполняется', async () => {
        const text = await answer(profile, { command: 'psql -c "DROP TABLE users;"; echo done' });

        expect(text).toContain('⚠️  DANGEROUS COMMAND: DROP TABLE detected');
        expect(text).toContain('done');
      });

      it('тот же запрос в тексте базы не касается — и предупреждения нет', async () => {
        const text = await answer(profile, { command: 'echo "DROP TABLE users;"' });

        expect(text).not.toContain('DANGEROUS COMMAND');
        expect(text).toContain('DROP TABLE users;\n');
      });

      it('чтение файла с reboot в имени тревоги не поднимает', async () => {
        const text = await answer(profile, {
          command: '(test -f /var/run/reboot-required && echo YES) || echo NO',
        });

        expect(text).not.toContain('DANGEROUS COMMAND');
        expect(text.trim()).toBe('NO');
      });
    });
  }
}
