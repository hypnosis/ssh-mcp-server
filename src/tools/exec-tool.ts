/**
 * SSH Exec Tool
 * Universal tool for executing SSH commands
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { DEFAULT_TIMEOUT_MS, SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { requireTextList } from '../utils/tool-args.js';
import { exitCodeHint, TRUNCATED_OUTPUT_NOTE, withTruncationNote } from '../utils/output-notes.js';
import {
  blockedMessage,
  CONFIRMATION_MARKER,
  findRemovalTargets,
  inspectCommand,
} from '../utils/destructive-command.js';
import { DB_CLIENTS, inspectIrreversible } from '../utils/irreversible-command.js';
import { parseInvocations, unquote } from '../utils/command-parse.js';
import { resolveRemovalTargets } from '../managers/removal-guard.js';
import { buildStartCommand, createJobId, jobPaths, parseJobStart } from '../utils/job-command.js';
import { shellQuote } from '../utils/shell-arg.js';
import type { SSHConfig } from '../utils/ssh-config.js';

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
  const warning = (message: string) => `⚠️  DANGEROUS COMMAND: ${message}`;
  const invocations = parseInvocations(command);

  for (const { name, args } of invocations) {
    if (name === 'chmod' && args.some((argument) => unquote(argument) === '777'))
      return warning('chmod 777 detected (security risk)');

    // Wiping every container at once: the containers themselves get
    // recreated, so this is a warning, not a refusal — data volumes outlive them
    if (
      name === 'docker' &&
      args[0] === 'rm' &&
      args.includes('-f') &&
      /\$\(docker\s+ps/.test(args.join(' '))
    )
      return warning('docker rm all containers detected');
  }

  // The query is searched for across the whole command, but only if a DB
  // client is invoked in it: this catches both `-c "…"` and text on stdin,
  // while a conversation that merely mentions a query stays unflagged
  if (invocations.some(({ name }) => DB_CLIENTS.includes(name))) {
    for (const { pattern, message } of SQL_PATTERNS)
      if (pattern.test(command)) return warning(message);
  }

  return null;
}

/**
 * What a background job cannot do. The refusal happens before anything is sent.
 *
 * Each case is not strictness for its own sake but a place where detach would
 * silently behave differently from what the caller expects.
 */
