/**
 * Shape of the ssh_exec summary: what became of every command that was sent.
 *
 * The summary travels beside the text, never instead of it, and carries only
 * facts about the output — the code, the truncation, the reason a command
 * never ran. The output itself stays in the text: in the summary it would
 * reach the agent twice.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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
}

/** The answer of one ssh_exec call */
export interface ExecSummary {
  commands: CommandSummary[];
  /** Job started by detach; `null` when the call waited for the answer itself */
  job_id: string | null;
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

/** A command that ran and reported back */
export function executedCommand(
  command: string,
  result: { exitCode: number; truncated: boolean },
  warning: string | null
): CommandSummary {
  return {
    ...blank(command, warning),
    exit_code: result.exitCode,
    truncated: result.truncated,
    timed_out: killedByTimeoutGuard(result.exitCode),
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
  },
  required: [
    'command',
    'exit_code',
    'truncated',
    'timed_out',
    'blocked',
    'blocked_reason',
    'not_run',
    'warning',
  ],
};

export const EXEC_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    commands: { type: 'array', items: COMMAND_SUMMARY },
    job_id: { type: ['string', 'null'] },
  },
  required: ['commands', 'job_id'],
};
