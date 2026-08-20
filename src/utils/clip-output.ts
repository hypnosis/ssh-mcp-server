/**
 * Fitting command output into an answer field.
 *
 * A field carries the output itself, so it needs a ceiling the transport
 * buffer does not give: 10 MiB of journal would arrive as data and crowd out
 * everything else the caller holds. What is cut is said in bytes rather than
 * shown by a seam alone — a command can print a line that looks exactly like
 * one, and only a number the server put there cannot be faked by the output.
 */

import { byteLimitLabel } from './output-notes.js';

/** How much output of one command fits into a field */
export const FIELD_LIMIT_BYTES = 128 * 1024;

/** Marks where the middle was removed, so the two halves are not read as one run of output */
const SEAM = '── clipped ';

export interface ClippedText {
  text: string;
  /** Bytes removed from the middle; `0` — the output arrived whole */
  clippedBytes: number;
}

/**
 * The output as it goes into a field.
 *
 * Both ends are kept because the meaning sits at either one: a table puts it
 * in the header, a build or a log puts it in the last lines. `keepTail: false`
 * is for output that was already cut by the transport — there the end of what
 * arrived is not the end of the output, and offering it as a tail would pass
 * an incomplete answer off as a whole one.
 */
export function clipForField(
  text: string,
  options: { limit?: number; keepTail?: boolean } = {}
): ClippedText {
  const limit = options.limit ?? FIELD_LIMIT_BYTES;
  const keepTail = options.keepTail ?? true;
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= limit) return { text, clippedBytes: 0 };

  if (!keepTail) {
    const head = headOf(bytes, limit);
    const clippedBytes = bytes.length - Buffer.from(head, 'utf8').length;
    return { text: `${head}\n${seamLabel(clippedBytes)}`, clippedBytes };
  }

  const half = Math.floor(limit / 2);
  const head = headOf(bytes, half);
  const tail = tailOf(bytes, limit - half);
  const kept = Buffer.from(head, 'utf8').length + Buffer.from(tail, 'utf8').length;
  const clippedBytes = bytes.length - kept;

  return { text: `${head}\n${seamLabel(clippedBytes)}\n${tail}`, clippedBytes };
}

/** The seam names the amount, because the caller has to know what it is missing */
function seamLabel(clippedBytes: number): string {
  return `${SEAM}${byteLimitLabel(clippedBytes)} ──`;
}

/**
 * First `size` bytes, rounded down to a whole character.
 *
 * Half a character decodes into the replacement mark, and that mark means
 * damaged data everywhere else in this server — clipping must not start
 * looking like corruption.
 */
function headOf(bytes: Buffer, size: number): string {
  let end = Math.min(size, bytes.length);
  while (end > 0 && isContinuation(bytes[end])) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** Last `size` bytes, moved forward to a whole character */
function tailOf(bytes: Buffer, size: number): string {
  let start = Math.max(bytes.length - size, 0);
  while (start < bytes.length && isContinuation(bytes[start])) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** A byte that continues a character rather than starting one */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}
