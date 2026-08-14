/**
 * Transfer Tool
 * SFTP-based binary-safe file/directory upload & download
 * with sha256 verification and atomic rename semantics.
 *
 * - ssh_upload   — upload a file or directory; verify via sha256; atomic rename.
 * - ssh_download — download a file or directory via SFTP (binary-safe).
 *
 * Heredoc / cat>file / base64-chunks are intentionally NOT used here.
 * For sudo writes into protected paths, the file travels to /tmp under the
 * SSH user, is copied next to the target under sudo and takes the target
 * path by rename.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { stat } from 'fs/promises';
import { join, posix as posixPath } from 'path';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { sha256OfFile, sha256OfFiles } from '../utils/sha256.js';
import { listTreeFiles } from '../utils/local-tree.js';
import { verifyRemoteFiles, type VerifyEntry } from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { localPathOps } from '../managers/local-path-ops.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath } from '../managers/path-guard.js';
import { buildSudoStagingPath } from '../utils/tmp-name.js';
import { shellMode, shellOwner, shellQuote } from '../utils/shell-arg.js';
import { requireText } from '../utils/tool-args.js';

interface UploadFileResult {
  remote_path: string;
  bytes: number;
  sha256?: string;
  verified: boolean;
  /** Почему сверка не состоялась — если она не состоялась */
  verifyNote?: string;
  atomic: boolean;
  sudo: boolean;
  /** Что случилось уже после того, как данные встали на место */
  warnings?: string[];
}

interface UploadDirResult extends UploadFileResult {
  files_uploaded: number;
}

/**
 * Сведения о локальном файле — или отказ на человеческом языке.
 *
 * Сырое исключение узла (`ENOENT: no such file or directory, stat '…'`) читается
 * как поломка инструмента, хотя это обычный ответ: файла по названному пути нет.
 */
async function statLocal(path: string) {
  try {
    return await stat(path);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`local_path does not exist: ${path}`);
    if (error?.code === 'EACCES') throw new Error(`local_path is not readable: ${path}`);
    throw error;
  }
}

/**
 * Дописать к ответу то, что случилось уже после успешной замены.
 *
 * Такие вещи нельзя ни выдавать за ошибку (данные на месте), ни глотать:
 * неубранная старая копия занимает диск, а неприменённые права меняют доступ.
 */
function formatWarnings(warnings: string[]): string {
  return warnings.length > 0 ? `\n  warnings:\n${warnings.map((w) => `    - ${w}`).join('\n')}` : '';
}

/** Владельца ставит `chown`, а он под обычным пользователем откажет на чужом имени */
const OWNER_NEEDS_SUDO =
  'owner was NOT applied: chown needs sudo — the file belongs to the connecting user';

/**
 * Наибольший таймаут, который умеет ждать таймер Node (~24.8 суток).
 * Всё, что больше, срабатывает у него немедленно — это уже не «подольше»,
 * а мгновенный обрыв, поэтому такие значения читаются как «без потолка».
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Потолок передачи, названный вызывающим.
 *
 * Не назвали — потолка нет. Назвали мусор — отказ до первой команды на
 * сервере: тип из схемы ничего не гарантирует, `arguments` приходят как есть.
 * Число строкой принимается: так его шлёт часть клиентов, и отвергать
 * рабочую форму ввода незачем.
 *
 * Ноль отклоняется, хотя внутри он и означает «без потолка»: у соседнего
 * `ssh_exec` тот же ноль читается как «значение по умолчанию», и два
 * противоположных смысла одного значения в одном сервере — ловушка.
 * Способ сказать «не ограничивай» ровно один: не называть параметр.
 *
 * Бесконечность и всё сверх предела таймера — тоже «не ограничивай»:
 * такое значение таймер отрабатывает немедленно, то есть буквальное
 * прочтение дало бы мгновенный обрыв вместо запрошенного «подольше».
 */
function parseTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `timeout must be a positive number of milliseconds, got ${JSON.stringify(value)}. ` +
      'Omit the parameter to run without a limit.'
    );
  }

  if (parsed > MAX_TIMEOUT_MS) return undefined;

  return parsed;
}

export class TransferTool {
  private executor: SSHExecutor;

  constructor() {
    this.executor = new SSHExecutor();
  }

