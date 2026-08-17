/**
 * The installer's file operations on the local machine.
 *
 * Needed by download: today it writes straight into the user's final path,
 * and an interrupted download leaves the beginning of the file in place of
 * the whole thing. The install protocol is the same on both sides; only
 * these operations differ.
 */

import { mkdir, readdir, rename, rm, lstat, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { ArtifactScan, MountCheck, PathKind, PathOps } from './installer.js';
import { ARTIFACT_PREFIXES } from '../utils/tmp-name.js';

export const localPathOps: PathOps = {
  /**
   * We look at the path itself, not at where it leads: replacing a link
   * would mean either overwriting an unrelated file elsewhere, or leaving
   * the user without the very connection the link was created for.
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

  /** Mount point: the path itself and its parent sit on different devices */
  async isSeparateFilesystem(path: string): Promise<MountCheck> {
    try {
      const [own, parent] = await Promise.all([stat(path), stat(dirname(path))]);
      return own.dev !== parent.dev ? 'separate' : 'same';
    } catch {
      return 'unknown';
    }
  },

  /**
   * Our temporary paths left in the directory by past operations.
   * Read-only: they cannot be removed here — another call may be running alongside.
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
