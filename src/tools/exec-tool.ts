/**
 * SSH Exec Tool
 * Universal tool for executing SSH commands
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { RUNS_COMMANDS } from './annotations.js';
import { PROFILE_PARAM_DESCRIPTION } from './params.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { DEFAULT_TIMEOUT_MS, SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { requireTextList } from '../utils/tool-args.js';
import {
  exitCodeHint,
  sudoAskedForAPassword,
  SUDO_HAS_NOTHING_TO_ANSWER_WITH,
  TRUNCATED_OUTPUT_NOTE,
  withTruncationNote,
} from '../utils/output-notes.js';
import {
  blockedCommand,
  EXEC_OUTPUT_SCHEMA,
  execSummary,
  executedCommand,
  notRunCommand,
  startedCommand,
  stoppedCommand,
  type CommandSummary,
  type ExecSummary,
} from './exec-output.js';
import { SSHTimeoutError } from '../runner/errors.js';
import {
  blockedMessage,
  findRemovalTargets,
  inspectCommand,
} from '../utils/destructive-command.js';
import { DB_CLIENTS, inspectIrreversible } from '../utils/irreversible-command.js';
import { parseInvocations, unquote } from '../utils/command-parse.js';
import { resolveRemovalTargets } from '../managers/removal-guard.js';
import { buildStartCommand, createJobId, jobPaths, parseJobStart } from '../utils/job-command.js';
import { shellQuote } from '../utils/shell-arg.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/** Output of one command, as the batch answer prints it */
interface CommandRun {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

/** ssh_exec arguments, matching its inputSchema */
interface ExecArgs {
  profile?: string;
  command?: unknown;
  sudo?: boolean;
  cwd?: string;
  timeout?: number;
  detach?: boolean;
  interactive?: boolean;
}

/*
 * A warning speaks about what the command does, not about which words appear
 * in it: a pattern like `rm -rf /` would fire on any absolute path and print
 * "rm -rf / detected" even for `echo "rm -rf /"`. A warning that shouts on
 * routine cleanup is a warning the agent stops reading — and a genuine root
 * wipe gets lost in that noise. The real check lives in destructive-command.ts:
 * it looks at where the path actually leads and blocks the command there.
 */

/** Queries that alter data all at once; wiping a whole database goes to refusal, not here */
const SQL_PATTERNS = [
  { pattern: /\bDROP\s+TABLE\b/i, message: 'DROP TABLE detected' },
  { pattern: /\bTRUNCATE\b/i, message: 'TRUNCATE detected' },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*;/i, message: 'DELETE without WHERE detected' },
];

/**
 * A warning about what the command is about to do.
 *
 * The name is looked for in command position: `chmod` as the first word is a
 * call, `chmod` inside a path or a string is a mention, and we stay silent about that.
 */
