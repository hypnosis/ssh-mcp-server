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
import {
  sha256OfFile,
  buildRemoteSha256Command,
  parseRemoteSha256,
  buildSha256Manifest,
  parseSha256CheckFailures,
  SHA256_BATCH_CHECK_COMMAND,
} from '../utils/sha256.js';
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
  atomic: boolean;
  sudo: boolean;
}

interface UploadDirResult extends UploadFileResult {
  files_uploaded: number;
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
      lines.push(`  sha256: skipped`);
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
      const verified = opts.verify
        ? await this.verifySha256(
            sshConfig,
            profileName,
            remotePath,
            await localHashPromise!,
            true // sudo for read
          )
        : false;
      return {
        remote_path: remotePath,
        bytes: localStats.size,
        sha256: opts.verify ? await localHashPromise! : undefined,
        verified,
        atomic: opts.atomic, // install copies, semantically atomic per file
        sudo: true,
      };
    }

    // Non-sudo path: SFTP directly, optional atomic rename
    const target = opts.atomic ? buildTempPath(remotePath) : remotePath;

    try {
      await this.putFile(sshConfig, profileName, localPath, target);

      if (opts.verify) {
        const localHash = await localHashPromise!;
        const ok = await this.verifySha256(
          sshConfig,
          profileName,
          target,
          localHash,
          false
        );
        if (!ok) {
          // best-effort cleanup
          await this.executor
            .execute(sshConfig, `rm -f ${shellQuote(target)}`, { profileName })
            .catch(() => undefined);
          throw new Error(
            `sha256 mismatch after upload: local=${localHash}, remote differs`
          );
        }
      }

      if (opts.atomic) {
        // atomic rename on the same FS
        await this.executor.executeChecked(
          sshConfig,
          `mv -f ${shellQuote(target)} ${shellQuote(remotePath)}`,
          { profileName }
        );
      }

      if (opts.mode) {
        await this.executor.executeChecked(
          sshConfig,
          `chmod ${opts.mode} ${shellQuote(remotePath)}`,
          { profileName }
        );
      }

      return {
        remote_path: remotePath,
        bytes: localStats.size,
        sha256: opts.verify ? await localHashPromise! : undefined,
        verified: opts.verify,
        atomic: opts.atomic,
        sudo: false,
      };
    } catch (err) {
      // Cleanup any temp file
      if (opts.atomic) {
        await this.executor
          .execute(sshConfig, `rm -f ${shellQuote(target)}`, { profileName })
          .catch(() => undefined);
      }
      throw err;
    }
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

  private async verifySha256(
    sshConfig: any,
    profileName: string,
    remotePath: string,
    expected: string,
    sudo: boolean
  ): Promise<boolean> {
    const cmd = buildRemoteSha256Command(shellQuote(remotePath));
    const r = await this.executor.execute(sshConfig, cmd, {
      profileName,
      sudo,
      idempotent: true,
    });
    if (r.stdout.includes('NO_SHA256_TOOL')) {
      logger.warn(
        `[Transfer] Neither sha256sum nor openssl found on remote — verify skipped`
      );
      return false;
    }
    // Несостоявшаяся проверка и несовпадение хэшей — разные вещи:
    // без этой ветки нечитаемый файл выглядел бы как испорченная передача
    if (r.exitCode !== 0) {
      throw new Error(
        `Failed to verify ${remotePath}: ${r.stderr.trim() || `exit code ${r.exitCode}`}`
      );
    }
    const actual = parseRemoteSha256(r.stdout);
    return actual === expected.toLowerCase();
  }

  /**
   * Проверить пачку файлов одной командой.
   *
   * Возвращает false, если на сервере нечем считать хэши, и бросает, если
   * хотя бы один файл не сошёлся — с перечислением, какие именно.
   */
  private async verifyBatch(
    sshConfig: any,
    profileName: string,
    entries: Array<{ hash: string; path: string }>
  ): Promise<boolean> {
    if (entries.length === 0) return false;

    const r = await this.executor.execute(sshConfig, SHA256_BATCH_CHECK_COMMAND, {
      profileName,
      stdin: buildSha256Manifest(entries),
      idempotent: true,
    });

    if (r.stdout.includes('NO_SHA256_TOOL')) {
      logger.warn(`[Transfer] sha256sum not found on remote — verify skipped`);
      return false;
    }

    if (r.exitCode !== 0) {
      const failed = parseSha256CheckFailures(r.stdout);
      if (failed.length > 0) {
        throw new Error(`sha256 mismatch for ${failed.length} file(s): ${failed.join(', ')}`);
      }
      throw new Error(
        `Failed to verify ${entries.length} file(s): ${r.stderr.trim() || `exit code ${r.exitCode}`}`
      );
    }

    return true;
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

    const stagingDir = opts.atomic ? buildStagingDir(remoteDir) : remoteDir;
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

    // Prepare staging dir
    await this.executor.executeChecked(
      sshConfig,
      `mkdir -p ${shellQuote(stagingDir)}`,
      { profileName }
    );

    let totalBytes = 0;
    let verified = false;
    try {
      for (const rel of files) {
        totalBytes += (await stat(join(localDir, rel))).size;
      }

      // Дерево уезжает целиком: подкаталоги создаёт транспорт
      const runner = await getRunner(sshConfig, profileName);
      await runner.upload(localDir, stagingDir, { recursive: true });

      if (opts.verify) {
        verified = await this.verifyBatch(
          sshConfig,
          profileName,
          await Promise.all(
            files.map(async (rel) => ({
              hash: await sha256OfFile(join(localDir, rel)),
              path: posixPath.join(stagingDir, rel),
            }))
          )
        );
      }

      // Replace target dir atomically (best-effort)
      if (opts.atomic) {
        // Remove old final if exists, then rename staging
        const existsCmd = `if [ -e ${shellQuote(finalDir)} ]; then rm -rf ${shellQuote(finalDir)}; fi`;
        // Уборка обязана удаться: иначе `mv` не заменит каталог,
        // а вложит перенесённый внутрь существующего
        await this.executor.executeChecked(sshConfig, existsCmd, { profileName });
        await this.executor.executeChecked(
          sshConfig,
          `mv -f ${shellQuote(stagingDir)} ${shellQuote(finalDir)}`,
          { profileName }
        );
      }

      if (opts.mode) {
        await this.executor.executeChecked(
          sshConfig,
          `chmod -R ${opts.mode} ${shellQuote(finalDir)}`,
          { profileName }
        );
      }

      return {
        remote_path: finalDir,
        bytes: totalBytes,
        verified,
        atomic: opts.atomic,
        sudo: false,
        files_uploaded: files.length,
      };
    } catch (err) {
      // best-effort cleanup
      if (opts.atomic) {
        await this.executor
          .execute(sshConfig, `rm -rf ${shellQuote(stagingDir)}`, {
            profileName,
          })
          .catch(() => undefined);
      }
      throw err;
    }
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
        : 'skipped';
      return {
        content: [
          {
            type: 'text',
            text:
              `✓ Downloaded directory: ${args.remote_path} -> ${args.local_path}\n` +
              `  files: ${result.files}\n  sha256: ${verdict}`,
          },
        ],
      };
    }

    const bytes = await this.downloadFile(
      sshConfig,
      profileName,
      args.remote_path,
      args.local_path,
      { verify: args.verify !== false }
    );
    return {
      content: [
        {
          type: 'text',
          text: `✓ Downloaded file: ${args.remote_path} -> ${args.local_path}\n  bytes: ${bytes}`,
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
  ): Promise<number> {
    const runner = await getRunner(sshConfig, profileName);
    await runner.download(remotePath, localPath, {});

    const localStats = await stat(localPath);
    const bytes = localStats.size;

    if (opts.verify) {
      const localHash = await sha256OfFile(localPath);
      const ok = await this.verifySha256(
        sshConfig,
        profileName,
        remotePath,
        localHash,
        false
      );
      if (!ok) {
        throw new Error(`sha256 mismatch after download: ${remotePath}`);
      }
    }

    return bytes;
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
  ): Promise<{ files: number; verified: boolean }> {
    const runner = await getRunner(sshConfig, profileName);
    await runner.download(remoteDir, localDir, { recursive: true });

    const files = await this.walkLocalDir(localDir);

    const verified = opts.verify
      ? await this.verifyBatch(
          sshConfig,
          profileName,
          await Promise.all(
            files.map(async (rel) => ({
              hash: await sha256OfFile(join(localDir, rel)),
              path: posixPath.join(remoteDir, rel),
            }))
          )
        )
      : false;

    return { files: files.length, verified };
  }
}
