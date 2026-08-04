/**
 * Transfer Tool
 * SFTP-based binary-safe file/directory upload & download
 * with sha256 verification and atomic rename semantics.
 *
 * - ssh_upload   — upload a file or directory; verify via sha256; atomic rename.
 * - ssh_download — download a file or directory via SFTP (binary-safe).
 *
 * Heredoc / cat>file / base64-chunks are intentionally NOT used here.
 * For sudo writes into protected paths, the file is staged under /tmp
 * (sftp under user) and then `sudo install` moves it into place.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { stat } from 'fs/promises';
import { join, posix as posixPath } from 'path';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { sha256OfFile, sha256OfFiles } from '../utils/sha256.js';
import { listTreeFiles } from '../utils/local-tree.js';
import { verifyRemoteFiles, type VerifyEntry } from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { localPathOps } from '../managers/local-path-ops.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath } from '../managers/remote-home.js';
import { buildSudoStagingPath, shellQuote } from '../utils/tmp-name.js';
import { shellMode, shellOwner } from '../utils/shell-arg.js';

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
 * Дописать к ответу то, что случилось уже после успешной замены.
 *
 * Такие вещи нельзя ни выдавать за ошибку (данные на месте), ни глотать:
 * неубранная старая копия занимает диск, а неприменённые права меняют доступ.
 */
