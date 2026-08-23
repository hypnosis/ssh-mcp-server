/**
 * Legend: what the words in a summary mean, said in the answer itself.
 *
 * A state like `limited` decides what the caller may do next, and the word
 * alone does not say it. The meaning used to live in the tool declaration,
 * which the caller reads once and long before the answer arrives.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

/**
 * Meanings of the words this answer actually used.
 *
 * The key names the field before the value, so the same word in two fields
 * never collides: `state=limited`, `jobs[].state=lost`. Keys are built here
 * and nowhere else.
 */
export type Legend = Record<string, string>;

/**
 * Explains only what turned up: a value nobody met costs no room, and the
 * legend stays an account of this answer rather than a copy of the schema.
 */
export function legendFor<Value extends string>(
  field: string,
  meanings: Record<Value, string>,
  seen: Array<Value | null | undefined>
): Legend {
  const legend: Legend = {};
  for (const value of seen) {
    if (value === null || value === undefined) continue;
    legend[`${field}=${value}`] = meanings[value];
  }
  return legend;
}

/**
 * The same meanings, written into the declaration the caller reads before
 * calling anything.
 *
 * The legend answers a caller holding an answer; a caller building a plan
 * holds none. Both are fed from one dictionary, so a value can never be
 * explained one way in the schema and another way in the answer.
 */
export function meaningsList<Value extends string>(meanings: Record<Value, string>): string {
  return `${Object.entries(meanings)
    .map(([value, meaning]) => `${value} — ${meaning as string}`)
    .join('; ')}.`;
}

/** Declared with every summary, empty where there was nothing to explain */
export const LEGEND_SCHEMA: OutputSchema = {
  type: 'object',
  description:
    'What the words in this answer mean. A key names the field before the value — ' +
    '"state=limited", "jobs[].state=lost" — and only the values this answer actually used are listed.',
  additionalProperties: { type: 'string' },
};
