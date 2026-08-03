/**
 * SHA256 helpers
 * Local hashing via Node crypto + remote hashing via shell with fallback
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

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
 * Compute sha256 of a Buffer
 */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Get size of a local file
 */
export async function localFileSize(localPath: string): Promise<number> {
  const s = await stat(localPath);
  return s.size;
}
