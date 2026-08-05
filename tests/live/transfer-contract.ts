/**
 * Контракт передачи файлов
 *
 * Мок здесь бесполезен: он не покажет, что оказалось на диске. Поэтому набор
 * гоняется против настоящих ssh и scp на живых серверах.
 *
 * Главное утверждение: `upload(X, Y, {recursive:true})` создаёт Y и кладёт
 * внутрь содержимое X — не `Y/<имя X>/…`. Цель всегда несуществующая; её
 * создаёт транспорт. Существующая цель — нарушение контракта вызывающим,
 * а не повод «положить внутрь».
 *
 * Файл не заканчивается на .test.ts намеренно: его подключает transfer.live.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CommandRunner } from '../../src/runner/types.js';
import { SSHCancelledError, SSHTimeoutError } from '../../src/runner/errors.js';
import {
  createTree,
  localManifest,
  parseRemoteManifest,
  remoteManifestCommand,
  TREE_EMPTY_DIR,
  type Manifest,
} from './manifest.js';

/** Живая передача идёт дольше пяти секунд по умолчанию */
const LIVE_TIMEOUT_MS = 60_000;

export interface TransferHarness {
  /** Имя для заголовка: «openssh @ alpine/BusyBox» */
  name: string;
  createRunner(): Promise<CommandRunner> | CommandRunner;
  /** Куда класть временные каталоги на сервере */
  remoteBase: string;
  /** Отдать наружу манифест приехавшего дерева, если вызывающему есть с чем его сверить */
  record?(manifest: Manifest): void;
  /** Закрыть транспорт после набора */
  cleanup?(runner: CommandRunner): Promise<void>;
}

