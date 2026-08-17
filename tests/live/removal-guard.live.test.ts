/**
 * Живая проверка защиты от сноса системы
 *
 * Юниты проверяют разбор, здесь проверяется последствие: после отказа система
 * обязана быть цела, а после разрешённой команды — исчезнуть ровно то, что
 * просили. Текст ответа сам по себе ничего не доказывает: инструмент мог
 * напечатать отказ и всё равно отправить команду — именно так вёл себя
 * прежний список «опасных шаблонов».
 *
 * Ссылка на корень тут настоящая. Замер показал, что `rm -rf ссылка/` на
 * coreutils опустошает цель, а на BusyBox удаляет саму ссылку, — поэтому
 * оба контейнера проверяются одинаково, а вывод делается по худшему.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;
const MARKER = '# CONFIRMED-DESTRUCTIVE';

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'removal-guard-'));

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

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('защита от сноса системы живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`защита от сноса системы — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущена', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Защита от сноса: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new ExecTool();
      const executor = new SSHExecutor();
      const dir = `/tmp/removal-guard-${server.port}`;
      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      /** Команда мимо инструмента: проверяем последствия, а не его же слова */
      const onServer = async (command: string): Promise<string> => {
        const result = await executor.execute(config, command, {});
        return result.stdout.trim();
      };

      const call = async (command: string): Promise<string> => {
        const answer = await tool.handleCall({
          params: { name: 'ssh_exec', arguments: { profile: server.name, command } },
        } as never);
        return answer.content.map((c: { text: string }) => c.text).join('\n');
      };

      /** Цела ли система: файл, который снёс бы любой заход в корень или /etc */
      const systemIntact = async (): Promise<boolean> =>
        (await onServer('ls /etc/hostname >/dev/null 2>&1 && echo цел')) === 'цел';

      beforeAll(async () => {
        await onServer(
          `rm -rf ${dir} && mkdir -p ${dir}/real && echo содержимое > ${dir}/real/file && ` +
            `ln -s / ${dir}/to-root && ln -s ${dir}/real ${dir}/to-real`
        );
      });

      afterAll(async () => {
        await onServer(`rm -rf ${dir}`).catch(() => undefined);
      });

      it('снос корня не доезжает до сервера', async () => {
        const answer = await call('rm -rf /');

        expect(answer).toContain('BLOCKED');
        expect(answer).toContain('filesystem root');
        expect(await systemIntact()).toBe(true);
      });

      it('снос системного дерева не доезжает до сервера', async () => {
        const answer = await call('rm -rf /etc');

        expect(answer).toContain('BLOCKED');
        expect(await systemIntact()).toBe(true);
      });

      it('ссылка на корень со слэшем останавливается, и корень цел', async () => {
        const answer = await call(`rm -rf ${dir}/to-root/`);

        expect(answer).toContain('BLOCKED');
        expect(answer).toContain('via symlink');
        expect(await systemIntact()).toBe(true);
        // Сама ссылка тоже на месте: команда не выполнялась вовсе
        expect(await onServer(`ls -d ${dir}/to-root 2>/dev/null | tail -1`)).toBe(`${dir}/to-root`);
      });

      it('ссылка без слэша удаляется как ссылка, цель остаётся', async () => {
        const answer = await call(`rm -rf ${dir}/to-real`);

        expect(answer).not.toContain('BLOCKED');
        expect(await onServer(`ls -d ${dir}/to-real 2>&1 | tail -1`)).toContain('to-real');
        // Проверка по существу: содержимое цели ссылки на месте
        expect(await onServer(`cat ${dir}/real/file`)).toBe('содержимое');
      });

      it('обычная уборка идёт без помех', async () => {
        await onServer(`mkdir -p ${dir}/build && touch ${dir}/build/artifact`);

        const answer = await call(`rm -rf ${dir}/build`);

        expect(answer).not.toContain('BLOCKED');
        expect(await onServer(`ls -d ${dir}/build 2>&1 | tail -1`)).toContain('No such');
      });

      it('цель, которую раскрывает сервер, не выполняется вслепую', async () => {
        const answer = await call('rm -rf "$SSH_MCP_UNSET_VAR"/removal-guard-probe');

        expect(answer).toContain('BLOCKED');
        expect(answer).toContain('expanded by the server');
        expect(await systemIntact()).toBe(true);
      });

      it('маркер подтверждения снимает отказ', async () => {
        // Цель безобидна: с раскрытием пустой переменной получится
        // /removal-guard-probe, которого нет. Проверяется механизм, не снос.
        const answer = await call(
          `rm -rf "$SSH_MCP_UNSET_VAR"/removal-guard-probe ${MARKER}`
        );

        expect(answer).not.toContain('BLOCKED');
        expect(await systemIntact()).toBe(true);
      });

      it('опасная команда в середине батча отменяет весь вызов', async () => {
        await onServer(`mkdir -p ${dir}/batch && touch ${dir}/batch/artifact`);

        const answer = await tool.handleCall({
          params: {
            name: 'ssh_exec',
            arguments: {
              profile: server.name,
              command: [`rm -rf ${dir}/batch`, 'rm -rf /etc'],
            },
          },
        } as never);
        const text = answer.content.map((c: { text: string }) => c.text).join('\n');

        expect(text).toContain('BLOCKED');
        // Первая команда была безопасной, но не выполнилась: иначе половина
        // батча уехала бы, а состояние сервера стало бы неизвестным
        expect(await onServer(`ls -d ${dir}/batch 2>&1 | tail -1`)).toBe(`${dir}/batch`);
        expect(await systemIntact()).toBe(true);
      });
    });
  }

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });
}
