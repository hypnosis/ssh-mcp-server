/**
 * SSH Executor
 *
 * Собирает строку команды (sudo, рабочий каталог) и отдаёт её транспорту.
 * Как команда доедет до сервера — дело раннера; повторы и таймауты живут
 * там же, потому что только транспорт знает, что именно сломалось.
 */

import { getRunner } from '../runner/get-runner.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from '../runner/openssh-runner.js';
import { type ServerPassport } from '../runner/passport.js';
import { logger } from '../utils/logger.js';
import { exitCodeHint } from '../utils/output-notes.js';
import { shellQuote } from '../utils/shell-arg.js';
import { hideArtifactNames } from '../utils/tmp-name.js';
import type { SSHConfig } from '../utils/ssh-config.js';

/** Дверь к сроку транспорта для инструментов: они берут его здесь, а не в раннере */
export const DEFAULT_TIMEOUT_MS = DEFAULT_EXEC_TIMEOUT_MS;

export interface SSHExecuteOptions {
  /**
   * Command execution timeout (ms). Ноль означает «потолка нет»: так зовут
   * команды, длительность которых задаёт объём данных, — сверка хэшей дерева
   * на гигабайты не обязана укладываться в общие 30 секунд.
   */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Use sudo */
  sudo?: boolean;
  /**
   * Safe to repeat after a transport failure.
   * Ставится только чтению: повтор мутирующей команды опаснее её отказа.
   */
  idempotent?: boolean;
  /** Данные на вход команды (например, манифест для `sha256sum -c -`) */
  stdin?: string | Buffer;
  /**
   * Отмена вызова, пришедшая от клиента. Команда получает её только там, где
   * оборваться безопасно: уборка и замена файлов идут без сигнала, иначе
   * отмена остановила бы тот самый код, который убирает за отменой.
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
   * Вывод не поместился в буфер транспорта и показан частично.
   * Отдавать такой ответ как полный нельзя — он выглядит достоверным.
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
    // Wrap in `<shell> -c` so shell constructs (subshells `(...)`, `if/elif/fi`, pipes)
    // survive sudo. Plain `sudo (if ...; fi)` is a shell syntax error — sudo expects a
    // program, not a shell construct.
    //
    // Язык берётся из паспорта. Жёсткий `bash` означал, что на машине без него
    // не работает ни одна операция с повышением прав: измерено на Alpine, где
    // любой sudo-вызов отвечал «bash: command not found». `sh` есть везде,
    // поэтому он же и ответ на «паспорт не прочитан».
    let finalCommand = command;
    if (options.sudo) {
      const passport = await this.passport(config);
      finalCommand = `sudo ${passport.bash ? 'bash' : 'sh'} -c ${shellQuote(command)}`;
    }

    // Add cd if working directory is specified
    if (options.cwd) {
      finalCommand = `cd ${shellQuote(options.cwd)} && ${finalCommand}`;
    }

    logger.debug(`Executing SSH command: ${finalCommand.substring(0, 100)}...`);

    const runner = await getRunner(config);
    const result = await runner.exec(finalCommand, {
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
      idempotent: options.idempotent,
      stdin: options.stdin,
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
      throw new Error(
        hideArtifactNames(
          `Command failed (exit ${result.exitCode}): ${shortCommand} — ${detail}`
        ) + exitCodeHint(result.exitCode)
      );
    }

    return result;
  }

  /**
   * Паспорт сервера: что на нём есть из утилит.
   *
   * Спрашивается у транспорта, а не собирается здесь своей командой: только он
   * умеет провести пробу мимо шлюза первой команды. Проба через `exec` замыкала
   * круг — команды, стоящие в шлюзе, ждут паспорт, а паспорт ждёт шлюз.
   */
  async passport(config: SSHConfig): Promise<ServerPassport> {
    const runner = await getRunner(config);
    return runner.passport();
  }

  /**
   * Test connection to server
   */
  async testConnection(config: SSHConfig): Promise<boolean> {
    try {
      const runner = await getRunner(config);
      const result = await runner.ping();
      return result.ok;
    } catch {
      return false;
    }
  }
}