export function describeTransferContract(harness: TransferHarness): void {
  describe(`Transfer contract: ${harness.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
    let runner: CommandRunner;
    let localRoot: string;
    let treeDir: string;
    let expected: Manifest;

    beforeAll(async () => {
      runner = await harness.createRunner();

      localRoot = await mkdtemp(join(tmpdir(), 'xfer-'));
      treeDir = join(localRoot, 'tree');
      await createTree(treeDir);
      expected = await localManifest(treeDir);

      const prepared = await runner.exec(`rm -rf '${harness.remoteBase}' && mkdir -p '${harness.remoteBase}'`);
      expect(prepared.exitCode).toBe(0);
    });

    afterAll(async () => {
      await runner.exec(`rm -rf '${harness.remoteBase}'`).catch(() => undefined);
      await rm(localRoot, { recursive: true, force: true });
      await harness.cleanup?.(runner);
    });

    /** Манифест удалённого каталога — считает find, а не наш код */
    async function remoteManifest(remoteDir: string): Promise<Manifest> {
      const result = await runner.exec(remoteManifestCommand(remoteDir));
      expect(result.exitCode).toBe(0);
      return parseRemoteManifest(result.stdout);
    }

    it('файл едет в несуществующую цель', async () => {
      const target = `${harness.remoteBase}/single/plain.txt`;
      await runner.exec(`mkdir -p '${harness.remoteBase}/single'`);

      await runner.upload(join(treeDir, 'plain.txt'), target);

      const result = await runner.exec(`cat '${target}'`);
      expect(result.stdout).toBe('простой файл\n');
    });

    it('каталог едет в несуществующую цель: структура, права и имена сохранены', async () => {
      const target = `${harness.remoteBase}/tree`;

      await runner.upload(treeDir, target, { recursive: true });

      const actual = await remoteManifest(target);
      harness.record?.(actual);
      expect(actual).toBe(expected);
    });

    it('пустой каталог всё равно создаётся', async () => {
      const source = join(localRoot, 'empty');
      await mkdir(source, { recursive: true });
      const target = `${harness.remoteBase}/empty`;

      await runner.upload(source, target, { recursive: true });

      const result = await runner.exec(`test -d '${target}' && echo yes`);
      expect(result.stdout.trim()).toBe('yes');
    });

    it('скачивание возвращает дерево один в один', async () => {
      const remoteTree = `${harness.remoteBase}/for-download`;
      await runner.upload(treeDir, remoteTree, { recursive: true });
      const target = join(localRoot, 'downloaded');

      await runner.download(remoteTree, target, { recursive: true });

      expect(await localManifest(target)).toBe(expected);
    });

    it('пустой каталог доезжает и при скачивании', async () => {
      const remoteDir = `${harness.remoteBase}/download-empty`;
      await runner.exec(`mkdir -p '${remoteDir}/${TREE_EMPTY_DIR}'`);
      const target = join(localRoot, 'downloaded-empty');

      await runner.download(remoteDir, target, { recursive: true });

      expect(await localManifest(target)).toBe(`d ${TREE_EMPTY_DIR}`);
    });

    it('нет источника — исключение, а не тихий успех', async () => {
      await expect(
        runner.upload(join(localRoot, 'no-such-file'), `${harness.remoteBase}/nowhere.txt`)
      ).rejects.toThrow();
    });

    it('цель в несуществующем каталоге — исключение', async () => {
      await expect(
        runner.upload(join(treeDir, 'plain.txt'), `${harness.remoteBase}/no/such/dir/file.txt`)
      ).rejects.toThrow();
    });

    it('таймаут передачи — SSHTimeoutError', async () => {
      const big = join(localRoot, 'big.bin');
      await writeFile(big, Buffer.alloc(16 * 1024 * 1024, 7));

      await expect(
        runner.upload(big, `${harness.remoteBase}/big.bin`, { timeoutMs: 1 })
      ).rejects.toBeInstanceOf(SSHTimeoutError);
    });

    it('отмена передачи — SSHCancelledError', async () => {
      const big = join(localRoot, 'big.bin');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await expect(
        runner.upload(big, `${harness.remoteBase}/cancelled.bin`, { signal: controller.signal })
      ).rejects.toBeInstanceOf(SSHCancelledError);
    });

    it('ссылки внутри дерева разыменовываются', async () => {
      const source = join(localRoot, 'links');
      await mkdir(join(source, 'dir'), { recursive: true });
      await writeFile(join(source, 'dir/inside.txt'), 'внутри\n');
      await symlink('dir', join(source, 'link-to-dir'));
      await symlink('dir/inside.txt', join(source, 'link-to-file'));
      const target = `${harness.remoteBase}/links`;

      await runner.upload(source, target, { recursive: true });

      // Ссылка приезжает копией: на файл — файлом, на каталог — каталогом
      // с содержимым. Это поведение scp, и оно становится общим после флипа.
      const lines = (await remoteManifest(target)).split('\n');
      const paths = lines.map((line) => line.split(' ').slice(line.startsWith('d ') ? 1 : 3).join(' '));
      expect(paths.sort()).toEqual([
        'dir',
        'dir/inside.txt',
        'link-to-dir',
        'link-to-dir/inside.txt',
        'link-to-file',
      ]);

      // Копия по ссылке — та же самая, что и оригинал
      const hashOf = (path: string) =>
        lines.find((line) => line.endsWith(` ${path}`))?.split(' ')[2];
      expect(hashOf('link-to-file')).toBe(hashOf('dir/inside.txt'));
    });

    it('битая ссылка обрывает передачу', async () => {
      const source = join(localRoot, 'broken-link');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'file.txt'), 'обычный файл\n');
      await symlink('nowhere.txt', join(source, 'broken'));

      await expect(
        runner.upload(source, `${harness.remoteBase}/broken-link`, { recursive: true })
      ).rejects.toThrow();
    });

    it('цикл ссылок обрывает передачу', async () => {
      const source = join(localRoot, 'loop-link');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'file.txt'), 'обычный файл\n');
      await symlink('loop-b', join(source, 'loop-a'));
      await symlink('loop-a', join(source, 'loop-b'));

      await expect(
        runner.upload(source, `${harness.remoteBase}/loop-link`, { recursive: true })
      ).rejects.toThrow();
    });

    it('рекурсивная передача считается одной передачей', async () => {
      const before = (await runner.stats()).transfersThisSession;

      await runner.upload(treeDir, `${harness.remoteBase}/counted`, { recursive: true });

      const after = (await runner.stats()).transfersThisSession;
      expect(after - before).toBe(1);
    });
  });
}
