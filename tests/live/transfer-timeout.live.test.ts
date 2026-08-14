/**
 * Живая проверка потолка передачи
 *
 * Раньше потолок был скрытый и общий — 300 секунд на любую передачу, назвать
 * свой вызывающий не мог. Теперь наоборот: потолок ставит вызывающий, а без
 * него передача идёт столько, сколько нужно.
 *
 * Юнит-тест видит только аргументы вызова. Здесь проверяется то, что после
 * обрыва осталось на сервере, — а это и есть цена ошибки: staging рядом с
 * боевым путём, который никто не уберёт.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_CONTROL_DIR, LAB_KEY, LAB_REQUIRED, LAB_SERVERS, labUnavailableReason } from './lab.js';

const LIVE_TIMEOUT_MS = 120_000;

/**
 * Столько передача заведомо не успеет: дерево целиком едет вчетверо дольше
 * (замерено — 230 мс на 32 МБ), а первые мегабайты уходят на сервер уже
 * через 20 мс. То есть обрыв случается посреди работы, а не до её начала:
 * иначе проверка «следов не осталось» подтверждала бы не уборку, а то, что
 * убирать было нечего. Тест это не принимает на веру — см. «обрыв
 * случается уже посреди передачи».
 */
const TINY_TIMEOUT_MS = 50;

/** Дерево ощутимого размера: обрыв должен случиться на ходу, а не до старта */
const PAYLOAD_MB = 32;

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'transfer-timeout-'));

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
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { TransferTool } = await import('../../src/tools/transfer-tool.js');
const { SSHExecutor } = await import('../../src/managers/ssh-executor.js');
const { closeAllRunners, getOpenSshRunner } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('живой потолок передачи', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`живой потолок передачи — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущен', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Потолок передачи: openssh @ ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new TransferTool();
      const executor = new SSHExecutor();
      const remoteBase = `/tmp/transfer-timeout-${server.port}`;
      const config = {
        host: '127.0.0.1',
        port: server.port,
        username: 'root',
        privateKeyPath: LAB_KEY,
        strictHostKeyChecking: 'no' as const,
        ignoreUserConfig: true,
      };

      let source: string;

      const call = (name: string, args: Record<string, unknown>) =>
        tool.handleCall({ params: { name, arguments: args } } as never);

      /**
       * Всё, что лежит в каталоге, включая наши временные пути.
       *
       * Ошибка листинга не глушится: молчаливый пустой список сделал бы
       * проверку «следов не осталось» зелёной на любой поломке — от упавшего
       * beforeAll до отвалившегося профиля.
       */
      const remoteEntries = async (): Promise<string[]> => {
        const result = await executor.executeChecked(config, `ls -a '${remoteBase}'`, {
        });
        return result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((name) => name && name !== '.' && name !== '..');
      };

      beforeAll(async () => {
        source = join(workDir, `payload-${server.port}`);
        await mkdir(source, { recursive: true });
        for (let i = 0; i < 4; i++) {
          await writeFile(join(source, `part-${i}.bin`), Buffer.alloc((PAYLOAD_MB / 4) * 1024 * 1024, i + 1));
        }
        await executor.execute(config, `rm -rf '${remoteBase}' && mkdir -p '${remoteBase}'`, {
        });
      });

      afterAll(async () => {
        await executor
          .execute(config, `rm -rf '${remoteBase}'`, {})
          .catch(() => undefined);
      });

      /**
       * Основание для следующей проверки: на этом таймауте передача успевает
       * начаться на сервере. Транспорт зовётся напрямую, мимо установщика, —
       * поэтому недоехавшее остаётся на месте и его видно. Без этого шага
       * «следов не осталось» доказывало бы лишь то, что scp умер до контакта
       * с сервером.
       */
      it('обрыв случается уже посреди передачи, а не до её начала', async () => {
        const probe = `${remoteBase}/probe`;
        const runner = await getOpenSshRunner(config);

        await expect(
          runner.upload(source, probe, { recursive: true, timeoutMs: TINY_TIMEOUT_MS })
        ).rejects.toThrow(/timed out/);

        const size = await executor.executeChecked(config, `du -sk '${probe}' | cut -f1`, {
        });
        expect(Number(size.stdout.trim())).toBeGreaterThan(0);

        await executor.execute(config, `rm -rf '${probe}'`, {});
      });

      it('названный таймаут обрывает передачу и не оставляет следов рядом с целью', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: `${remoteBase}/app`,
          verify: false,
          timeout: TINY_TIMEOUT_MS,
        });

        const text = (answer as { content: Array<{ text: string }> }).content[0].text;
        // Именно таймаут, а не «не смогли подключиться»: иначе проверка
        // зеленела бы на сломанной лаборатории, ничего не проверив
        expect(text).toMatch(new RegExp(`timed out after ${TINY_TIMEOUT_MS}ms`));
        // Ни цели, ни брошенного staging: установщик убирает свой временный путь
        expect(await remoteEntries()).toEqual([]);
      });

      it('без таймаута то же дерево доезжает целиком', async () => {
        const answer = await call('ssh_upload', {
          profile: server.name,
          local_path: source,
          remote_path: `${remoteBase}/app`,
          verify: true,
        });

        const text = (answer as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toContain('Upload OK');
        expect(text).toContain('files: 4');
        expect(await remoteEntries()).toEqual(['app']);
      });

      it('таймаут на скачивании обрывает его так же', async () => {
        const target = join(workDir, `pulled-${server.port}`);

        // Источник обязан существовать: иначе обрыв по таймауту неотличим
        // от «скачивать было нечего», и проверка ничего не значит
        expect(await remoteEntries()).toContain('app');

        const answer = await call('ssh_download', {
          profile: server.name,
          remote_path: `${remoteBase}/app`,
          local_path: target,
          recursive: true,
          verify: false,
          timeout: TINY_TIMEOUT_MS,
        });

        const text = (answer as { content: Array<{ text: string }> }).content[0].text;
        expect(text).toMatch(new RegExp(`timed out after ${TINY_TIMEOUT_MS}ms`));
      });
    });
  }

  /**
   * Сверка хэшей идёт обычной командой, а у команд общий потолок 30 секунд.
   * Пока он действовал, дерево на гигабайты доезжало и падало на сверке —
   * стена не исчезала, а переезжала. Здесь проверяется сквозной путь:
   * команда, заведомо длиннее прежнего потолка, доходит до конца.
   *
   * Один сервер вместо двух: проверяется наш код, а не разница утилит,
   * и каждая копия теста стоит полминуты.
   */
  describe('Команда без потолка', { timeout: LIVE_TIMEOUT_MS }, () => {
    const server = LAB_SERVERS[0];

    it('живёт дольше прежних тридцати секунд', async () => {
      const executor = new SSHExecutor();
      const startedAt = Date.now();

      const result = await executor.executeChecked(
        {
          host: '127.0.0.1',
          port: server.port,
          username: 'root',
          privateKeyPath: LAB_KEY,
          strictHostKeyChecking: 'no' as const,
          ignoreUserConfig: true,
        },
        'sleep 32 && echo alive',
        { timeout: 0 }
      );

      expect(result.stdout.trim()).toBe('alive');
      expect(Date.now() - startedAt).toBeGreaterThan(30_000);
    });
  });

  afterAll(async () => {
    await closeAllRunners();
    await rm(workDir, { recursive: true, force: true });
  });
}
