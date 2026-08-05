/**
 * Работа под sudo живьём: запись и передача в каталог, недоступный пользователю.
 *
 * Живого теста на этот путь не было вовсе, а сам путь непростой: файл едет в
 * /tmp от имени пользователя и только потом `sudo install` ставит его на место
 * с нужными правами и владельцем. Проверялось это полгода лишь наполовину —
 * пользователь `deploy` на Alpine не пускался вообще (запертая учётка в
 * /etc/shadow), поэтому весь sudo-путь видел только coreutils.
 *
 * Проверяется здесь состояние сервера, а не текст ответа инструмента: ответ
 * может отрапортовать успех и на невыполненной работе.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'sudo-path-'));

// Инструмент берёт конфигурацию только из файла профилей: профиль ходит под
// непривилегированным `deploy`, у которого есть NOPASSWD-sudo и нет прав на цель
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
          username: 'deploy',
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

const { FileTools } = await import('../../src/tools/file-tools.js');
const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живой sudo-путь', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой sudo-путь — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Работа под sudo: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const files = new FileTools();
      const transfer = new TransferTool();
      const executor = new SSHExecutor();

      /** Каталог принадлежит root и закрыт для записи пользователю профиля */
      const guardedDir = `/opt/sudo-live-${server.port}`;

      /** Отдельный вход под root — только чтобы готовить сцену и сверять результат */
      const rootConfig = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      const asRoot = async (command: string): Promise<string> => {
        const result = await executor.execute(rootConfig, command, { profileName: `${server.name}-root` });
        return result.stdout.trim();
      };

      const call = (tool: { handleCall: (request: never) => Promise<unknown> }, name: string, args: Record<string, unknown>) =>
        tool.handleCall({ params: { name, arguments: args } } as never);

      beforeAll(async () => {
        await asRoot(`rm -rf '${guardedDir}' && mkdir -p '${guardedDir}' && chown root:root '${guardedDir}' && chmod 755 '${guardedDir}'`);
      });

      afterAll(async () => {
        await asRoot(`rm -rf '${guardedDir}'`).catch(() => undefined);
        await closeAllRunners();
      });

      it('без sudo запись в чужой каталог не проходит', async () => {
        // Негативный контроль сцены: если каталог окажется доступным на запись,
        // все проверки ниже станут бессмысленными — они будут зелёными без sudo
        const answer = JSON.stringify(
          await call(files, 'ssh_file_write', {
            profile: server.name,
            files: [{ path: `${guardedDir}/without-sudo.txt`, content: 'не должно записаться\n' }],
          })
        );

        expect(answer).toMatch(/denied|error|fail/i);
        expect(await asRoot(`ls '${guardedDir}' | wc -l`)).toBe('0');
      });

      it('запись под sudo кладёт файл целиком и от имени root', async () => {
        const target = `${guardedDir}/app.conf`;
        const content = 'ключ=значение\nвторая строка\n';

        await call(files, 'ssh_file_write', {
          profile: server.name,
          files: [{ path: target, content, sudo: true }],
        });

        expect(await asRoot(`cat '${target}'`)).toBe(content.trim());
        expect(await asRoot(`stat -c '%U' '${target}' 2>/dev/null || stat -f '%Su' '${target}'`)).toBe('root');
      });

      it('чтение под sudo отдаёт файл, закрытый для пользователя профиля', async () => {
        const secretFile = `${guardedDir}/secret.txt`;
        await asRoot(`printf 'только для root\n' > '${secretFile}' && chmod 600 '${secretFile}'`);

        const denied = JSON.stringify(
          await call(files, 'ssh_file_read', { profile: server.name, path: secretFile })
        );
        expect(denied).not.toContain('только для root');

        const allowed = JSON.stringify(
          await call(files, 'ssh_file_read', { profile: server.name, path: secretFile, sudo: true })
        );
        expect(allowed).toContain('только для root');
      });

      it('передача под sudo ставит файл с заказанными правами и владельцем', async () => {
        const source = join(workDir, `payload-${server.port}.bin`);
        await writeFile(source, 'полезная нагрузка\n');
        const target = `${guardedDir}/payload.bin`;

        await call(transfer, 'ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: target,
          sudo: true,
          mode: '640',
          owner: 'root:root',
        });

        expect(await asRoot(`cat '${target}'`)).toBe('полезная нагрузка');
        expect(
          await asRoot(`stat -c '%a %U:%G' '${target}' 2>/dev/null || stat -f '%Lp %Su:%Sg' '${target}'`)
        ).toBe('640 root:root');
      });

      it('каталог под sudo отклоняется до первой команды и ничего не оставляет', async () => {
        // Рекурсия под sudo не поддерживается намеренно (README, docs/transfer.md):
        // `install` работает с файлом, а не с деревом. Отказ обязан быть отказом:
        // текст с обходным путём и ни одного файла на сервере — половина дерева,
        // разложенная перед ошибкой, была бы хуже, чем ничего.
        const source = join(workDir, `tree-${server.port}`);
        await mkdir(join(source, 'conf'), { recursive: true });
        await writeFile(join(source, 'run.sh'), '#!/bin/sh\necho ok\n');
        await writeFile(join(source, 'conf/app.ini'), 'key=value\n');
        const target = `${guardedDir}/tree`;

        const answer = JSON.stringify(
          await call(transfer, 'ssh_upload', {
            profile: server.name,
            local_path: source,
            remote_path: target,
            recursive: true,
            sudo: true,
            owner: 'root:root',
          })
        );

        expect(answer).toMatch(/not yet supported/i);
        // Обходной путь называется прямо в отказе: без него читателю некуда идти
        expect(answer).toMatch(/staging|cp -r/i);
        expect(await asRoot(`ls -A '${target}' 2>/dev/null | wc -l`)).toBe('0');
      });

      it('после sudo-передачи в /tmp не остаётся следов', async () => {
        // Файл едет в /tmp под пользователем и только потом встаёт на место.
        // Незаснятый staging — это и мусор, и утечка содержимого чужому глазу.
        // Имя staging задаёт buildSudoStagingPath: /tmp/.ssh-mcp-upload-<hex>
        const leftovers = await asRoot(
          `ls -A /tmp 2>/dev/null | grep -c '^\\.ssh-mcp-upload-' || true`
        );

        expect(leftovers).toBe('0');
      });
    });
  }
}

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});
