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
import { stat, readdir } from 'fs/promises';
import { join, posix as posixPath } from 'path';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { sha256OfFile } from '../utils/sha256.js';
import { verifyRemoteFiles, type VerifyEntry } from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { localPathOps } from '../managers/local-path-ops.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import {
  buildTempPath,
  buildStagingDir,
  buildSudoStagingPath,
  shellQuote,
} from '../utils/tmp-name.js';
import { createPathValidator } from '../utils/path-validator.js';

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

    // Path-security validation
    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      const v = pathValidator.validate(args.remote_path);
      if (!v.valid) throw new Error(`Path validation failed: ${v.error}`);
    }

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
        args.remote_path,
        {
          mode: args.mode,
          atomic: args.atomic !== false,
          verify: args.verify !== false,
          sudo: !!args.sudo,
          owner: args.owner,
          overwrite: args.overwrite !== false,
          concurrency: args.concurrency || 4,
        }
      );
      return {
        content: [
          {
            type: 'text',
            text: this.formatUploadResult(result, true),
          },
        ],
      };
    }

    const result = await this.uploadFile(
      sshConfig,
      profileName,
      args.local_path,
      args.remote_path,
      {
        mode: args.mode,
        atomic: args.atomic !== false,
        verify: args.verify !== false,
        sudo: !!args.sudo,
        owner: args.owner,
        overwrite: args.overwrite !== false,
        concurrency: args.concurrency || 4,
      }
    );
    return {
      content: [
        { type: 'text', text: this.formatUploadResult(result, false) },
      ],
    };
  }

  private formatUploadResult(
    r: UploadFileResult | UploadDirResult,
    isDir: boolean
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
    return lines.join('\n');
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
      await this.putFile(sshConfig, profileName, localPath, stage);
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
            true // читать установленный файл приходится под sudo
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
        await this.putFile(sshConfig, profileName, localPath, staging);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
          [{ path: staging, hash: await localHashPromise! }],
          'upload'
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
   * Родительский каталог создаётся заранее и обязан создаться: раньше неудача
   * здесь молчала, и передача падала дальше на невнятном «No such file».
   */
  private async putFile(
    sshConfig: any,
    profileName: string,
    localPath: string,
    remotePath: string
  ): Promise<void> {
    const parent = posixPath.dirname(remotePath);
    if (parent && parent !== '/' && parent !== '.') {
      await this.executor.executeChecked(
        sshConfig,
        `mkdir -p ${shellQuote(parent)}`,
        { profileName }
      );
    }

    const runner = await getRunner(sshConfig, profileName);
    await runner.upload(localPath, remotePath);
  }

  private async sudoInstallFile(
    sshConfig: any,
    profileName: string,
    stage: string,
    target: string,
    opts: { mode?: string; owner?: string }
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
    await this.executor.executeChecked(
      sshConfig,
      `install ${flags.join(' ')} ${shellQuote(stage)} ${shellQuote(target)}`,
      { profileName, sudo: true }
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
    sudo = false
  ): Promise<{ verified: boolean; verifyNote?: string }> {
    const outcome = await verifyRemoteFiles(this.executor, sshConfig, entries, {
      profileName,
      sudo,
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

    // Collect local files (relative paths) up front
    const files = await this.walkLocalDir(localDir);
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
        await runner.upload(localDir, staging, { recursive: true });
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
          await Promise.all(
            files.map(async (rel) => ({
              hash: await sha256OfFile(join(localDir, rel)),
              path: posixPath.join(staging, rel),
            }))
          ),
          'upload'
        );
        return null;
      },
      finalize: async (staging) => {
        if (!opts.mode) return;
        // Права ставятся до замены: иначе дерево какое-то время живёт на
        // боевом пути с чужим доступом
        await this.executor.executeChecked(
          sshConfig,
          `chmod -R ${opts.mode} -- ${shellQuote(staging)}`,
          { profileName }
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

  private async walkLocalDir(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      const abs = rel ? join(root, rel) : root;
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(childRel);
        } else if (e.isFile()) {
          out.push(childRel);
        }
        // symlinks intentionally ignored — sftp.fastPut would dereference,
        // user can request explicit support in a follow-up.
      }
    };
    await walk('');
    return out;
  }

  // ---------------------------------------------------------------------------
  // ssh_download
  // ---------------------------------------------------------------------------

  private async handleDownload(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const pathValidator = createPathValidator(sshConfig);
    if (pathValidator) {
      const v = pathValidator.validate(args.remote_path);
      if (!v.valid) throw new Error(`Path validation failed: ${v.error}`);
    }

    const isDir =
      args.recursive ??
      (await this.isRemoteDir(sshConfig, profileName, args.remote_path));

    if (isDir) {
      const result = await this.downloadDirectory(
        sshConfig,
        profileName,
        args.remote_path,
        args.local_path,
        { verify: args.verify !== false }
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
              `✓ Downloaded directory: ${args.remote_path} -> ${args.local_path}\n` +
              `  files: ${result.files}\n  sha256: ${verdict}` +
              formatWarnings(result.warnings),
          },
        ],
      };
    }

    const file = await this.downloadFile(
      sshConfig,
      profileName,
      args.remote_path,
      args.local_path,
      { verify: args.verify !== false }
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
            `✓ Downloaded file: ${args.remote_path} -> ${args.local_path}\n` +
            `  bytes: ${file.bytes}\n  sha256: ${fileVerdict}` +
            formatWarnings(file.warnings),
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
    opts: { verify: boolean }
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
        await runner.download(remotePath, staging, {});
        bytes = (await stat(staging)).size;
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
          [{ path: remotePath, hash: await sha256OfFile(staging) }],
          'download'
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
    opts: { verify: boolean }
  ): Promise<{ files: number; verified: boolean; verifyNote?: string; warnings: string[] }> {
    const runner = await getRunner(sshConfig, profileName);
    let files: string[] = [];
    let verdict: { verified: boolean; verifyNote?: string } = { verified: false };

    const outcome = await install(localPathOps, {
      finalPath: localDir,
      kind: 'directory',
      stage: async (staging) => {
        await runner.download(remoteDir, staging, { recursive: true });
        files = await this.walkLocalDir(staging);
      },
      verify: async (staging) => {
        if (!opts.verify) return null;
        verdict = await this.verify(
          sshConfig,
          profileName,
          await Promise.all(
            files.map(async (rel) => ({
              hash: await sha256OfFile(join(staging, rel)),
              path: posixPath.join(remoteDir, rel),
            }))
          ),
          'download'
        );
        return null;
      },
    });

    return { files: files.length, ...verdict, warnings: outcome.warnings };
  }
}
