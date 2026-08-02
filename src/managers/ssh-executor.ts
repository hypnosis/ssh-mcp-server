/**
 * SSH Executor
 *
 * Собирает строку команды (sudo, рабочий каталог) и отдаёт её транспорту.
 * Как команда доедет до сервера — дело раннера; повторы и таймауты живут
 * там же, потому что только транспорт знает, что именно сломалось.
 */

import { getRunner } from '../runner/get-runner.js';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';

const DEFAULT_TIMEOUT_MS = 30000;

export interface SSHExecuteOptions {
  /** Command execution timeout (ms) */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Use sudo */
  sudo?: boolean;
  /** Profile name for the transport */
  profileName?: string;
  /**
   * Safe to repeat after a transport failure.
   * Ставится только чтению: повтор мутирующей команды опаснее её отказа.
   */
  idempotent?: boolean;
  /** Данные на вход команды (например, манифест для `sha256sum -c -`) */
  stdin?: string | Buffer;
}

export interface SSHExecuteResult {
  /** Command output (stdout) */
  stdout: string;
  /** Errors (stderr) */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * SSH Executor for command execution
 */
export class SSHExecutor {
  /**
   * Execute command on remote server.
   *
   * Ненулевой код возврата — часть результата, а не ошибка: `grep` без
   * совпадений возвращает 1, и вызывающий вправе решать сам, что это значит.
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
    // Wrap in `bash -c` so shell constructs (subshells `(...)`, `if/elif/fi`, pipes)
    // survive sudo. Plain `sudo (if ...; fi)` is a shell syntax error — sudo expects a
    // program, not a shell construct. `sudo bash -c '<cmd>'` runs the whole thing as one.
    let finalCommand = command;
    if (options.sudo) {
      finalCommand = `sudo bash -c ${this.escapeShell(command)}`;
    }

    // Add cd if working directory is specified
    if (options.cwd) {
      finalCommand = `cd ${this.escapeShell(options.cwd)} && ${finalCommand}`;
    }

    logger.debug(`Executing SSH command: ${finalCommand.substring(0, 100)}...`);

    const runner = await getRunner(config, options.profileName || 'default');
    const result = await runner.exec(finalCommand, {
      timeoutMs: options.timeout || DEFAULT_TIMEOUT_MS,
      idempotent: options.idempotent,
      stdin: options.stdin,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * Execute a command that must succeed.
   *
   * Для шагов, после которых нельзя идти дальше: не создан каталог, не
   * переименован файл, не применены права. Раньше такую проверку делал за нас
   * транспорт — он бросал на любом ненулевом коде; теперь код честный, и места,
   * где неудача означает провал операции, называются явно.
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
      throw new Error(`Command failed (exit ${result.exitCode}): ${shortCommand} — ${detail}`);
    }

    return result;
  }

  /**
   * Escape string for shell
   */
  private escapeShell(str: string): string {
    return `'${str.replace(/'/g, "'\"'\"'")}'`;
  }

  /**
   * Test connection to server
   */
  async testConnection(config: SSHConfig, profileName?: string): Promise<boolean> {
    try {
      const runner = await getRunner(config, profileName || 'default');
      const result = await runner.ping();
      return result.ok;
    } catch {
      return false;
    }
  }
}
