/**
 * Background job tools: check status, read output, list, kill.
 *
 * A job's state lives entirely on the server, so there is no memory here
 * between calls and no read cursor: the caller holds the position and sends
 * it back itself. That way answers are corrupted by neither our process
 * restarting nor a second client.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { READS_REMOTE, WRITES_REMOTE } from './annotations.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { exitCodeHint, withTruncationNote } from '../utils/output-notes.js';
import { requireText } from '../utils/tool-args.js';
import {
  JOB_TTL_SEC,
  buildKillCommand,
  buildListCommand,
  buildOutputCommand,
  buildStatusCommand,
  jobPaths,
  jobsRoot,
  parseJobKill,
  parseJobList,
  parseJobOutput,
  parseJobStatus,
  type JobState,
  type JobStatus,
} from '../utils/job-command.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/** Arguments shared by all ssh_job_* tools, matching their inputSchema */
interface JobArgs {
  profile?: string;
  id?: unknown;
  offset?: unknown;
  signal?: string;
}

/** What a job's outcome means. "Lost" means "nothing to check with", not a failure */
const STATE_NOTE: Record<JobState, string> = {
  running: 'still running',
  finished: 'finished',
  lost: 'not running and left no exit code — it was stopped by a signal or the server restarted, ' +
    'so how far it got is unknown',
  missing: 'no such job on the server (it may have been cleaned up)',
};

/** Start time for a human and a machine at once */
function startedLine(startedAt: number | undefined): string {
  if (startedAt === undefined) return 'Started: unknown';
  return `Started: ${new Date(startedAt * 1000).toISOString()} (unix ${startedAt})`;
}

/**
 * The response to stopping a job.
 *
 * Nothing to stop is an answer, not a refusal: the job could have finished on
 * its own between the status call and the kill. The outcomes are not merged:
 * the job does not exist at all, the job exists and already finished, the job
 * exists and never recorded a pid.
 */
function describeKill(
  id: string,
  which: string,
  killed: { killed: boolean; reason?: string }
): string {
  if (killed.killed) return `Job ${id}: ${which} sent to its process group.`;

  switch (killed.reason) {
    case 'missing':
      return `Job ${id}: ${STATE_NOTE.missing}`;
    case 'gone':
      return `Job ${id} is already gone — nothing to stop.`;
    case 'nopid':
      return `Job ${id} never recorded a pid — there is nothing to signal.`;
    default:
      return `Job ${id}: the server did not answer the stop request (${killed.reason ?? 'no reason given'}).`;
  }
}

export class JobTools {
  private executor: SSHExecutor;

  constructor() {
    this.executor = new SSHExecutor();
  }

