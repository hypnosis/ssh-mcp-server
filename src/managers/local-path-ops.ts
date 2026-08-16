/**
 * Файловые операции установщика на локальной машине
 *
 * Нужны скачиванию: сегодня оно пишет прямо в конечный путь пользователя,
 * и оборванная загрузка оставляет вместо целого файла его начало. Протокол
 * установки одинаков для обеих сторон, различаются только эти операции.
 */

import { mkdir, readdir, rename, rm, lstat, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { ArtifactScan, MountCheck, PathKind, PathOps } from './installer.js';
import { ARTIFACT_PREFIXES } from '../utils/tmp-name.js';

export const localPathOps: PathOps = {
  /**
   * Смотрим на сам путь, а не на то, куда он ведёт: подменить ссылку — значит
   * либо переписать чужой файл в стороне, либо оставить пользователя без той
   * связи, ради которой ссылка и создавалась.
   */
  async inspect(path: string): Promise<PathKind> {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) return 'symlink';
      return stats.isDirectory() ? 'directory' : 'file';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  },

  /** Точка монтирования: сам путь и его родитель лежат на разных устройствах */
  async isSeparateFilesystem(path: string): Promise<MountCheck> {
    try {
      const [own, parent] = await Promise.all([stat(path), stat(dirname(path))]);
      return own.dev !== parent.dev ? 'separate' : 'same';
    } catch {
      return 'unknown';
    }
  },

  /**
   * Наши временные пути, оставшиеся в каталоге от прошлых операций.
   * Только чтение: убирать их нельзя — рядом может работать другой вызов.
   */
  async listArtifacts(directory: string): Promise<ArtifactScan> {
    const names = await readdir(directory);
    return {
      paths: names
        .filter((name) => ARTIFACT_PREFIXES.some((prefix) => name.startsWith(prefix)))
        .map((name) => join(directory, name)),
    };
  },

  async ensureParent(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
  },

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },

  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
