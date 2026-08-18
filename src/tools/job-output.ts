/**
 * Shape of the summary for background jobs: ssh_job_status and ssh_job_list.
 *
 * The four outcomes differ in what the caller does next, and in the text they
 * differ only by wording: `lost` means the job is gone and left no code,
 * `missing` means the server has no such job at all. A field says which is
 * which without reading the sentence.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JobState } from '../utils/job-command.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

export interface JobEntry {
  id: string;
  state: JobState;
  /** Only a finished job reports one; `null` everywhere else */
  exit_code: number | null;
  pid: number | null;
  /** Start time in seconds since the epoch; `null` when the server did not record it */
  started_at: number | null;
}

/** The answer of one call about jobs */
export interface JobsSummary {
  jobs: JobEntry[];
}

/** One job, as its own status line words it */
export function jobEntry(
  id: string,
  job: { state: JobState; exitCode?: number; pid?: number; startedAt?: number }
): JobEntry {
  return {
    id,
    state: job.state,
    exit_code: job.exitCode ?? null,
    pid: job.pid ?? null,
    started_at: job.startedAt ?? null,
  };
}

export const JOBS_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['running', 'finished', 'lost', 'missing'] },
          exit_code: { type: ['number', 'null'] },
          pid: { type: ['number', 'null'] },
          started_at: { type: ['number', 'null'] },
        },
        required: ['id', 'state', 'exit_code', 'pid', 'started_at'],
      },
    },
  },
  required: ['jobs'],
};
