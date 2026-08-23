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
import { legendFor, LEGEND_SCHEMA, meaningsList, type Legend } from './legend.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

/** What each state says about the job */
const STATE_MEANING: Record<JobState, string> = {
  running: 'started and still running: this is not the outcome, come back later',
  finished: 'the job ended and reported its exit code',
  lost: 'the job is gone and left no exit code behind',
  missing: 'the server knows no job under this id',
};

export interface JobEntry {
  id: string;
  state: JobState;
  /** Only a finished job reports one; `null` everywhere else */
  exit_code: number | null;
  pid: number | null;
  /** Start time in seconds since the epoch; `null` when the server did not record it */
  started_at: number | null;
  /**
   * The last lines the job wrote, when they were asked for. A status call
   * carries them; a listing of thirty jobs does not, and leaves the field out.
   */
  output_tail?: string[];
}

/** The answer of one call about jobs */
export interface JobsSummary {
  jobs: JobEntry[];
  legend: Legend;
}

/** Said where the window is shown, so the tail is not mistaken for the whole output */
const TAIL_NOTE = 'the last lines written so far, cut to fit; the whole output is in ssh_job_output';

/**
 * The answer, legend included: a list of thirty jobs in four states costs
 * four explanations, and the caller cannot end up with a state nobody named.
 */
export function jobsSummary(jobs: JobEntry[]): JobsSummary {
  const legend = legendFor('jobs[].state', STATE_MEANING, jobs.map((job) => job.state));
  if (jobs.some((job) => job.output_tail !== undefined)) legend['jobs[].output_tail'] = TAIL_NOTE;

  return { jobs, legend };
}

/** One job, as its own status line words it */
export function jobEntry(
  id: string,
  job: { state: JobState; exitCode?: number; pid?: number; startedAt?: number; outputTail?: string[] }
): JobEntry {
  return {
    id,
    state: job.state,
    exit_code: job.exitCode ?? null,
    pid: job.pid ?? null,
    started_at: job.startedAt ?? null,
    ...(job.outputTail === undefined ? {} : { output_tail: job.outputTail }),
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
          state: {
            type: 'string',
            enum: ['running', 'finished', 'lost', 'missing'],
            description: meaningsList(STATE_MEANING),
          },
          exit_code: { type: ['number', 'null'] },
          pid: { type: ['number', 'null'] },
          started_at: {
            type: ['number', 'null'],
            description: 'Seconds since the epoch; null — the server did not record it.',
          },
          output_tail: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    legend: LEGEND_SCHEMA,
  },
};

/**
 * Shape of the ssh_job_kill answer.
 *
 * Five outcomes lead to five different next steps, and the text tells them
 * apart by wording alone. `no-answer` is the one that must not be read as
 * success: the server said nothing, so whether the job still runs is unknown.
 */
export type KillOutcome = 'signalled' | 'gone' | 'nopid' | 'missing' | 'no-answer';

/** What each outcome says about the job that was asked to stop */
const KILL_MEANING: Record<KillOutcome, string> = {
  signalled: 'the signal reached the process group of the job',
  gone: 'the job had already ended, so there was nothing to stop',
  nopid: 'the job recorded no pid, so there was nothing to signal',
  missing: 'the server knows no job under this id',
  'no-answer': 'the server did not answer the stop request, so the job state is unknown',
};

export interface KillSummary {
  id: string;
  outcome: KillOutcome;
  /** The signal that was sent, after the requested one was checked against the allowed pair */
  signal: 'TERM' | 'KILL';
  /** What the server said when nothing was signalled; `null` after a sent signal */
  reason: string | null;
  legend: Legend;
}

/** The outcome of one stop request, as the kill answer words it */
export function killSummary(
  id: string,
  signal: 'TERM' | 'KILL',
  killed: { killed: boolean; reason?: string }
): KillSummary {
  const outcome = outcomeOf(killed);

  return {
    id,
    outcome,
    signal,
    reason: killed.killed ? null : (killed.reason ?? null),
    legend: legendFor('outcome', KILL_MEANING, [outcome]),
  };
}

/** A reason the server never named is still an answer nobody can act on */
function outcomeOf(killed: { killed: boolean; reason?: string }): KillOutcome {
  if (killed.killed) return 'signalled';

  switch (killed.reason) {
    case 'gone':
      return 'gone';
    case 'nopid':
      return 'nopid';
    case 'missing':
      return 'missing';
    default:
      return 'no-answer';
  }
}

export const KILL_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    outcome: {
      type: 'string',
      enum: ['signalled', 'gone', 'nopid', 'missing', 'no-answer'],
      description: meaningsList(KILL_MEANING),
    },
    signal: {
      type: 'string',
      enum: ['TERM', 'KILL'],
      description: 'What was actually sent, which is not always what was asked for.',
    },
    reason: { type: ['string', 'null'] },
    legend: LEGEND_SCHEMA,
  },
};
