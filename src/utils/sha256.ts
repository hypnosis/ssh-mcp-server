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
 * Build a remote shell command that prints the sha256 hex of a file.
 * Tries `sha256sum`, falls back to `openssl dgst -sha256`.
 * Output is always a single hex string (40+ chars), nothing else.
 *
 * The path is single-quoted by the caller; we expect it already escaped.
 */
export function buildRemoteSha256Command(quotedPath: string): string {
  // sha256sum prints "<hex>  <path>" — extract first field
  // openssl prints "SHA256(<path>)= <hex>" — extract last field
  return (
    `(if command -v sha256sum >/dev/null 2>&1; then ` +
    `sha256sum ${quotedPath} | awk '{print $1}'; ` +
    `elif command -v openssl >/dev/null 2>&1; then ` +
    `openssl dgst -sha256 ${quotedPath} | awk '{print $NF}'; ` +
    `else echo "NO_SHA256_TOOL" >&2; exit 127; fi)`
  );
}

/**
 * Parse a remote sha256 stdout line into a clean hex string.
 * Throws if no valid hex found.
 */
export function parseRemoteSha256(stdout: string): string {
  const trimmed = stdout.trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`Invalid remote sha256 output: "${stdout.slice(0, 80)}"`);
  }
  return trimmed.toLowerCase();
}

/**
 * Get size of a local file
 */
export async function localFileSize(localPath: string): Promise<number> {
  const s = await stat(localPath);
  return s.size;
}
