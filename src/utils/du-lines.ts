/**
 * Parses the `du -sh` listing.
 */

/** One entry: how much it takes and where it lies. */
export interface DuEntry {
  size: string;
  path: string;
}

/** Parsed entries and the lines that could not be parsed. */
export interface DuListing {
  entries: DuEntry[];
  unparsed: string[];
}

/**
 * A size as du prints it: digits, optionally a fraction and a unit letter.
 * Anything else in that column is du talking, not measuring.
 */
const SIZE = /^\d+(\.\d+)?[KMGTPEB]?$/i;

/**
 * The `du -sh` listing into entries.
 *
 * Size and path are split on the first gap only: a directory name may hold
 * spaces, and splitting on every gap would cut such a name in half and report
 * a path that does not exist.
 *
 * A line whose first column is not a size is du's own complaint about a
 * directory it could not read — kept as unparsed, because read as an entry it
 * would claim a path that was never measured.
 */
export function parseDuLines(text: string): DuListing {
  const entries: DuEntry[] = [];
  const unparsed: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\S+)\s+(.+)$/.exec(trimmed);
    if (!match || !SIZE.test(match[1])) {
      unparsed.push(trimmed);
      continue;
    }
    entries.push({ size: match[1], path: match[2] });
  }

  return { entries, unparsed };
}