  getTools(): Tool[] {
    const profile = {
      type: 'string',
      description: 'SSH profile name. Required: every profile is a different server, so none is assumed.',
    };
    const id = {
      type: 'string',
      description: 'Job id returned by ssh_exec with detach: true',
    };

    return [
      {
        name: 'ssh_job_status',
        annotations: { title: 'Check a background job', ...READS_REMOTE },
        description:
          'State of a background job started by ssh_exec with detach: true. ' +
          'Reports one of three outcomes: running, finished (with its exit code), or lost — ' +
          'not running and without an exit code, which means it was signalled or the server restarted.',
        inputSchema: {
          type: 'object',
          properties: { profile, id },
          required: ['id'],
        },
      },
      {
        name: 'ssh_job_output',
        annotations: { title: 'Read job output', ...READS_REMOTE },
        description:
          'Output of a background job (stdout and stderr together) starting at a byte offset. ' +
          'The answer names the offset to continue from, so repeated reads never overlap and never skip.',
        inputSchema: {
          type: 'object',
          properties: {
            profile,
            id,
            offset: {
              type: 'number',
              description: 'Byte offset to read from. Default: 0 (from the beginning)',
              default: 0,
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'ssh_job_list',
        annotations: { title: 'List background jobs', ...READS_REMOTE },
        description:
          'Background jobs on the server. Directories of jobs that are no longer running and ' +
          `older than ${JOB_TTL_SEC / 86400} days are removed along the way.`,
        inputSchema: {
          type: 'object',
          properties: { profile },
        },
      },
      {
        name: 'ssh_job_kill',
        annotations: { title: 'Stop a background job', ...WRITES_REMOTE },
        description:
          'Stop a background job: the signal goes to its whole process group, so its children ' +
          'stop too. A job that is already gone is reported, not refused.',
        inputSchema: {
          type: 'object',
          properties: {
            profile,
            id,
            signal: {
              type: 'string',
              enum: ['TERM', 'KILL'],
              description: 'Signal to send. Default: TERM',
              default: 'TERM',
            },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleCall(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const toolName = request.params.name;

    try {
      switch (toolName) {
        case 'ssh_job_status':
          return await this.handleStatus(request, signal);
        case 'ssh_job_output':
          return await this.handleOutput(request, signal);
        case 'ssh_job_list':
          return await this.handleList(request, signal);
        case 'ssh_job_kill':
          return await this.handleKill(request, signal);
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return toolFailure(error);
    }
  }

  /**
   * Profile config and job directory from its id.
   *
   * `jobPaths` validates the id's format: it travels into a path on the
   * server, and the check lives where the path is built, not in every tool.
   */
  private async locate(args: any): Promise<{ config: SSHConfig; id: string; dir: string }> {
    const config = resolveSSHConfig({ profile: args.profile });
    const id = requireText(args.id, 'id', '"mst0f2q1-9ab3c4d5"');
    const home = (await this.executor.passport(config)).home;

    return { config, id, dir: jobPaths(home, id).dir };
  }

  private async handleStatus(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const args = (request.params.arguments ?? {}) as JobArgs;
    const { config, id, dir } = await this.locate(args);

    const result = await this.executor.execute(config, buildStatusCommand(dir), {
      idempotent: true,
      signal,
    });

    return { content: [{ type: 'text', text: this.describeStatus(id, parseJobStatus(result.stdout)) }] };
  }

  /** Status response: the outcome on the first line, details below it */
  private describeStatus(id: string, status: JobStatus): string {
    const lines = [`Job ${id}: ${STATE_NOTE[status.state]}`];

    if (status.state === 'missing') return lines.join('\n');

    if (status.exitCode !== undefined) {
      lines.push(`Exit code: ${status.exitCode}${exitCodeHint(status.exitCode)}`);
    }
    if (status.pid !== undefined) lines.push(`Pid: ${status.pid}`);
    lines.push(startedLine(status.startedAt));
    lines.push(
      `Output: ${status.outputSize ?? 0} bytes` +
        (status.outputSize ? ' — read it with ssh_job_output' : '')
    );
    if (status.command) lines.push(`Command: ${status.command}`);

    return lines.join('\n');
  }

  private async handleOutput(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const args = (request.params.arguments ?? {}) as JobArgs;
    const { config, id, dir } = await this.locate(args);
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0) || 0));

    const result = await this.executor.execute(config, buildOutputCommand(dir, offset), {
      idempotent: true,
      signal,
    });

    const output = parseJobOutput(result.stdout);

    // No such job is an answer, not empty output: otherwise a silent job and
    // a made-up id would look the same
    if (output.missing) {
      return { content: [{ type: 'text', text: `Job ${id}: ${STATE_NOTE.missing}` }] };
    }

    const read = Buffer.byteLength(output.text, 'utf8');

    // The cursor advances by what was read, not by the file's size: a
    // response cut off by the buffer would otherwise skip over the middle of
    // the output and silently lose it
    const next = offset + read;
    const head =
      `Job ${id} output: ${output.size} bytes total, read ${read} from offset ${offset}.\n` +
      `Next offset: ${next}`;

    return {
      content: [
        {
          type: 'text',
          text: withTruncationNote(
            output.text ? `${head}\n\n${output.text}` : `${head}\n\n(no output at this offset)`,
            result.truncated
          ),
        },
      ],
    };
  }

  private async handleList(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const args = (request.params.arguments ?? {}) as JobArgs;
    const config = resolveSSHConfig({ profile: args.profile });
    const root = jobsRoot((await this.executor.passport(config)).home);

    const result = await this.executor.execute(config, buildListCommand(root), {
      idempotent: true,
      signal,
    });

    const listing = parseJobList(result.stdout);
    const lines: string[] = [];

    if (listing.jobs.length === 0) {
      lines.push('No background jobs on the server.');
    } else {
      lines.push(`${listing.jobs.length} background job(s):`);
      for (const job of listing.jobs) {
        const code = job.exitCode !== undefined ? `, exit ${job.exitCode}` : '';
        lines.push(
          `  ${job.id}  ${job.state}${code}  ${startedLine(job.startedAt).replace('Started: ', '')}` +
            `, ${job.outputSize ?? 0} bytes`
        );
      }
    }

    if (listing.removed.length > 0) {
      lines.push(
        '',
        `Removed ${listing.removed.length} finished job(s) older than ${JOB_TTL_SEC / 86400} days: ` +
          listing.removed.join(', ')
      );
    }

    return { content: [{ type: 'text', text: withTruncationNote(lines.join('\n'), result.truncated) }] };
  }

  private async handleKill(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const args = (request.params.arguments ?? {}) as JobArgs;
    const { config, id, dir } = await this.locate(args);
    const which = args.signal === 'KILL' ? 'KILL' : 'TERM';

    const result = await this.executor.execute(config, buildKillCommand(dir, which), { signal });

    return {
      content: [{ type: 'text', text: describeKill(id, which, parseJobKill(result.stdout)) }],
    };
  }
}
