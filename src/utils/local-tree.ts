/**
 * Walks the local tree before an upload
 *
 * The tree is counted the same way the transport sees it: `scp -r` follows
 * symlinks and copies their targets, and stops on a broken link or a cycle.
 * Counting it differently would make the tool's answer diverge from what
 * actually went out: the file count and size would come out too low, and
 * the hash check would miss part of the tree.
 *
 * A broken link or a cycle is caught here, before the transfer. The transport
 * would notice them too, but only halfway through — part of the tree would
 * already be sitting on the server by then.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';

/** What's wrong with the link, from stat's error code */
function describeBadLink(relative: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ENOENT') {
    return new Error(
      `broken symlink in the tree: "${relative}" points at something that does not exist. ` +
      `Remove the link or fix its target — the transfer would fail halfway through.`
    );
  }

  if (code === 'ELOOP') {
    return new Error(
      `symlink loop in the tree: "${relative}" leads back to itself. ` +
      `Remove the link — the transfer would fail halfway through.`
    );
  }

  return error as Error;
}

/**
 * Relative paths of every file in the tree.
 *
 * A symlink to a file counts as a file, and a symlink to a directory is
 * followed — exactly what the transport will bring over.
 */
export async function listTreeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (relative: string, ancestors: Set<string>): Promise<void> => {
    const absolute = relative ? join(root, relative) : root;

    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;

      let info;
      try {
        info = await stat(join(absolute, entry.name));
      } catch (error) {
        throw describeBadLink(child, error);
      }

      if (info.isDirectory()) {
        // A symlink to an ancestor directory would send the walk into an
        // infinite loop, and stat alone won't tell: the directory itself exists
        const id = `${info.dev}:${info.ino}`;
        if (ancestors.has(id)) {
          throw new Error(
            `symlink loop in the tree: "${child}" leads back to a directory above it. ` +
            `Remove the link — the transfer would fail halfway through.`
          );
        }

        await walk(child, new Set([...ancestors, id]));
      } else if (info.isFile()) {
        files.push(child);
      }
    }
  };

  const rootInfo = await stat(root);
  await walk('', new Set([`${rootInfo.dev}:${rootInfo.ino}`]));
  return files;
}
