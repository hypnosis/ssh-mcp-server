/**
 * Shape of the summary for tools that put data somewhere: ssh_file_write,
 * ssh_upload, ssh_download.
 *
 * The three verification outcomes are the whole point. In the text they are a
 * tail of the line — " (sha256 verified)", " (NOT verified: …)" or nothing at
 * all — and the last one, "nobody asked for a check", looks exactly like an
 * ordinary line about a written file. Absence of a check must not read as a
 * check that passed.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { legendFor, LEGEND_SCHEMA, type Legend } from './legend.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

export type VerifiedOutcome = 'verified' | 'unavailable' | 'skipped';

/** What each verification outcome says about the copy that was left behind */
const VERIFIED_MEANING: Record<VerifiedOutcome, string> = {
  verified: 'sha256 was compared after the write and matched',
  unavailable: 'the check had nothing to work with, and reason says what was missing',
  skipped: 'no comparison ran: none was asked for, or nothing landed to compare',
};

/**
 * Says which question the field answers, and leaves the values to the legend:
 * an outcome read as a failed write sends a caller undoing a sound one.
 */
const VERIFIED_FIELD_DESCRIPTION =
  'How the sha256 check ended, not whether the data landed — written says that. ' +
  'Only "verified" means compared and matched; the legend names what the others were.';

export interface FileSummary {
  /** Where the data went on the server, after the tilde and the rules were applied */
  path: string;
  written: boolean;
  verified: VerifiedOutcome;
  /**
   * Why the outcome is what it is: what the check had nothing to work with,
   * or what the write failed on. `null` when there is nothing to explain.
   */
  reason: string | null;
  /** Size of what travelled; `null` — nobody counted it */
  bytes: number | null;
}

/** The answer of one call that wrote or transferred data */
export interface FilesSummary {
  files: FileSummary[];
  legend: Legend;
}

/**
 * The answer, legend included. Building it here is what keeps a batch of
 * twenty files from carrying twenty copies of the same sentence — and keeps
 * a single file from arriving without one.
 */
export function filesSummary(files: FileSummary[]): FilesSummary {
  return {
    files,
    legend: legendFor('files[].verified', VERIFIED_MEANING, files.map((file) => file.verified)),
  };
}

/** A file that landed, with the verification outcome as ssh_file_write words it */
export function writtenFile(
  path: string,
  verification: { status: VerifiedOutcome; reason?: string },
  bytes: number | null
): FileSummary {
  return {
    path,
    written: true,
    verified: verification.status,
    reason: verification.reason ?? null,
    bytes,
  };
}

/**
 * A file that travelled, with the verification outcome as the transfer words it.
 *
 * A transfer says it in two values instead of three: `verified: false` means
 * either "there was nothing to check with" — and then it carries the reason —
 * or "the caller asked for no check".
 */
export function transferredFile(
  path: string,
  transfer: { verified: boolean; verifyNote?: string },
  bytes: number | null
): FileSummary {
  if (transfer.verified) return { path, written: true, verified: 'verified', reason: null, bytes };

  return {
    path,
    written: true,
    verified: transfer.verifyNote ? 'unavailable' : 'skipped',
    reason: transfer.verifyNote ?? null,
    bytes,
  };
}

/** A file that never landed: the reason is the failure itself, not a missing check */
export function failedFile(path: string, reason: string): FileSummary {
  return { path, written: false, verified: 'skipped', reason, bytes: null };
}

export const FILES_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          written: { type: 'boolean' },
          verified: {
            type: 'string',
            enum: ['verified', 'unavailable', 'skipped'],
            description: VERIFIED_FIELD_DESCRIPTION,
          },
          reason: { type: ['string', 'null'] },
          bytes: { type: ['number', 'null'] },
        },
      },
    },
    legend: LEGEND_SCHEMA,
  },
};
