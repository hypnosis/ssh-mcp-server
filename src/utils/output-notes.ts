/**
 * Notes about an incomplete response
 *
 * The transport collects command output into a buffer of limited size and
 * honestly reports when the output didn't fit. A human needs to see this
 * next: a piece of a file or a listing looks no different from the whole,
 * and a silently truncated scrap reads as a trustworthy answer.
 */

/** How much command output fits into the transport buffer; anything past this gets truncated */
export const OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'];

/** Human-readable size label: 10485760 → "10 MiB" */
export function byteLimitLabel(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded} ${BYTE_UNITS[unit]}`;
}

const OUTPUT_LIMIT_LABEL = byteLimitLabel(OUTPUT_LIMIT_BYTES);

/**
 * Exit codes the remote timeout guard uses to report that it killed a
 * command that ran too long.
 *
 * coreutils returns 124, BusyBox returns 143 (128 + SIGTERM). Both mean the
 * guard killed the command, but a bare 143 without explanation reads as the
 * command's own failure.
 */
const TIMEOUT_GUARD_EXIT_CODES = [124, 143];

export const TRUNCATED_OUTPUT_NOTE =
  `⚠️ Output truncated at the transport buffer limit (${OUTPUT_LIMIT_LABEL}) — ` +
  'this is only its first part.';

/** Append a note if the output is incomplete */
export function withTruncationNote(text: string, truncated: boolean): string {
  if (!truncated) return text;
  return text ? `${text}\n\n${TRUNCATED_OUTPUT_NOTE}` : TRUNCATED_OUTPUT_NOTE;
}

/**
 * Why the file read failed and what to do instead.
 *
 * A note doesn't help for a file: the content moves on as data — it gets
 * written back, parsed, compared. A truncated file is more dangerous than a
 * failure in that chain, so this is a failure with a ready workaround.
 */
export function truncatedReadMessage(path: string): string {
  return (
    `${path} does not fit into the transport buffer (${OUTPUT_LIMIT_LABEL}), ` +
    'so reading it as command output would return only its first part. ' +
    `Use ssh_download to fetch the whole file, or read it in ranges: sed -n '1,500p' ${path}.`
  );
}

/**
 * Bytes that don't form text arrive as a replacement character — the file is
 * already damaged, and writing it back would produce a different file. So
 * this is also a failure with a workaround, not a note on top of the content.
 */
export function binaryReadMessage(path: string): string {
  return (
    `${path} is not valid UTF-8 text: reading it as command output replaces the ` +
    'bytes that do not form characters, so the content would come back damaged. ' +
    'Read it with binary: true to get base64, or fetch the file with ssh_download.'
  );
}

export const PARTIAL_OUTPUT_NOTE =
  '⚠️ The command was stopped before it finished — this is only what it printed until then.';

/**
 * Output the command accumulated before it was stopped, under an
 * incomplete-output note.
 *
 * Empty string when there's nothing to print: the command may have been
 * killed before its first byte, and an empty section would read as "there
 * was no output", though there's no way to tell.
 */
export function partialOutputSection(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(`STDOUT:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`STDERR:\n${stderr.trimEnd()}`);
  if (parts.length === 0) return '';

  return `${PARTIAL_OUTPUT_NOTE}\n\n${parts.join('\n\n')}`;
}

/**
 * How many log search matches fit into a single response.
 *
 * Without a limit, the only boundary is the transport buffer, which sits far
 * above a reasonable response size — so an unbounded search would flood the
 * caller with the whole log instead of just the matches.
 */
export const DEFAULT_MAX_MATCHES = 200;

/** Note that the output was truncated by match count, not by buffer size */
export function matchLimitNote(max: number): string {
  return (
    `⚠️ Showing the first ${max} matches — the log has more. ` +
    'Raise maxMatches or narrow the query.'
  );
}

/**
 * Keep no more than `max` matches.
 *
 * A match differs from a context line by the character after the number:
 * `12:` for a found line and `12-` for a neighboring one, so only the
 * former is counted.
 */
export function limitMatches(
  text: string,
  max: number,
  /** Which end to keep: the oldest lines of the file, or the newest */
  from: 'start' | 'end' = 'start'
): { text: string; limited: boolean } {
  const lines = text.split('\n');
  const matchLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^(.*:)?\d+:/.test(lines[i])) matchLines.push(i);
  }

  if (matchLines.length <= max) return { text, limited: false };

  if (from === 'start') {
    return {
      text: lines.slice(0, matchLines[max]).join('\n').replace(/\n--$/, ''),
      limited: true,
    };
  }

  // Keeping the newest means cutting from above, and the cut starts at the
  // first match that survives — anything before it is context for a match
  // that is being dropped
  const firstKept = matchLines[matchLines.length - max];
  return {
    text: lines.slice(firstKept).join('\n').replace(/^--\n/, ''),
    limited: true,
  };
}

/** Whether the text read back contains a replacement character — a trace of lost bytes */
export function looksDamagedAsText(text: string): boolean {
  return text.includes('�');
}

/** Whether the code is the guard's report that it killed the command, not the command's own answer */
export function killedByTimeoutGuard(exitCode: number): boolean {
  return TIMEOUT_GUARD_EXIT_CODES.includes(exitCode);
}

/** Hint for the exit code, when the bare number alone would mislead */
export function exitCodeHint(exitCode: number): string {
  if (killedByTimeoutGuard(exitCode)) {
    return ' (killed by the timeout guard on the server — it ran past the allowed time)';
  }
  return '';
}
