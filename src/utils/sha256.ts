/**
 * SHA256 helpers
 * Local hashing via Node crypto + remote hashing via shell with fallback
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/**
 * Compute sha256 of a local file (streaming, no full load to memory)
 */
export async function sha256OfFile(localPath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(localPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * How many files of the tree are read concurrently.
 *
 * Opening every file of a large tree at once runs into the process's open
 * file descriptor limit (EMFILE). That doesn't just break hashing — without
 * a free descriptor the process can't open a socket or a file either. A
 * capped concurrency keeps descriptor usage constant regardless of tree
 * size, at negligible cost to speed.
 */
const HASH_CONCURRENCY = 16;

/**
 * Compute sha256 for a list of files, reading no more than sixteen at once.
 * Results are returned in the same order as the input paths.
 *
 * The first unreadable file stops the work: the error propagates up, and
 * the remaining readers don't finish the tree the caller has already given
 * up on (for a download, they'd otherwise be reading the staging path right
 * before it gets deleted).
 */
export async function sha256OfFiles(localPaths: string[]): Promise<string[]> {
  const hashes = new Array<string>(localPaths.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (next < localPaths.length && !failed) {
      const index = next++;
      try {
        hashes[index] = await sha256OfFile(localPaths[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const readers = Math.min(HASH_CONCURRENCY, localPaths.length);
  await Promise.all(Array.from({ length: readers }, worker));
  return hashes;
}

/**
 * Compute sha256 of a Buffer
 */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
