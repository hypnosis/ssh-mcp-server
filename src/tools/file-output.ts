/**
 * Shape of the answer ssh_file_list gives: a directory taken apart into
 * fields rather than handed over as the output of `ls`.
 *
 * The tool is what a caller reaches for right after writing a file, to see
 * the mode and the owner that were applied. Prose makes that caller parse a
 * table whose columns move between servers — the very work the tools exist
 * to take off them.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { legendFor, LEGEND_SCHEMA, meaningsList, type Legend } from './legend.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

export type EntryType = 'file' | 'dir' | 'symlink' | 'other';

/** What each kind says about the entry, and about what `size` counts for it */
const TYPE_MEANING: Record<EntryType, string> = {
  file: 'a regular file, and size is its bytes',
  dir: 'a directory: size is the directory entry itself, never the sum of what it holds',
  symlink: 'a symbolic link — target says where it points, and size is the length of that path',
  other: 'a socket, fifo or device node: there is no content to read here',
};

/**
 * Names the question the field answers before the words it answers with: a
 * directory read as a file sends a caller downloading 4096 bytes of nothing.
 */
const TYPE_FIELD_DESCRIPTION =
  'What the entry is, which decides what size means for it. ' + meaningsList(TYPE_MEANING);

export interface ListEntry {
  /** Named as it was asked for: a name in the directory, a path below it when recursive */
  name: string;
  type: EntryType;
  /** Bytes, as the server counted them */
  size: number;
  /** Access rights the way chmod takes them: "644", "4755" */
  mode: string;
  owner: string;
  group: string;
  /** Modification time in seconds since epoch */
  mtime: number;
  /** Where a symlink points, verbatim; null for everything else */
  target: string | null;
}

/** The answer of one listing */
export interface ListSummary {
  /** The directory that was listed, after the tilde and the path rules */
  path: string;
  entries: ListEntry[];
  /**
   * Directories the listing was not allowed to enter. What they hold is
   * unknown: a listing short by exactly the interesting directory reads as a
   * complete one.
   */
  unreadable: string[];
  /** The answer hit the output limit, so the list ends earlier than the directory does */
  truncated: boolean;
  legend: Legend;
}

/**
 * The answer, legend included. Built here so that a listing of one file and a
 * listing of a thousand explain their words the same way.
 */
export function listSummary(
  path: string,
  entries: ListEntry[],
  unreadable: string[],
  truncated: boolean
): ListSummary {
  return {
    path,
    entries,
    unreadable,
    truncated,
    legend: legendFor('entries[].type', TYPE_MEANING, entries.map((entry) => entry.type)),
  };
}

export const LIST_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Name inside the listed directory; with recursive, the path below it. ' +
              'Never a full path, so it reads the same either way.',
          },
          type: {
            type: 'string',
            enum: ['file', 'dir', 'symlink', 'other'],
            description: TYPE_FIELD_DESCRIPTION,
          },
          size: { type: 'number' },
          mode: {
            type: 'string',
            description: 'Octal, as chmod takes it: "644", "4755" — not the rwx letters ls prints.',
          },
          owner: { type: 'string' },
          group: { type: 'string' },
          mtime: { type: 'number', description: 'Seconds since epoch, UTC.' },
          target: { type: ['string', 'null'] },
        },
      },
    },
    unreadable: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Directories nobody was allowed to enter. Their contents are missing from entries, ' +
        'and a list short by the one that mattered looks complete.',
    },
    truncated: {
      type: 'boolean',
      description: 'The output limit cut the answer: the directory holds more than entries lists.',
    },
    legend: LEGEND_SCHEMA,
  },
};