function assertDetachable(args: { sudo?: boolean; interactive?: boolean }, commands: string[]): void {
  if (args.sudo) {
    throw new Error(
      'detach cannot be combined with sudo: a background job has nowhere to take a password from. ' +
        'Run the command without sudo, or run it without detach and wait for it.'
    );
  }

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
      description:
        'Execute command(s) on remote server via SSH. Supports single command or batch execution. ' +
        'SAFETY: a recursive delete is refused before anything runs when its target is the filesystem root, ' +
        'the home directory or a system tree (/etc, /usr, /var, /home, …) — including a path that only reaches ' +
        'one of them through a symlink, and including a target the server expands itself (variable, substitution, ' +
        `glob), which cannot be checked in advance. To run such a command deliberately, append "${CONFIRMATION_MARKER}" ` +
        'to that specific command; other commands in the same batch are unaffected.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: 'SSH profile name from SSH_PROFILES_FILE. If not specified, uses default profile.',
          },
          command: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Single command string or array of commands to execute. For arrays, use JSON format with double quotes: ["cmd1", "cmd2"]. Examples: command: "hostname" (single) or command: ["hostname", "whoami", "date"] (batch)',
          },
          sudo: {
            type: 'boolean',
            description: 'Execute command(s) with sudo. Default: false',
            default: false,
          },
          cwd: {
            type: 'string',
            description: 'Working directory for command execution',
          },
          timeout: {
            type: 'number',
            description:
              `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} ` +
              `(${DEFAULT_TIMEOUT_MS / 1000} seconds)`,
            default: DEFAULT_TIMEOUT_MS,
          },
          detach: {
            type: 'boolean',
            description:
              'Start the command as a background job on the server and return its id right away, ' +
              'instead of waiting for it. The job outlives this call and the timeout above does not ' +
              'apply to it; follow it with ssh_job_status / ssh_job_output and stop it with ssh_job_kill. ' +
              'Takes a single command and cannot be combined with sudo. Default: false',
            default: false,
          },
        },
        required: ['command'],
      },
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

      // Deleting the root, the home directory or a system tree is stopped
      // BEFORE the first command is sent — and the whole call is stopped with
      // it. Checking along the way is not an option: half the batch would
      // have already run, and the server's state would become unknown.
      const refusal = await this.refuseDestructive(commands, sshConfig, args.sudo);
      if (refusal) {
        // The refusal is flagged the same way as any other: whoever reads the
        // flag rather than the text would otherwise take a blocked wipe for a completed one
        return { content: [{ type: 'text', text: refusal }], isError: true };
      }

      // Check for dangerous commands
      const warnings: string[] = [];
      for (const cmd of commands) {
        const warning = checkDangerousCommand(cmd);
        if (warning) {
          warnings.push(`${warning}\nCommand: ${cmd.substring(0, 100)}`);
        }
      }

      // Starting the job happens after the deletion guard: a root wipe cancels
      // the whole call, and there is no reason to set up a job directory for it
      if (detach) {
        return await this.startJob(sshConfig, commands[0], args.cwd, warnings);
      }

      // Single command - return simple result
      if (commands.length === 1) {
        const result = await this.executor.execute(sshConfig, commands[0], {
          sudo: args.sudo || false,
          cwd: args.cwd,
          // Zero here means "no deadline was named": the layer below will supply the shared default
          timeout: args.timeout || undefined,
          signal,
        });
        
        let output = '';
        
        // Add warnings
        if (warnings.length > 0) {
          output += warnings.join('\n\n') + '\n\n';
        }
        
        // Add stdout
        if (result.stdout) {
          output += result.stdout;
        }
        
        // Add stderr if present
        if (result.stderr) {
          output += `\n\nSTDERR:\n${result.stderr}`;
        }
        
        // Add exit code if not 0
        if (result.exitCode !== 0) {
          output += `\n\nExit code: ${result.exitCode}${exitCodeHint(result.exitCode)}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: withTruncationNote(
                output || '(command executed successfully, no output)',
                result.truncated
              ),
            },
          ],
        };
      }
      
      // Multiple commands - return structured result
      const results: Array<{
        command: string;
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated: boolean;
      }> = [];
      
      for (const cmd of commands) {
        const result = await this.executor.execute(sshConfig, cmd, {
          sudo: args.sudo || false,
          cwd: args.cwd,
          // Zero here means "no deadline was named": the layer below will supply the shared default
          timeout: args.timeout || undefined,
          signal,
        });
        
        results.push({
          command: cmd,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
        });
      }
      
      // Format output
      let output = '';
      
      // Add warnings
      if (warnings.length > 0) {
        output += warnings.join('\n\n') + '\n\n';
        output += '═'.repeat(60) + '\n\n';
      }
      
      output += `Executed ${results.length} commands:\n\n`;
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        output += `[${ i + 1}/${results.length}] ${result.command}\n`;
        output += '─'.repeat(60) + '\n';
        
        if (result.stdout) {
          output += result.stdout + '\n';
        }
        
        if (result.stderr) {
          output += `STDERR: ${result.stderr}\n`;
        }
        
        output += `Exit code: ${result.exitCode}${exitCodeHint(result.exitCode)}\n`;

        if (result.truncated) {
          output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        }

        output += '\n';
      }
      
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error: any) {
      logger.error('ssh_exec failed:', error);
      return toolFailure(error);
    }
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
    warnings: string[]
  ): Promise<ToolResult> {
    const passport = await this.executor.passport(config);
    const id = createJobId();
    const { dir } = jobPaths(passport.home, id);

    // The working directory goes inside the job command: applied to the
    // launch itself, it would change the directory of the job's own service
    // files, while the command would stay wherever it was
    const jobCommand = cwd ? `cd ${shellQuote(cwd)} || exit 1; ${command}` : command;

    // The call's cancellation is deliberately not passed in here: an abort
    // between starting the job and answering would leave it running without
    // an id — that is, with no way to stop it
    const started = await this.executor.executeChecked(
      config,
      buildStartCommand(dir, jobCommand, passport.setsid)
    );

    const pid = parseJobStart(started.stdout);
    const head = warnings.length > 0 ? `${warnings.join('\n\n')}\n\n` : '';

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
    };
  }

  /**
   * A refusal if even one command in the call would destroy data for good.
   *
   * Parsing the text settles almost everything at once and without the
   * network; one request goes to the server, and only for what the text
   * cannot show — where a symlink leads. Returns the refusal text, or null if
   * it is safe to proceed.
   */
  private async refuseDestructive(
    commands: string[],
    config: SSHConfig,
    sudo?: boolean
  ): Promise<string | null> {
    // The passport is only needed for the home directory, and that is only
    // needed where a deletion appears at all. An ordinary command should not
    // pay for a check that does not concern it — so the home directory is fetched lazily.
    let home: string | null = null;

    for (const command of commands) {
      // Text-based parsing runs first: it does not concern paths, so an
      // earlier branch keyed on deletion targets would let it slip past along with the command
      const irreversible = inspectIrreversible(command);
      if (irreversible.blocked) {
        return blockedMessage(command, irreversible.reason!);
      }

      if (findRemovalTargets(command).length === 0) continue;
      if (home === null) home = (await this.executor.passport(config)).home;

      const verdict = inspectCommand(command, home);
      if (verdict.blocked) {
        return blockedMessage(command, verdict.reason!);
      }

      if (verdict.needsResolution.length > 0) {
        const resolution = await resolveRemovalTargets(
          this.executor,
          config,
          verdict.needsResolution,
          { sudo }
        );
        if (resolution.blocked) {
          return blockedMessage(command, resolution.reason!);
        }
      }
    }

    return null;
  }
}