function formatWarnings(warnings: string[]): string {
  return warnings.length > 0 ? `\n  warnings:\n${warnings.map((w) => `    - ${w}`).join('\n')}` : '';
}

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
                'Write to a temp path next to the target and rename on success. Default: true.',
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
                'Stage in /tmp under the SSH user, then `sudo install -m <mode> src dst`. Default: false.',
              default: false,
            },
            owner: {
              type: 'string',
              description:
                'When sudo=true, owner spec for `install -o <owner>` (e.g. "root:root").',
            },
            overwrite: {
              type: 'boolean',
              description: 'Overwrite if remote_path exists. Default: true.',
              default: true,
            },
            concurrency: {
              type: 'number',
              description: 'Parallel SFTP chunk concurrency. Default: 4.',
              default: 4,
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
              description: 'Parallel SFTP chunk concurrency. Default: 4.',
              default: 4,
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

  async handleCall(request: CallToolRequest) {
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
      return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_upload
  // ---------------------------------------------------------------------------

  private async handleUpload(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
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
    const target = await resolveRemotePath(this.executor, sshConfig, args.remote_path, {
      profileName,
      sudo: !!args.sudo,
    });

    const localStat = await stat(args.local_path);
    const isDir = args.recursive ?? localStat.isDirectory();

    if (isDir && !localStat.isDirectory()) {
      throw new Error(
        `local_path is not a directory but recursive=true: ${args.local_path}`
      );
    }

    if (isDir) {
      const result = await this.uploadDirectory(
        sshConfig,
        profileName,
        args.local_path,
        target.path,
        {
          mode,
          atomic: args.atomic !== false,
          verify: args.verify !== false,
          sudo: !!args.sudo,
          owner,
          overwrite: args.overwrite !== false,
          concurrency: args.concurrency || 4,
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
      profileName,
      args.local_path,
      target.path,
      {
        mode,
        atomic: args.atomic !== false,
        verify: args.verify !== false,
        sudo: !!args.sudo,
        owner,
        overwrite: args.overwrite !== false,
        concurrency: args.concurrency || 4,
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
   * Single file upload with optional atomic rename and sha256 verify.
   * For sudo path: stage in /tmp, sudo install into place.
   */
  private async uploadFile(
    sshConfig: any,
    profileName: string,
    localPath: string,
    remotePath: string,
    opts: {
      mode?: string;
      atomic: boolean;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      concurrency: number;
      /** Потолок передачи; без него она идёт столько, сколько нужно */
      timeoutMs?: number;
    }
  ): Promise<UploadFileResult> {
    const localStats = await stat(localPath);
    const localHashPromise = opts.verify ? sha256OfFile(localPath) : null;

    if (!opts.overwrite) {
      const exists = await this.remoteExists(sshConfig, profileName, remotePath);
      if (exists) {
        throw new Error(`remote_path already exists and overwrite=false: ${remotePath}`);
      }
    }

    // sudo path: SFTP into /tmp, then `sudo install` into place
    if (opts.sudo) {
      const stage = buildSudoStagingPath();
      await this.putFile(sshConfig, profileName, localPath, stage, opts.timeoutMs);
      try {
        await this.sudoInstallFile(sshConfig, profileName, stage, remotePath, opts);
      } finally {
        // Best-effort cleanup of the stage file
        await this.executor
          .execute(sshConfig, `rm -f ${shellQuote(stage)}`, { profileName })
          .catch(() => undefined);
      }
      const verdict = opts.verify
        ? await this.verify(
            sshConfig,
            profileName,
            [{ path: remotePath, hash: await localHashPromise! }],
            'upload',
            // читать установленный файл приходится под sudo
            { sudo: true, timeoutMs: opts.timeoutMs }
          )
        : { verified: false };

      return {
        remote_path: remotePath,
        bytes: localStats.size,
        sha256: opts.verify ? await localHashPromise! : undefined,
        ...verdict,
        atomic: opts.atomic, // install copies, semantically atomic per file
        sudo: true,
      };
    }

    // Non-sudo path: через установщик — он же ловит случай «на месте цели
    // каталог», где прежний `mv -f` молча клал файл внутрь и рапортовал успех
    const ops = remotePathOps({ executor: this.executor, config: sshConfig, profileName });
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    const outcome = await install(ops, {
      finalPath: remotePath,
      kind: 'file',
      stage: async (staging) => {
        await this.putFile(sshConfig, profileName, localPath, staging, opts.timeoutMs);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
          [{ path: staging, hash: await localHashPromise! }],
          'upload',
          { timeoutMs: opts.timeoutMs }
        );
        return null;
      },
      finalize: async (staging) => {
        if (!opts.mode) return;
        await this.executor.executeChecked(
          sshConfig,
          `chmod ${opts.mode} -- ${shellQuote(staging)}`,
          { profileName }
        );
      },
    });

    return {
      remote_path: remotePath,
      bytes: localStats.size,
      sha256: opts.verify ? await localHashPromise! : undefined,
      ...verdict,
      atomic: true,
      sudo: false,
      warnings: outcome.warnings,
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
    profileName: string,
    localPath: string,
    remotePath: string,
    timeoutMs?: number
  ): Promise<void> {
    const runner = await getRunner(sshConfig, profileName);
    await runner.upload(localPath, remotePath, { timeoutMs });
  }

  private async sudoInstallFile(
    sshConfig: any,
    profileName: string,
    stage: string,
    target: string,
    opts: { mode?: string; owner?: string; timeoutMs?: number }
  ): Promise<void> {
    const flags: string[] = [];
    if (opts.mode) flags.push(`-m ${opts.mode}`);
    if (opts.owner) flags.push(`-o ${opts.owner.split(':')[0]}`);
    if (opts.owner && opts.owner.includes(':')) {
      flags.push(`-g ${opts.owner.split(':')[1]}`);
    }
    // ensure parent dir
    const parent = posixPath.dirname(target);
    if (parent && parent !== '/' && parent !== '.') {
      await this.executor.executeChecked(
        sshConfig,
        `mkdir -p ${shellQuote(parent)}`,
        { profileName, sudo: true }
      );
    }
    // Названный таймаут доходит и сюда — `install` копирует файл целиком, его
    // время задаёт размер. Но потолок здесь не снимается: это единственная
    // запись под root, и брошенный без срока `install` дописывал бы боевой
    // путь уже после того, как вызывающий получил ошибку и начался откат
    await this.executor.executeChecked(
      sshConfig,
      `install ${flags.join(' ')} ${shellQuote(stage)} ${shellQuote(target)}`,
      { profileName, sudo: true, timeout: opts.timeoutMs }
    );
  }

  private async remoteExists(
    sshConfig: any,
    profileName: string,
    remotePath: string
  ): Promise<boolean> {
    try {
      const r = await this.executor.execute(
        sshConfig,
        `test -e ${shellQuote(remotePath)} && echo YES || echo NO`,
        { profileName }
      );
      return r.stdout.trim() === 'YES';
    } catch {
      return false;
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
    profileName: string,
    entries: VerifyEntry[],
    label: string,
    opts: { sudo?: boolean; timeoutMs?: number } = {}
  ): Promise<{ verified: boolean; verifyNote?: string }> {
    const { sudo = false, timeoutMs } = opts;
    // Потолок стоит на всей операции, а не на одной её части: иначе дерево на
    // гигабайты доедет и упрётся в общие для команд 30 секунд уже здесь
    const outcome = await verifyRemoteFiles(this.executor, sshConfig, entries, {
      profileName,
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
    profileName: string,
    localDir: string,
    remoteDir: string,
    opts: {
      mode?: string;
      atomic: boolean;
      verify: boolean;
      sudo: boolean;
      owner?: string;
      overwrite: boolean;
      concurrency: number;
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
      const exists = await this.remoteExists(sshConfig, profileName, finalDir);
      if (exists) {
        throw new Error(
          `remote directory already exists and overwrite=false: ${finalDir}`
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

    const ops = remotePathOps({ executor: this.executor, config: sshConfig, profileName });
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
        const runner = await getRunner(sshConfig, profileName);
        await runner.upload(localDir, staging, { recursive: true, timeoutMs: opts.timeoutMs });
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
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
          { profileName, timeout: opts.timeoutMs ?? 0 }
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
      warnings: outcome.warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // ssh_download
  // ---------------------------------------------------------------------------

  private async handleDownload(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const timeoutMs = parseTimeoutMs(args.timeout);

    // Тильду раскрываем до первой команды. Без этого передача её раскрывала
    // (файл приезжал), а сверка искала файл с именем «~» и не находила —
    // расхождение уносило уже скачанное, и у человека не оставалось ничего.
    // Замерено на обоих серверах: с `verify: false` тот же вызов проходил.
    // Правила доступа проверяются по раскрытому пути — по тому, откуда файл
    // будет прочитан на самом деле.
    const source = await resolveRemotePath(this.executor, sshConfig, args.remote_path, {
      profileName,
    });

    const isDir =
      args.recursive ?? (await this.isRemoteDir(sshConfig, profileName, source.path));

    if (isDir) {
      const result = await this.downloadDirectory(
        sshConfig,
        profileName,
        source.path,
        args.local_path,
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
              `✓ Downloaded directory: ${source.path} -> ${args.local_path}\n` +
              `  files: ${result.files}\n  sha256: ${verdict}` +
              formatWarnings([...source.warnings, ...result.warnings]),
          },
        ],
      };
    }

    const file = await this.downloadFile(
      sshConfig,
      profileName,
      source.path,
      args.local_path,
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
            `✓ Downloaded file: ${source.path} -> ${args.local_path}\n` +
            `  bytes: ${file.bytes}\n  sha256: ${fileVerdict}` +
            formatWarnings([...source.warnings, ...file.warnings]),
        },
      ],
    };
  }

  private async isRemoteDir(
    sshConfig: any,
    profileName: string,
    remotePath: string
  ): Promise<boolean> {
    const r = await this.executor.execute(
      sshConfig,
      `test -d ${shellQuote(remotePath)} && echo YES || echo NO`,
      { profileName }
    );
    return r.stdout.trim() === 'YES';
  }

  private async downloadFile(
    sshConfig: any,
    profileName: string,
    remotePath: string,
    localPath: string,
    opts: { verify: boolean; timeoutMs?: number }
  ): Promise<{ bytes: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig, profileName);
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
          profileName,
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
    profileName: string,
    remoteDir: string,
    localDir: string,
    opts: { verify: boolean; timeoutMs?: number }
  ): Promise<{ files: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig, profileName);
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
          profileName,
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
