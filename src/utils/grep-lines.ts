/**
 * Turning grep's output into found lines.
 *
 * The file name comes from the caller, not from the line: paths are expanded
 * before the search and grep runs on one file at a time, so a name with a
 * colon in it would only make the prefix ambiguous.
 */

/** One line of the answer: a match, or a neighbour shown alongside it */
export interface FoundLine {
  file: string;
  line: number;
  text: string;
  /** A neighbouring line brought in by the context option, not a match itself */
  context: boolean;
}

/**
 * `12:text` is a match, `12-text` is its neighbour — the character after the
 * number is the whole difference, and a caller quoting a neighbour as a find
 * would be quoting a line that does not match at all.
 *
 * Anchored at the start on purpose: a line of the log can hold a number and a
 * colon of its own, and without the anchor its middle would be read as the
 * line number grep never printed.
 */
const NUMBERED_LINE = /^(\d+)([:-])([\s\S]*)$/;

/**
 * Found lines, in the order grep printed them.
 *
 * `dropLast` is for output the transport cut mid-line: the last line arrived
 * in half, and half a line handed over as a whole one is a quote of something
 * nobody wrote.
 */
export function parseGrepLines(
  output: string,
  file: string,
  options: { dropLast?: boolean } = {}
): FoundLine[] {
  const found: FoundLine[] = [];

  for (const raw of output.split('\n')) {
    const parsed = NUMBERED_LINE.exec(raw);
    if (!parsed) continue;

    found.push({
      file,
      line: Number(parsed[1]),
      text: parsed[3],
      context: parsed[2] === '-',
    });
  }

  if (options.dropLast) found.pop();

  return found;
}
