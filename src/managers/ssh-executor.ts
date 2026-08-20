/**
 * SSH Executor
 *
 * Builds the command string (sudo, working directory) and hands it to the
 * transport. How the command actually reaches the server is the runner's
 * job; retries and timeouts live there too, because only the transport
 * knows what actually broke.
 */

import { getRunner } from '../runner/get-runner.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from '../runner/openssh-runner.js';
import { type ServerPassport } from '../runner/passport.js';
import { logger } from '../utils/logger.js';
import { exitCodeHint } from '../utils/output-notes.js';
import { shellQuote } from '../utils/shell-arg.js';
import { hideArtifactNames } from '../utils/tmp-name.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/** Entry point to the transport's default timeout for tools: they get it here, not from the runner */
export const DEFAULT_TIMEOUT_MS = DEFAULT_EXEC_TIMEOUT_MS;

export interface SSHExecuteOptions {
  /**
   * Command execution timeout (ms). Zero means "no ceiling": that's how
   * commands whose duration is set by the data volume are invoked — hashing
   * a multi-gigabyte tree is not obligated to fit in the usual 30 seconds.
   */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Use sudo */
  sudo?: boolean;
  /**
   * Safe to repeat after a transport failure.
   * Set only for reads: repeating a mutating command is more dangerous than its failure.
   */
  idempotent?: boolean;
  /** Data fed to the command's stdin (e.g. a manifest for `sha256sum -c -`) */
  stdin?: string | Buffer;
  /**
   * Cancellation coming from the client. The command receives it only where
   * aborting is safe: cleanup and file replacement run without the signal,
   * otherwise cancellation would stop the very code that cleans up after cancellation.
   */
  signal?: AbortSignal;
}

export interface SSHExecuteResult {
  /** Command output (stdout) */
  stdout: string;
  /** Errors (stderr) */
  stderr: string;
  /** Exit code */
  exitCode: number;
  /**
   * The output did not fit the transport buffer and is shown partially.
   * Such an answer must not be treated as complete — it looks trustworthy.
   */
  truncated: boolean;
}

/**
 * SSH Executor for command execution
 */
export class SSHExecutor {
  /**
   * Execute command on remote server.
   *
   * A non-zero exit code is part of the result, not an error: `grep` with
   * no matches returns 1, and the caller decides for itself what that means.
   *
   * @param config - SSH configuration
   * @param command - Command to execute
   * @param options - Execution options
   * @returns Execution result
   */
  async execute(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<SSHExecuteResult> {
    // Add sudo if needed.
    // Wrap in `<shell> -c` so shell constructs (subshells `(...)`, `if/elif/fi`, pipes)
    // survive sudo. Plain `sudo (if ...; fi)` is a shell syntax error — sudo expects a
    // program, not a shell construct.
    //
    // The shell is taken from the passport. A hard-coded `bash` would make
    // every privilege-elevating operation fail on a machine without it,
    // with sudo answering "bash: command not found". `sh` exists
    // everywhere, so it's also the answer for "the passport hasn't been read yet".
    let finalCommand = command;
    let stdin = options.stdin;
    if (options.sudo) {
      const passport = await this.passport(config);
      const shell = passport.bash ? 'bash' : 'sh';

      // A machine that asks for a password has no terminal to ask on, and the
      // profile already holds the one this user logs in with. It travels on
      // stdin rather than in the command: the arguments of a running process
      // are readable by anyone on the server.
      //
      // Only free stdin carries it. Where the call already sends data, a sudo
      // configured without a password would never read the line, and it would
      // arrive as the first line of that data instead.
      const password = config.password;
      if (password && stdin === undefined) {
        finalCommand = `sudo -S -p '' ${shell} -c ${shellQuote(command)}`;
        stdin = `${password}\n`;
      } else {
        finalCommand = `sudo ${shell} -c ${shellQuote(command)}`;
      }
    }

    // Add cd if working directory is specified.
    //
    // A failed cd must abort the whole line, not just the nearest command:
    // `&&` only binds up to the first `;`, so without this the rest would
    // silently run in the wrong directory with exit code 0. Exit is used
    // instead of braces — a command ending in `&` inside `{ … ; }` is a
    // syntax error on BusyBox and dropbear
    if (options.cwd) {
      finalCommand = `cd ${shellQuote(options.cwd)} || exit 1; ${finalCommand}`;
    }

    logger.debug(`Executing SSH command: ${finalCommand.substring(0, 100)}...`);

    const runner = await getRunner(config);
    const result = await runner.exec(finalCommand, {
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      idempotent: options.idempotent,
      stdin,
      signal: options.signal,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
    };
  }

  /**
   * Execute a command that must succeed.
   *
   * For steps after which there is no going forward: a directory wasn't
   * created, a file wasn't renamed, permissions weren't applied. The
   * places where a failure means the operation failed are named explicitly here.
   */
  async executeChecked(
    config: SSHConfig,
    command: string,
    options: SSHExecuteOptions = {}
  ): Promise<SSHExecuteResult> {
    const result = await this.execute(config, command, options);

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      const shortCommand = command.length > 120 ? `${command.substring(0, 120)}…` : command;
      throw new Error(
        hideArtifactNames(
          `Command failed (exit ${result.exitCode}): ${shortCommand} — ${detail}`
        ) + exitCodeHint(result.exitCode)
      );
    }

    return result;
  }

  /**
   * The server's passport: which utilities are available on it.
   *
   * Requested from the transport rather than assembled here with its own
   * command: only the transport can run the probe past the gate on the
   * first command. Probing via `exec` would close the loop — commands
   * waiting at the gate would wait for the passport, and the passport would wait for the gate.
   */
  async passport(config: SSHConfig): Promise<ServerPassport> {
    const runner = await getRunner(config);
    return runner.passport();
  }

  /**
   * Whether commands can be sent through this config right now.
   *
   * A server whose shell is a vendor CLI counts as usable: it runs commands, it simply has
   * no POSIX utilities for the probe to use.
   */
  async testConnection(config: SSHConfig): Promise<boolean> {
    try {
      const runner = await getRunner(config);
      const { state } = await runner.ping();
      return state === 'ready' || state === 'limited';
    } catch {
      return false;
    }
  }
}