function checkDangerousCommand(command: string): string | null {
  const invocations = parseInvocations(command);

  for (const { name, args } of invocations) {
    if (name === 'chmod' && args.some((argument) => unquote(argument) === '777'))
      return 'chmod 777 detected (security risk)';

    // Wiping every container at once: the containers themselves get
    // recreated, so this is a warning, not a refusal — data volumes outlive them
    if (
      name === 'docker' &&
      args[0] === 'rm' &&
      args.includes('-f') &&
      /\$\(docker\s+ps/.test(args.join(' '))
    )
      return 'docker rm all containers detected';
  }

  // The query is searched for across the whole command, but only if a DB
  // client is invoked in it: this catches both `-c "…"` and text on stdin,
  // while a conversation that merely mentions a query stays unflagged
  if (invocations.some(({ name }) => DB_CLIENTS.includes(name))) {
    for (const { pattern, message } of SQL_PATTERNS)
      if (pattern.test(command)) return message;
  }

  return null;
}

/** The warning as the text shows it: the verdict, and the command it speaks about */
function warningBlock(command: string, message: string): string {
  return `⚠️  DANGEROUS COMMAND: ${message}\nCommand: ${command.substring(0, 100)}`;
}

/**
 * `sudo` asks a terminal for the password on a profile that logs in by key,
 * and a background job has no terminal to answer from. The server's own words
 * name the mechanism rather than the way out, so the refusal is said here.
 */
function noPasswordForSudo(error: Error): boolean {
  return sudoAskedForAPassword(error.message);
}

const JOB_NOT_STARTED_WITHOUT_SUDO_PASSWORD =
  `The job was not started: ${SUDO_HAS_NOTHING_TO_ANSWER_WITH}`;

/**
 * The same answer for a command that ran and got stopped by sudo.
 *
 * Sudo's own stderr stays where it is — it is what the server said. What it
 * advises («use the -S option») is out of reach from a tool call, so the note
 * says what is in reach instead.
 */
function sudoPasswordNote(config: SSHConfig, sudo: boolean | undefined, stderr: string): string {
  if (!sudo || config.sudoPassword || config.password) return '';
  return sudoAskedForAPassword(stderr) ? `\n\n${SUDO_HAS_NOTHING_TO_ANSWER_WITH}` : '';
}

/**
 * What a background job cannot do. The refusal happens before anything is sent.
 *
 * Each case is not strictness for its own sake but a place where detach would
 * silently behave differently from what the caller expects.
 */
function assertDetachable(args: { sudo?: boolean; interactive?: boolean }, commands: string[]): void {
  if (args.interactive) {
    throw new Error(
      'detach cannot be combined with interactive: a background job has no terminal to answer from.'
    );
  }

  if (commands.length > 1) {
    throw new Error(
      `detach starts a single job, got an array of ${commands.length} commands. ` +
        'Start them one at a time, or join them into one command.'
    );
  }
}

/**
 * SSH Exec Tool
 */
export class ExecTool {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool description for MCP
   */
  getTool(): Tool {
    return {
      name: 'ssh_exec',
      annotations: { title: 'Run commands', ...RUNS_COMMANDS },
      description:
        'Runs one command or a list of them on a server, each with its own exit code, stdout and stderr. ' +
        'Work measured in minutes belongs in detach, not in a longer timeout. ' +
        'Reach for it last — files, logs, transfers, health and jobs each have a tool that batches the ' +
        'round trips and parses the answer.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: PROFILE_PARAM_DESCRIPTION,
          },
          command: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description:
              'One command, or a list: ["hostname", "whoami"]. Each runs in its own shell — no shared variable, no shared cd; cwd applies to all. A non-zero exit does not stop the list.',
          },
          sudo: {
            type: 'boolean',
            description: 'Execute command(s) with sudo. Default: false',
            default: false,
          },
          cwd: {
            type: 'string',
            description:
              'Directory to start in, detached jobs included. Cannot be entered -> the command stops, it does not run elsewhere.',
          },
          timeout: {
            type: 'number',
            description:
              `Milliseconds, per command in a list, not for the whole list; default ${DEFAULT_TIMEOUT_MS}. ` +
              'Work measured in minutes -> detach, not a bigger number.',
            default: DEFAULT_TIMEOUT_MS,
          },
          detach: {
            type: 'boolean',
            description:
              'Background job on the server: returns an id at once, outlives this call, timeout does not apply. ' +
              'Follow with ssh_job_status / ssh_job_output, stop with ssh_job_kill. One command. With sudo the job ' +
              'runs as root and every later call follows it as root, provided the profile has a password or sudo ' +
              'needs none. Default: false',
            default: false,
          },
        },
        required: ['profile', 'command'],
      },
      outputSchema: EXEC_OUTPUT_SCHEMA,
    };
  }
  
  /**
   * Handle tool call
   */
  async handleCall(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const args = (request.params.arguments ?? {}) as ExecArgs;

      // Validate array parameter format
      const validation = validateArrayParameter(args.command, 'command');
      if (!validation.isValid) {
        return createValidationErrorResponse(validation.errorMessage!);
      }
      
      // Resolve SSH config and profile name
      const sshConfig = resolveSSHConfig({ profile: args.profile });
      
      // The shape is validated before the first command: without this, a
      // missing or non-string `command` would reach the executor and fail
      // with an internal `finalCommand.substring is not a function` — text
      // that gives the caller no clue their input shape was wrong.
      const commands = requireTextList(args.command, 'command', '"uptime"');

      // What a background job cannot handle is settled without the network
      // and before the guard: these refusals depend on neither the server nor the command text
      const detach = args.detach === true;
      if (detach) assertDetachable(args, commands);

      // A warning is settled by the text alone, so it is collected before the
      // guard goes to the server: the summary of a refused call names the
      // warning next to the command it speaks about
      const warnings = commands.map((command) => checkDangerousCommand(command));
      const warningText = commands
        .map((command, index) => {
          const message = warnings[index];
          return message === null ? '' : warningBlock(command, message);
        })
        .filter((block) => block !== '')
        .join('\n\n');

      // Deleting the root, the home directory or a system tree is stopped
      // BEFORE the first command is sent — and the whole call is stopped with
      // it. Checking along the way is not an option: half the batch would
      // have already run, and the server's state would become unknown.
      const refusal = await this.refuseDestructive(commands, sshConfig, args.sudo);
      if (refusal) {
        // The refusal is flagged the same way as any other: whoever reads the
        // flag rather than the text would otherwise take a blocked wipe for a
        // completed one. The summary names the refused command and says that
        // none of the others ran either — not even those standing before it
        const summary: ExecSummary = execSummary(
          commands.map((command, index) =>
            index === refusal.index
              ? blockedCommand(command, refusal.reason, warnings[index])
              : notRunCommand(command, warnings[index])
          ),
          null
        );

        return {
          content: [{ type: 'text', text: blockedMessage(commands[refusal.index], refusal.reason) }],
          isError: true,
          structuredContent: summary,
        };
      }

      // Starting the job happens after the deletion guard: a root wipe cancels
      // the whole call, and there is no reason to set up a job directory for it
      if (detach) {
        return await this.startJob(
          sshConfig,
          commands[0],
          args.cwd,
          { message: warnings[0], text: warningText },
          Boolean(args.sudo)
        );
      }

      const runs: CommandRun[] = [];

      for (const command of commands) {
        try {
          const result = await this.executor.execute(sshConfig, command, {
            sudo: args.sudo || false,
            cwd: args.cwd,
            // Zero here means "no deadline was named": the layer below will supply the shared default
            timeout: args.timeout || undefined,
            signal,
          });

          runs.push({ command, ...result });
        } catch (error) {
          // What already ran does not vanish with the failure: the server's
          // state has changed, and the answer has to say how far the call got
          return this.interruptedAnswer(error, commands, warnings, runs);
        }
      }

      const summary: ExecSummary = execSummary(
        runs.map((run, index) => executedCommand(run.command, run, warnings[index])),
        null
      );

      // Single command - return simple result
      if (runs.length === 1) {
        const run = runs[0];
        let output = '';

        // Add warnings
        if (warningText) {
          output += warningText + '\n\n';
        }

        // Add stdout
        if (run.stdout) {
          output += run.stdout;
        }

        // Add stderr if present
        if (run.stderr) {
          output += `\n\nSTDERR:\n${run.stderr}`;
        }

        // Add exit code if not 0
        if (run.exitCode !== 0) {
          output += `\n\nExit code: ${run.exitCode}${exitCodeHint(run.exitCode)}`;
        }

        output += sudoPasswordNote(sshConfig, args.sudo, run.stderr);

        return {
          content: [
            {
              type: 'text',
              text: withTruncationNote(
                output || '(command executed successfully, no output)',
                run.truncated
              ),
            },
          ],
          structuredContent: summary,
        };
      }

      // Format output
      let output = '';

      // Add warnings
      if (warningText) {
        output += warningText + '\n\n';
        output += '═'.repeat(60) + '\n\n';
      }

      output += `Executed ${runs.length} commands:\n\n`;

      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        output += `[${ i + 1}/${runs.length}] ${run.command}\n`;
        output += '─'.repeat(60) + '\n';

        if (run.stdout) {
          output += run.stdout + '\n';
        }

        if (run.stderr) {
          output += `STDERR: ${run.stderr}\n`;
        }

        output += `Exit code: ${run.exitCode}${exitCodeHint(run.exitCode)}\n`;

        const sudoNote = sudoPasswordNote(sshConfig, args.sudo, run.stderr);
        if (sudoNote) output += `${sudoNote.trim()}\n`;

        if (run.truncated) {
          output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        }

        output += '\n';
      }

      return {
        content: [{ type: 'text', text: output }],
        structuredContent: summary,
      };
    } catch (error: any) {
      logger.error('ssh_exec failed:', error);
      // Pointing at ssh_exec inside an ssh_exec answer sends the caller in a circle
      return toolFailure(error, undefined, { hint: false });
    }
  }

  /**
   * The answer to a call that ended before every command reported back.
   *
   * A timeout leaves the command alive on the server — we stopped waiting, it
   * did not stop; a cancelled call and a dropped connection end the same way.
   * Whatever stood after it was never sent.
   */
  private interruptedAnswer(
    error: unknown,
    commands: string[],
    warnings: Array<string | null>,
    runs: CommandRun[]
  ): ToolResult {
    logger.error('ssh_exec failed:', error);
    const cause = error instanceof SSHTimeoutError ? 'timeout' : 'interrupted';

    const summarize = (command: string, index: number): CommandSummary => {
      if (index < runs.length) return executedCommand(command, runs[index], warnings[index]);
      if (index === runs.length) return stoppedCommand(command, warnings[index], cause);
      return notRunCommand(command, warnings[index]);
    };

    return {
      ...toolFailure(error, undefined, { hint: false }),
      structuredContent: execSummary(commands.map(summarize), null) satisfies ExecSummary,
    };
  }

  /**
   * Start the command as a background job and answer right away.
   *
   * The job's state stays on the server's disk, so the response carries only
   * an id: everything else is asked for with the `ssh_job_*` tools, including
   * after our process restarts.
   */
  private async startJob(
    config: SSHConfig,
    command: string,
    cwd: string | undefined,
    warning: { message: string | null; text: string },
    sudo = false
  ): Promise<ToolResult> {
    const passport = await this.executor.passport(config);
    const id = createJobId(sudo);
    const { root, dir } = jobPaths(passport.home, id);

    // The working directory goes inside the job command: applied to the
    // launch itself, it would change the directory of the job's own service
    // files, while the command would stay wherever it was
    const jobCommand = cwd ? `cd ${shellQuote(cwd)} || exit 1; ${command}` : command;

    // The shared root is created by the login user even when the job itself
    // runs as root. Left to the elevated launch, the root would belong to
    // root, and every ordinary job afterwards would fail to create its own
    // directory inside it.
    if (sudo) {
      await this.executor.executeChecked(config, `mkdir -p ${shellQuote(root)}`, {
        idempotent: true,
      });
    }

    // The call's cancellation is deliberately not passed in here: an abort
    // between starting the job and answering would leave it running without
    // an id — that is, with no way to stop it
    const started = await this.executor
      .executeChecked(config, buildStartCommand(dir, jobCommand, passport.setsid), { sudo })
      .catch((error: Error) => {
        throw noPasswordForSudo(error) ? new Error(JOB_NOT_STARTED_WITHOUT_SUDO_PASSWORD) : error;
      });

    const pid = parseJobStart(started.stdout);
    const head = warning.text ? `${warning.text}\n\n` : '';

    return {
      content: [
        {
          type: 'text',
          text:
            `${head}Job ${id} started` +
            (pid ? ` (pid ${pid}).` : ' (the server did not report a pid).') +
            `\nCommand: ${jobCommand}` +
            '\nFollow it with ssh_job_status and ssh_job_output, stop it with ssh_job_kill.',
        },
      ],
      structuredContent: execSummary(
        [startedCommand(jobCommand, warning.message)],
        id
      ) satisfies ExecSummary,
    };
  }

  /**
   * A refusal if even one command in the call would destroy data for good.
   *
   * Parsing the text settles almost everything at once and without the
   * network; one request goes to the server, and only for what the text
   * cannot show — where a symlink leads. Returns which command was refused
   * and why, or null if it is safe to proceed.
   */
  private async refuseDestructive(
    commands: string[],
    config: SSHConfig,
    sudo?: boolean
  ): Promise<{ index: number; reason: string } | null> {
    // The passport is only needed for the home directory, and that is only
    // needed where a deletion appears at all. An ordinary command should not
    // pay for a check that does not concern it — so the home directory is fetched lazily.
    let home: string | null = null;

    for (const [index, command] of commands.entries()) {
      // Text-based parsing runs first: it does not concern paths, so an
      // earlier branch keyed on deletion targets would let it slip past along with the command
      const irreversible = inspectIrreversible(command);
      if (irreversible.blocked) {
        return { index, reason: irreversible.reason! };
      }

      if (findRemovalTargets(command).length === 0) continue;
      if (home === null) home = (await this.executor.passport(config)).home;

      const verdict = inspectCommand(command, home);
      if (verdict.blocked) {
        return { index, reason: verdict.reason! };
      }

      if (verdict.needsResolution.length > 0) {
        const resolution = await resolveRemovalTargets(
          this.executor,
          config,
          verdict.needsResolution,
          { sudo }
        );
        if (resolution.blocked) {
          return { index, reason: resolution.reason! };
        }
      }
    }

    return null;
  }
}
