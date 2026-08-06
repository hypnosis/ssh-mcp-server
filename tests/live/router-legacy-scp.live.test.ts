/**
 * Живая проверка сервера без подсистемы sftp
 *
 * Роутерный узел лаборатории (dropbear, sftp-server не собран) отвечает на
 * команды, но современный scp на нём обрывается. Транспорт обязан заметить это
 * сам и перейти на классический протокол — без настроек и без участия человека.
 *
 * Проверяется состояние сервера: что лежит на месте и что внутри. Имена при
 * сверке не печатаются и не подставляются в команды тем же способом, который
 * и проверяется, — содержимое читается по одному файлу за раз.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LAB_REQUIRED, LAB_ROUTER, labConfig, routerUnavailableReason } from './lab.js';
import { shellQuote } from '../../src/utils/shell-arg.js';

const LIVE_TIMEOUT_MS = 60_000;
const REMOTE_DIR = '/tmp/router-legacy-scp';

const unavailable = await routerUnavailableReason();

process.env.SSH_MCP_CONTROL_DIR = '/tmp/mcp-router-ctl';

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');

if (unavailable && LAB_REQUIRED) {
  describe('сервер без sftp живьём', () => {
    it('роутерный узел должен быть поднят', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`сервер без sftp — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущена', () => undefined);
  });
} else {
  describe(`Передача на ${LAB_ROUTER.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
    const runner = async () => getOpenSshRunner(labConfig(LAB_ROUTER));
    let workDir: string;

    /** Содержимое удалённого файла — читается командой, а не передачей */
    const remoteText = async (remotePath: string): Promise<string> => {
      const transport = await runner();
      const result = await transport.exec(`cat ${shellQuote(remotePath)}`);
      return result.stdout;
    };

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'router-legacy-'));
      const transport = await runner();
      await transport.exec(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`);
    });

    afterAll(async () => {
      const transport = await runner();
      await transport.exec(`rm -rf ${REMOTE_DIR}`);
      await closeAllRunners();
      await rm(workDir, { recursive: true, force: true });
    });

    it('узел отвечает на команды — ломается именно передача, а не соединение', async () => {
      const transport = await runner();
      const result = await transport.exec('echo alive');
      expect(result.stdout.trim()).toBe('alive');
    });

    it('одиночный файл доезжает и содержимое сходится', async () => {
      const local = join(workDir, 'single.txt');
      await writeFile(local, 'payload-single\n');

      const transport = await runner();
      await transport.upload(local, `${REMOTE_DIR}/single.txt`);

      expect(await remoteText(`${REMOTE_DIR}/single.txt`)).toBe('payload-single\n');
    });

    it('файл скачивается обратно тем же содержимым', async () => {
      const transport = await runner();
      await transport.exec(`printf 'made-on-server\\n' > ${shellQuote(`${REMOTE_DIR}/back.txt`)}`);

      const local = join(workDir, 'back.txt');
      await transport.download(`${REMOTE_DIR}/back.txt`, local);

      expect(await readFile(local, 'utf8')).toBe('made-on-server\n');
    });

    it('дерево каталогов уезжает целиком', async () => {
      const treeDir = join(workDir, 'tree');
      await mkdir(join(treeDir, 'sub'), { recursive: true });
      await writeFile(join(treeDir, 'a.txt'), 'first\n');
      await writeFile(join(treeDir, 'sub', 'b.txt'), 'second\n');

      const transport = await runner();
      await transport.upload(treeDir, `${REMOTE_DIR}/tree`, { recursive: true });

      expect(await remoteText(`${REMOTE_DIR}/tree/a.txt`)).toBe('first\n');
      expect(await remoteText(`${REMOTE_DIR}/tree/sub/b.txt`)).toBe('second\n');
    });

    /**
     * На классическом протоколе путь разбирает shell сервера, поэтому проверять
     * надо не один опасный знак, а всё семейство сразу.
     */
    const RISKY_NAMES = [
      'with space.txt',
      "it's.txt",
      'say "hi".txt',
      '$(touch MARKER-subst).txt',
      '`touch MARKER-backtick`.txt',
      'a; touch MARKER-semi; b.txt',
      'a && touch MARKER-and.txt',
      'a > MARKER-redir.txt',
      'star*name.txt',
      'back\\slash.txt',
      'файл-кириллица.txt',
    ];

    it('опасные имена уезжают буквально, а не исполняются', async () => {
      const transport = await runner();
      const namesDir = `${REMOTE_DIR}/names`;
      await transport.exec(`mkdir -p ${shellQuote(namesDir)}`);

      const local = join(workDir, 'risky-src');
      await writeFile(local, 'risky-payload\n');

      for (const name of RISKY_NAMES) {
        await transport.upload(local, `${namesDir}/${name}`);
        expect(await remoteText(`${namesDir}/${name}`)).toBe('risky-payload\n');
      }

      const listing = await transport.exec(`ls -1 ${shellQuote(namesDir)} | wc -l`);
      expect(Number(listing.stdout.trim())).toBe(RISKY_NAMES.length);

      // Подстановка создала бы файл в стороне, поэтому счёт её не поймал бы
      const markers = await transport.exec(
        `find / -maxdepth 2 -name 'MARKER-*' 2>/dev/null | head -5`
      );
      expect(markers.stdout.trim()).toBe('');
    });

    it('скачивание тех же имён возвращает то же содержимое', async () => {
      const transport = await runner();
      const namesDir = `${REMOTE_DIR}/names`;

      for (const [index, name] of RISKY_NAMES.entries()) {
        const local = join(workDir, `risky-back-${index}`);
        await transport.download(`${namesDir}/${name}`, local);
        expect(await readFile(local, 'utf8')).toBe('risky-payload\n');
      }
    });

    /** Перевод строки в имени классический протокол принять не может */
    it('имя с переводом строки отклоняется, а не уезжает наугад', async () => {
      const transport = await runner();
      const local = join(workDir, 'single.txt');

      await expect(
        transport.upload(local, `${REMOTE_DIR}/new\nline.txt`)
      ).rejects.toThrow(/newline/);
    });
  });
}