  getTools(): Tool[] {
    return [
      {
        name: 'ssh_upload',
        description:
          'Upload a local file or directory to remote server via SFTP (binary-safe, streaming). ' +
          'Default: atomic rename + sha256 verify. Use this instead of base64-chunked ssh_file_write for binaries or large files.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            local_path: {
              type: 'string',
              description: 'Local file or directory path',
            },
            remote_path: {
              type: 'string',
              description: 'Remote destination path on the server',
            },
            mode: {
              type: 'string',
              description: 'Octal file mode, e.g. "644" or "755"',
            },
            recursive: {
              type: 'boolean',
              description:
                'Force recursive directory upload. If omitted, auto-detected via local stat.',
            },
            atomic: {
              type: 'boolean',
              description:
                'Ignored: the upload always writes next to the target and renames into place. ' +
                'Accepted so existing calls keep working.',
              default: true,
            },
            verify: {
              type: 'boolean',
              description:
                'Compare local and remote sha256 after upload. Default: true.',
              default: true,
            },
            sudo: {
              type: 'boolean',
              description:
                'Transfer to /tmp under the SSH user, then copy next to the target and rename ' +
                'into place under sudo. Default: false.',
              default: false,
            },
            owner: {
              type: 'string',
              description:
                'When sudo=true, owner spec applied with `chown` before the file takes the ' +
                'target path (e.g. "root:root").',
            },
            overwrite: {
              type: 'boolean',
              description: 'Overwrite if remote_path exists. Default: true.',
              default: true,
            },
            concurrency: {
              type: 'number',
              description:
                'Deprecated and ignored: the transfer goes through scp, which has no ' +
                'chunk concurrency to tune. Kept so that existing callers do not break.',
            },
            timeout: {
              type: 'number',
              description:
                'Give up after this many milliseconds. By default there is no limit: the transfer runs as long as it takes, and a stalled connection is dropped by the transport itself.',
            },
          },
          required: ['local_path', 'remote_path'],
        },
      },
      {
        name: 'ssh_download',
        description:
          'Download a remote file or directory via SFTP (binary-safe, streaming) with optional sha256 verification.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            remote_path: { type: 'string', description: 'Remote source path' },
            local_path: { type: 'string', description: 'Local destination path' },
            recursive: {
              type: 'boolean',
              description: 'Force recursive directory download (auto-detected via remote stat).',
            },
            verify: {
              type: 'boolean',
              description:
                'Compare local and remote sha256 after download. Default: true.',
              default: true,
            },
            concurrency: {
              type: 'number',
              description:
                'Deprecated and ignored: the transfer goes through scp, which has no ' +
                'chunk concurrency to tune. Kept so that existing callers do not break.',
            },
            timeout: {
              type: 'number',
              description:
                'Give up after this many milliseconds. By default there is no limit: the transfer runs as long as it takes, and a stalled connection is dropped by the transport itself.',
            },
          },
          required: ['remote_path', 'local_path'],
        },
      },
    ];
  }

  async handleCall(request: CallToolRequest): Promise<ToolResult> {
    const toolName = request.params.name;
    try {
      switch (toolName) {
        case 'ssh_upload':
          return await this.handleUpload(request);
        case 'ssh_download':
          return await this.handleDownload(request);
        default:
          throw new Error(`Unknown transfer tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return toolFailure(error);
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_upload
  // ---------------------------------------------------------------------------

  private async handleUpload(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    // Права и владелец проверяются до первого касания сервера: оба уезжают в
    // команду отдельными словами, где кавычки их не удержат
    const mode = args.mode ? shellMode(args.mode, 'mode') : undefined;
    const owner = args.owner ? shellOwner(args.owner, 'owner') : undefined;
    const timeoutMs = parseTimeoutMs(args.timeout);

    // Тильду раскрываем у себя, до первой команды. Дальше путь едет только в
    // одинарных кавычках, где `~` — обычная буква: сама передача её раскрывала
    // (scp отдаёт путь shell-у), а сверка, уборка и создание каталога — нет.
    // Замерено: файл уезжал в дом, сверка его там не находила, ответ врал
    // расхождением, staging оставался на сервере, а рядом появлялся каталог
    // с именем «~». Правила доступа применяются здесь же — к раскрытому пути,
    // то есть к тому, куда запись пойдёт на самом деле.
    const remotePath = requireText(args.remote_path, 'remote_path', '"/opt/app"');
    const localPath = requireText(args.local_path, 'local_path', '"./dist"');

    const target = await resolveRemotePath(this.executor, sshConfig, remotePath, {
      sudo: !!args.sudo,
    });

    const localStat = await statLocal(localPath);
    const isDir = args.recursive ?? localStat.isDirectory();

    if (isDir && !localStat.isDirectory()) {
      throw new Error(
        `local_path is not a directory but recursive=true: ${localPath}`
      );
    }

    if (isDir) {
      const result = await this.uploadDirectory(
        sshConfig,
        localPath,
        target.path,
        {
          mode,
          verify: args.verify !== false,
          sudo: !!args.sudo,
          owner,
          overwrite: args.overwrite !== false,
          timeoutMs,
        }
      );
      return {
        content: [
          {
            type: 'text',
            text: this.formatUploadResult(result, true, target.warnings),
          },
        ],
      };
    }

    const result = await this.uploadFile(
      sshConfig,
      localPath,
      target.path,
      {
        mode,
        verify: args.verify !== false,
        sudo: !!args.sudo,
        owner,
        overwrite: args.overwrite !== false,
        timeoutMs,
      }
    );
    return {
      content: [
        { type: 'text', text: this.formatUploadResult(result, false, target.warnings) },
      ],
    };
  }

  /**
   * Ответ о загрузке.
   *
   * Печатается путь, по которому файл лёг на самом деле: при `~` он отличается
   * от запрошенного. Предупреждения идут туда же — и те, что накопил
   * установщик (неубранная старая копия), и те, что появились при раскрытии
   * пути; раньше они просто пропадали.
   */
  private formatUploadResult(
    r: UploadFileResult | UploadDirResult,
    isDir: boolean,
    pathWarnings: string[] = []
  ): string {
    const lines: string[] = [];
    lines.push(`✓ Upload OK: ${r.remote_path}`);
    if (isDir) {
      lines.push(`  files: ${(r as UploadDirResult).files_uploaded}`);
    }
    lines.push(`  bytes: ${r.bytes}`);
    if (!r.verified) {
      lines.push(r.verifyNote ? `  sha256: skipped — ${r.verifyNote}` : `  sha256: skipped`);
    } else if (r.sha256) {
      lines.push(`  sha256: ${r.sha256} (verified)`);
    } else {
      // У каталога общего хэша нет — сошлись все файлы разом
      lines.push(`  sha256: verified (${(r as UploadDirResult).files_uploaded} files)`);
    }
    lines.push(`  atomic: ${r.atomic}`);
    lines.push(`  sudo: ${r.sudo}`);
    return lines.join('\n') + formatWarnings([...pathWarnings, ...(r.warnings ?? [])]);
  }

  /**
   * Загрузка одного файла.
   *
   * Оба пути, обычный и под sudo, идут через установщик: данные ложатся на
   * временный путь рядом с целью и встают на место переименованием. Различие
   * одно — чем наполняется этот временный путь: передачей напрямую или копией
   * из /tmp, потому что сама передача под root не ходит.
   */
  private async uploadFile(
    sshConfig: any,
    localPath: string,
    remotePath: string,
    opts: {
      mode?: string;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      /** Потолок передачи; без него она идёт столько, сколько нужно */
      timeoutMs?: number;
    }
  ): Promise<UploadFileResult> {
    const localStats = await statLocal(localPath);
    const localHashPromise = opts.verify ? sha256OfFile(localPath) : null;

    if (!opts.overwrite) {
      const exists = await this.remoteExists(sshConfig, remotePath);
      if (exists === 'yes') {
        throw new Error(`remote_path already exists and overwrite=false: ${remotePath}`);
      }
      if (exists === 'unknown') {
        throw new Error(
          `cannot tell whether ${remotePath} already exists, and overwrite=false ` +
            'forbids writing over an unknown target. Retry, or pass overwrite: true.'
        );
      }
    }

    // Установщик один на оба пути; под sudo от него отличается только то, чьими
    // правами идут команды и как наполняется временный путь
    const ops = remotePathOps({
      executor: this.executor,
      config: sshConfig,
      sudo: opts.sudo,
    });
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };
    let ownerWarnings: string[] = [];

    const outcome = await install(ops, {
      finalPath: remotePath,
      kind: 'file',
      stage: async (staging) => {
        if (opts.sudo) {
          await this.stageUnderSudo(sshConfig, localPath, staging, opts.timeoutMs);
          return;
        }
        await this.putFile(sshConfig, localPath, staging, opts.timeoutMs);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          [{ path: staging, hash: await localHashPromise! }],
          'upload',
          // под sudo копия рядом с целью уже не наша — прочесть её иначе нечем
          { sudo: opts.sudo, timeoutMs: opts.timeoutMs }
        );
        return null;
      },
      finalize: async (staging) => {
        ownerWarnings = await this.applyOwnership(sshConfig, staging, opts);
      },
    });

    return {
      remote_path: remotePath,
      bytes: localStats.size,
      sha256: opts.verify ? await localHashPromise! : undefined,
      ...verdict,
      atomic: true,
      sudo: opts.sudo,
      warnings: [...outcome.warnings, ...ownerWarnings],
    };
  }

  /**
   * Положить один файл на сервер.
   *
   * Родительский каталог здесь не создаётся: временный путь всегда лежит рядом
   * с целью, а его каталог установщик создал до начала передачи. На пути под
   * sudo это и вовсе `/tmp`. Лишняя команда стоила по одному обращению к
   * серверу на каждую загрузку — замерено на обоих контейнерах.
   */
  private async putFile(
    sshConfig: any,
    localPath: string,
    remotePath: string,
    timeoutMs?: number
  ): Promise<void> {
    const runner = await getRunner(sshConfig);
    await runner.upload(localPath, remotePath, { timeoutMs });
  }

  /**
   * Наполнить временный путь рядом с целью, когда писать туда можно только под root.
   *
   * Передача идёт от имени пользователя в /tmp, а рядом с целью файл появляется
   * копией под sudo: сам транспорт правами root не располагает. Промежуточный
   * файл убирается в любом исходе.
   */
  private async stageUnderSudo(
    sshConfig: any,
    localPath: string,
    staging: string,
    timeoutMs?: number
  ): Promise<void> {
    const handoff = buildSudoStagingPath();
    await this.putFile(sshConfig, localPath, handoff, timeoutMs);

    try {
      // Названный потолок доходит и сюда: копирование целого файла соразмерно
      // его размеру
      await this.executor.executeChecked(
        sshConfig,
        `cp -- ${shellQuote(handoff)} ${shellQuote(staging)}`,
        { sudo: true, timeout: timeoutMs }
      );
    } finally {
      await this.executor
        .execute(sshConfig, `rm -f -- ${shellQuote(handoff)}`, {})
        .catch(() => undefined);
    }
  }

  /**
   * Права и владелец на временном пути — до того, как он станет целью.
   *
   * Иначе на боевом пути возникает окно, в котором данные уже видны, а доступ
   * к ним ещё чужой. Владелец — только для пути под sudo: под обычным
   * пользователем `chown` откажет на чужом имени.
   */
  private async applyOwnership(
    sshConfig: any,
    staging: string,
    opts: { mode?: string; owner?: string; sudo: boolean }
  ): Promise<string[]> {
    if (opts.mode) {
      await this.executor.executeChecked(
        sshConfig,
        `chmod ${opts.mode} -- ${shellQuote(staging)}`,
        { sudo: opts.sudo }
      );
    }

    if (!opts.owner) return [];

    if (!opts.sudo) {
      // Названного владельца молча терять нельзя: файл остаётся за тем, кто
      // его записал, и человек об этом узнаёт только из `ls -l` на сервере
      return [OWNER_NEEDS_SUDO];
    }

    await this.executor.executeChecked(
      sshConfig,
      `chown ${opts.owner} -- ${shellQuote(staging)}`,
      { sudo: opts.sudo }
    );
    return [];
  }

  /**
   * Есть ли путь на сервере. «Проверить не вышло» — отдельный исход: раньше
   * сорванная проверка отвечала «нет файла», и защита `overwrite: false`
   * пропускала запись поверх того, чего не сумела разглядеть.
   */
  private async remoteExists(
    sshConfig: any,
    remotePath: string
  ): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const r = await this.executor.execute(
        sshConfig,
        `test -e ${shellQuote(remotePath)} && echo YES || echo NO`,
        { idempotent: true }
      );
      const answer = r.stdout.trim();
      if (answer === 'YES') return 'yes';
      if (answer === 'NO') return 'no';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Сверить переданное с исходником.
   *
   * Три исхода различаются по-разному: несовпадение — провал передачи (бросаем),
   * «проверить нечем» — успех с пометкой. Смешивать их нельзя: раньше сервер без
   * sha256sum давал ту же реакцию, что испорченный файл, и обработчик ошибки шёл
   * удалять только что записанное.
   */
  private async verify(
    sshConfig: any,
    entries: VerifyEntry[],
    label: string,
    opts: { sudo?: boolean; timeoutMs?: number } = {}
  ): Promise<{ verified: boolean; verifyNote?: string }> {
    const { sudo = false, timeoutMs } = opts;
    // Потолок стоит на всей операции, а не на одной её части: иначе дерево на
    // гигабайты доедет и упрётся в общие для команд 30 секунд уже здесь
    const outcome = await verifyRemoteFiles(this.executor, sshConfig, entries, {
      sudo,
      timeoutMs: timeoutMs ?? 0,
    });

    if (outcome.status === 'matched') return { verified: true };

    if (outcome.status === 'mismatched') {
      throw new Error(
        `sha256 mismatch after ${label}: ${outcome.paths.length} file(s) differ — ` +
        outcome.paths.slice(0, 5).join(', ')
      );
    }

    logger.warn(`[Transfer] verification skipped: ${outcome.reason}`);
    return { verified: false, verifyNote: outcome.reason };
  }

  // ---------------------------------------------------------------------------
  // Directory upload
  // ---------------------------------------------------------------------------

  private async uploadDirectory(
    sshConfig: any,
    localDir: string,
    remoteDir: string,
    opts: {
      mode?: string;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      /** Потолок передачи; без него она идёт столько, сколько нужно */
      timeoutMs?: number;
    }
  ): Promise<UploadDirResult> {
    if (opts.sudo) {
      throw new Error(
        'Recursive sudo upload is not yet supported. Upload to a user-writable staging dir, then `sudo cp -r` it into place.'
      );
    }

    const finalDir = remoteDir;

    if (!opts.overwrite) {
      const exists = await this.remoteExists(sshConfig, finalDir);
      if (exists === 'yes') {
        throw new Error(
          `remote directory already exists and overwrite=false: ${finalDir}`
        );
      }
      if (exists === 'unknown') {
        throw new Error(
          `cannot tell whether ${finalDir} already exists, and overwrite=false ` +
            'forbids writing over an unknown target. Retry, or pass overwrite: true.'
        );
      }
    }

    // Дерево считаем так же, как его видит транспорт: по ссылкам он идёт,
    // на битой и на цикле останавливается — узнать об этом лучше здесь,
    // до того как часть файлов уедет на сервер
    const files = await listTreeFiles(localDir);
    if (files.length === 0) {
      throw new Error(`local directory is empty: ${localDir}`);
    }

    let totalBytes = 0;
    for (const rel of files) {
      totalBytes += (await stat(join(localDir, rel))).size;
    }

    const ops = remotePathOps({ executor: this.executor, config: sshConfig });
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    // Каталог заменяется только целиком и только через установщик. Раньше здесь
    // стоял `rm -rf` по боевому пути, а следом отдельной командой `mv`: обрыв
    // между ними не оставлял на сервере ничего, и обработчик ошибки добивал
    // остатки. Теперь старое отводится в сторону и удаляется лишь после того,
    // как новое встало на место.
    const outcome = await install(ops, {
      finalPath: finalDir,
      kind: 'directory',
      stage: async (staging) => {
        // Дерево уезжает целиком: подкаталоги создаёт транспорт
        const runner = await getRunner(sshConfig);
        await runner.upload(localDir, staging, { recursive: true, timeoutMs: opts.timeoutMs });
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          (await sha256OfFiles(files.map((rel) => join(localDir, rel)))).map((hash, i) => ({
            hash,
            path: posixPath.join(staging, files[i]),
          })),
          'upload',
          { timeoutMs: opts.timeoutMs }
        );
        return null;
      },
      finalize: async (staging) => {
        if (!opts.mode) return;
        // Права ставятся до замены: иначе дерево какое-то время живёт на
        // боевом пути с чужим доступом. Обход дерева тоже соразмерен его
        // размеру, поэтому потолок здесь тот же, что у передачи
        await this.executor.executeChecked(
          sshConfig,
          `chmod -R ${opts.mode} -- ${shellQuote(staging)}`,
          { timeout: opts.timeoutMs ?? 0 }
        );
      },
    });

    return {
      remote_path: finalDir,
      bytes: totalBytes,
      ...verdict,
      atomic: true,
      sudo: false,
      files_uploaded: files.length,
      // Рекурсивная отправка идёт без sudo — значит и владельца сменить нечем
      warnings: [...outcome.warnings, ...(opts.owner ? [OWNER_NEEDS_SUDO] : [])],
    };
  }

  // ---------------------------------------------------------------------------
  // ssh_download
  // ---------------------------------------------------------------------------

  private async handleDownload(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const timeoutMs = parseTimeoutMs(args.timeout);

    // Тильду раскрываем до первой команды. Без этого передача её раскрывала
    // (файл приезжал), а сверка искала файл с именем «~» и не находила —
    // расхождение уносило уже скачанное, и у человека не оставалось ничего.
    // Замерено на обоих серверах: с `verify: false` тот же вызов проходил.
    // Правила доступа проверяются по раскрытому пути — по тому, откуда файл
    // будет прочитан на самом деле.
    const remotePath = requireText(args.remote_path, 'remote_path', '"/opt/app/app.conf"');
    const localPath = requireText(args.local_path, 'local_path', '"./app.conf"');

    const source = await resolveRemotePath(this.executor, sshConfig, remotePath, {
    });

    const isDir =
      args.recursive ?? (await this.isRemoteDir(sshConfig, source.path));

    if (isDir) {
      const result = await this.downloadDirectory(
        sshConfig,
        source.path,
        localPath,
        { verify: args.verify !== false, timeoutMs }
      );
      const verdict = result.verified
        ? `verified (${result.files} files)`
        : result.verifyNote
          ? `skipped — ${result.verifyNote}`
          : 'skipped';
      return {
        content: [
          {
            type: 'text',
            text:
              `✓ Downloaded directory: ${source.path} -> ${localPath}\n` +
              `  files: ${result.files}\n  sha256: ${verdict}` +
              formatWarnings([...source.warnings, ...result.warnings]),
          },
        ],
      };
    }

    const file = await this.downloadFile(
      sshConfig,
      source.path,
      localPath,
      { verify: args.verify !== false, timeoutMs }
    );
    const fileVerdict = file.verified
      ? 'verified'
      : file.verifyNote
        ? `skipped — ${file.verifyNote}`
        : 'skipped';
    return {
      content: [
        {
          type: 'text',
          text:
            `✓ Downloaded file: ${source.path} -> ${localPath}\n` +
            `  bytes: ${file.bytes}\n  sha256: ${fileVerdict}` +
            formatWarnings([...source.warnings, ...file.warnings]),
        },
      ],
    };
  }

  private async isRemoteDir(
    sshConfig: any,
    remotePath: string
  ): Promise<boolean> {
    const r = await this.executor.execute(
      sshConfig,
      `test -d ${shellQuote(remotePath)} && echo YES || echo NO`,
      {}
    );
    return r.stdout.trim() === 'YES';
  }

  private async downloadFile(
    sshConfig: any,
    remotePath: string,
    localPath: string,
    opts: { verify: boolean; timeoutMs?: number }
  ): Promise<{ bytes: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig);
    let bytes = 0;
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    // Файл пользователя заменяется только целым: раньше скачивание писало
    // прямо в конечный путь, и обрыв оставлял от старого файла огрызок
    const outcome = await install(localPathOps, {
      finalPath: localPath,
      kind: 'file',
      stage: async (staging) => {
        await runner.download(remotePath, staging, { timeoutMs: opts.timeoutMs });
        bytes = (await stat(staging)).size;
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          [{ path: remotePath, hash: await sha256OfFile(staging) }],
          'download',
          { timeoutMs: opts.timeoutMs }
        );
        return null;
      },
    });

    return { bytes, ...verdict, warnings: outcome.warnings };
  }

  /**
   * Скачать каталог целиком.
   *
   * Обход удалённого дерева теперь делает транспорт, поэтому здесь остаётся
   * только пересчитать полученное и, если просили, сверить хэши — раньше
   * verify для каталога молча ничего не делал.
   */
  private async downloadDirectory(
    sshConfig: any,
    remoteDir: string,
    localDir: string,
    opts: { verify: boolean; timeoutMs?: number }
  ): Promise<{ files: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig);
    let files: string[] = [];
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    const outcome = await install(localPathOps, {
      finalPath: localDir,
      kind: 'directory',
      stage: async (staging) => {
        await runner.download(remoteDir, staging, { recursive: true, timeoutMs: opts.timeoutMs });
        files = await listTreeFiles(staging);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          (await sha256OfFiles(files.map((rel) => join(staging, rel)))).map((hash, i) => ({
            hash,
            path: posixPath.join(remoteDir, files[i]),
          })),
          'download',
          { timeoutMs: opts.timeoutMs }
        );
        return null;
      },
    });

    return { files: files.length, ...verdict, warnings: outcome.warnings };
  }
}
