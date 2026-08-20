/**
 * Shape of the ssh_exec summary: what became of every command that was sent,
 * and what it printed.
 *
 * The summary travels beside the text, and the output rides in it rather than
 * only in the text: a client that declares a schema shows the caller the
 * fields alone, so output left in the text reaches nobody.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { clipForField } from '../utils/clip-output.js';
import { LEGEND_SCHEMA, type Legend } from './legend.js';
import { killedByTimeoutGuard } from '../utils/output-notes.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

/**
 * What became of one command.
 *
 * `exit_code` is the whole answer to "did it run": a number means the command
 * reported back, `null` means it did not. The flags only say why — otherwise
 * a blocked command would have to choose between `not_run: false`, which
 * reads as "it ran", and stretching "we never got to it" over a case that has
 * a name of its own.
 */
export interface CommandSummary {
  command: string;
  exit_code: number | null;
  truncated: boolean;
  /** Stopped by a timeout guard: the server's one reports a code, ours leaves `exit_code` null */
  timed_out: boolean;
  blocked: boolean;
  /** What the removal guard objected to; `null` when it did not object */
  blocked_reason: string | null;
  not_run: boolean;
  /** Warning about what this command does, tied to the command it speaks about */
  warning: string | null;
  /**
   * What the command printed. Only a command that ran carries these: an empty
   * string means it ran and said nothing, while a command that never ran has
   * no field at all — otherwise the two would read the same.
   */
  stdout?: string;
  stderr?: string;
  /** Bytes cut out of the middle to fit; `0` — both streams arrived whole */
  clipped_bytes?: number;
}

/** The answer of one ssh_exec call */
export interface ExecSummary {
  commands: CommandSummary[];
  /** Job started by detach; `null` when the call waited for the answer itself */
  job_id: string | null;
  legend: Legend;
}

/** Said where output was cut, so the two halves are not read as one run */
const CLIPPED_NOTE =
  'the middle of the output was cut to fit the field; the seam names the amount, ' +
  'and a rerun with a filter brings back what is missing';

/** The answer, with an explanation only for what this one actually did */
export function execSummary(commands: CommandSummary[], jobId: string | null): ExecSummary {
  const legend: Legend = {};
  if (commands.some((entry) => (entry.clipped_bytes ?? 0) > 0)) {
    legend['commands[].clipped_bytes'] = CLIPPED_NOTE;
  }

  return { commands, job_id: jobId, legend };
}

/** A command nothing is known about yet: every field says "no fact here" */
function blank(command: string, warning: string | null): CommandSummary {
  return {
    command,
    exit_code: null,
    truncated: false,
    timed_out: false,
    blocked: false,
    blocked_reason: null,
    not_run: false,
    warning,
  };
}

/**
 * A command that ran and reported back, output included.
 *
 * Output cut by the transport buffer keeps only its head: there the end of
 * what arrived is not the end of what the command printed, and a tail would
 * pass the buffer's edge off as the command's own last word.
 */
export function executedCommand(
  command: string,
  result: { exitCode: number; truncated: boolean; stdout?: string; stderr?: string },
  warning: string | null
): CommandSummary {
  const keepTail = !result.truncated;
  const stdout = clipForField(result.stdout ?? '', { keepTail });
  const stderr = clipForField(result.stderr ?? '', { keepTail });

  return {
    ...blank(command, warning),
    exit_code: result.exitCode,
    truncated: result.truncated,
    timed_out: killedByTimeoutGuard(result.exitCode),
    stdout: stdout.text,
    stderr: stderr.text,
    clipped_bytes: stdout.clippedBytes + stderr.clippedBytes,
  };
}

/**
 * A command that started and never reported back.
 *
 * On `timeout` it may still be running on the server: we stopped waiting, the
 * command did not stop. On `interrupted` the call itself ended — cancelled by
 * the caller, or the connection dropped.
 */
export function stoppedCommand(
  command: string,
  warning: string | null,
  cause: 'timeout' | 'interrupted'
): CommandSummary {
  return { ...blank(command, warning), timed_out: cause === 'timeout' };
}

/** A command running in the background: it was started, and there is no code yet */
export function startedCommand(command: string, warning: string | null): CommandSummary {
  return blank(command, warning);
}

/** A command the removal guard refused; the whole call stops with it */
export function blockedCommand(
  command: string,
  reason: string,
  warning: string | null
): CommandSummary {
  return { ...blank(command, warning), blocked: true, blocked_reason: reason };
}

/** A command that was never sent: the call ended before it */
export function notRunCommand(command: string, warning: string | null): CommandSummary {
  return { ...blank(command, warning), not_run: true };
}

const COMMAND_SUMMARY = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    exit_code: { type: ['number', 'null'] },
    truncated: { type: 'boolean' },
    timed_out: { type: 'boolean' },
    blocked: { type: 'boolean' },
    blocked_reason: { type: ['string', 'null'] },
    not_run: { type: 'boolean' },
    warning: { type: ['string', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    clipped_bytes: { type: 'number' },
  },
};

export const EXEC_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    commands: { type: 'array', items: COMMAND_SUMMARY },
    job_id: { type: ['string', 'null'] },
    legend: LEGEND_SCHEMA,
  },
};
