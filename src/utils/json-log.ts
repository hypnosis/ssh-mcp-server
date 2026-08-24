/**
 * Unwrap the records docker's json-file driver writes.
 *
 * One record per line: `{"log":"text\n","stream":"stdout","time":"..."}`. The
 * caller wants the text the container printed, not the envelope around it.
 * A line that does not parse comes back untouched — an unreadable record is
 * shown as it lies on disk rather than dropped, because a dropped line is
 * indistinguishable from a line that was never written.
 */

/** One record as the driver stores it */
interface JsonLogRecord {
  log?: unknown;
}

/** The text a container printed, from the record wrapped around it */
export function unwrapJsonLogLine(raw: string): string {
  if (!raw.startsWith('{')) return raw;

  let record: JsonLogRecord;
  try {
    record = JSON.parse(raw) as JsonLogRecord;
  } catch {
    return raw;
  }

  if (!record || typeof record.log !== 'string') return raw;

  // The driver keeps the newline the container printed; the answer already
  // separates lines itself, and a second one would show as a blank line
  return record.log.replace(/\r?\n$/, '');
}

/** The same over a whole block, keeping the line count intact */
export function unwrapJsonLog(text: string): string {
  if (!text) return text;
  return text.split('\n').map(unwrapJsonLogLine).join('\n');
}
