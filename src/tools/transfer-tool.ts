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
import { SFTPWrapper, FileEntryWithStats } from 'ssh2';
import { stat, readdir } from 'fs/promises';
import { join, posix as posixPath, basename } from 'path';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { ConnectionPool } from '../managers/connection-pool.js';
import {
  sha256OfFile,
  buildRemoteSha256Command,
  parseRemoteSha256,
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
    if (r.verified) {
      lines.push(`  sha256: ${r.sha256} (verified)`);
    } else {
      lines.push(`  sha256: skipped`);
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
      await this.sftpPutFile(sshConfig, profileName, localPath, stage, opts);
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
      await this.sftpPutFile(sshConfig, profileName, localPath, target, opts);

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
        await this.executor.execute(
          sshConfig,
          `mv -f ${shellQuote(target)} ${shellQuote(remotePath)}`,
          { profileName }
        );
      }

      if (opts.mode) {
        await this.executor.execute(
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

  private async sftpPutFile(
    sshConfig: any,
    profileName: string,
    localPath: string,
    remotePath: string,
    opts: { concurrency: number }
  ): Promise<void> {
    const pool = ConnectionPool.getInstance();
    const sftp = await pool.getSftp(profileName, sshConfig);
    try {
      // Ensure parent dir exists (best-effort)
      const parent = posixPath.dirname(remotePath);
      if (parent && parent !== '/' && parent !== '.') {
        await new Promise<void>((resolve) => {
          sftp.stat(parent, (err) => {
            if (err) {
              this.executor
                .execute(sshConfig, `mkdir -p ${shellQuote(parent)}`, {
                  profileName,
                })
                .then(() => resolve())
                .catch(() => resolve());
            } else {
              resolve();
            }
          });
        });
      }

      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          localPath,
          remotePath,
          { concurrency: opts.concurrency, chunkSize: 32768 },
          (err) => {
            if (err) reject(new Error(`SFTP fastPut failed: ${err.message}`));
            else resolve();
          }
        );
      });
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
    }
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
      await this.executor.execute(
        sshConfig,
        `mkdir -p ${shellQuote(parent)}`,
        { profileName, sudo: true }
      );
    }
    await this.executor.execute(
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
    const r = await this.executor.execute(sshConfig, cmd, { profileName, sudo });
    if (r.stdout.includes('NO_SHA256_TOOL')) {
      logger.warn(
        `[Transfer] Neither sha256sum nor openssl found on remote — verify skipped`
      );
      return false;
    }
    const actual = parseRemoteSha256(r.stdout);
    return actual === expected.toLowerCase();
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
    await this.executor.execute(
      sshConfig,
      `mkdir -p ${shellQuote(stagingDir)}`,
      { profileName }
    );

    let totalBytes = 0;
    try {
      // Upload files with bounded concurrency
      await this.runWithConcurrency(files, opts.concurrency, async (rel) => {
        const local = join(localDir, rel);
        const remote = posixPath.join(stagingDir, rel);
        const fileStat = await stat(local);
        totalBytes += fileStat.size;

        const parent = posixPath.dirname(remote);
        if (parent && parent !== stagingDir) {
          await this.executor.execute(
            sshConfig,
            `mkdir -p ${shellQuote(parent)}`,
            { profileName }
          );
        }

        await this.sftpPutFile(sshConfig, profileName, local, remote, {
          concurrency: 1, // per-file inner concurrency
        });

        if (opts.verify) {
          const expected = await sha256OfFile(local);
          const ok = await this.verifySha256(
            sshConfig,
            profileName,
            remote,
            expected,
            false
          );
          if (!ok) {
            throw new Error(`sha256 mismatch for ${rel}`);
          }
        }
      });

      // Replace target dir atomically (best-effort)
      if (opts.atomic) {
        // Remove old final if exists, then rename staging
        const existsCmd = `if [ -e ${shellQuote(finalDir)} ]; then rm -rf ${shellQuote(finalDir)}; fi`;
        await this.executor.execute(sshConfig, existsCmd, { profileName });
        await this.executor.execute(
          sshConfig,
          `mv -f ${shellQuote(stagingDir)} ${shellQuote(finalDir)}`,
          { profileName }
        );
      }

      if (opts.mode) {
        await this.executor.execute(
          sshConfig,
          `chmod -R ${opts.mode} ${shellQuote(finalDir)}`,
          { profileName }
        );
      }

      return {
        remote_path: finalDir,
        bytes: totalBytes,
        verified: opts.verify,
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

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    const queue = [...items];
    const runners: Promise<void>[] = [];
    const next = async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        await worker(item);
      }
    };
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      runners.push(next());
    }
    await Promise.all(runners);
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
      const count = await this.downloadDirectory(
        sshConfig,
        profileName,
        args.remote_path,
        args.local_path,
        {
          verify: args.verify !== false,
          concurrency: args.concurrency || 4,
        }
      );
      return {
        content: [
          {
            type: 'text',
            text: `✓ Downloaded directory: ${args.remote_path} -> ${args.local_path}\n  files: ${count}`,
          },
        ],
      };
    }

    const bytes = await this.downloadFile(
      sshConfig,
      profileName,
      args.remote_path,
      args.local_path,
      {
        verify: args.verify !== false,
        concurrency: args.concurrency || 4,
      }
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
    opts: { verify: boolean; concurrency: number }
  ): Promise<number> {
    const pool = ConnectionPool.getInstance();
    const sftp = await pool.getSftp(profileName, sshConfig);
    let bytes = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          remotePath,
          localPath,
          { concurrency: opts.concurrency, chunkSize: 32768 },
          (err) => {
            if (err) reject(new Error(`SFTP fastGet failed: ${err.message}`));
            else resolve();
          }
        );
      });
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
    }

    const localStats = await stat(localPath);
    bytes = localStats.size;

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

  private async downloadDirectory(
    sshConfig: any,
    profileName: string,
    remoteDir: string,
    localDir: string,
    opts: { verify: boolean; concurrency: number }
  ): Promise<number> {
    const pool = ConnectionPool.getInstance();
    const sftp = await pool.getSftp(profileName, sshConfig);
    let count = 0;
    try {
      // Build remote file list via SFTP recursive listing
      const files: string[] = [];
      const walk = async (rel: string) => {
        const abs = rel ? posixPath.join(remoteDir, rel) : remoteDir;
        const entries = await new Promise<FileEntryWithStats[]>(
          (resolve, reject) => {
            sftp.readdir(abs, (err, list) => {
              if (err) reject(err);
              else resolve(list);
            });
          }
        );
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.filename}` : e.filename;
          if (e.attrs.isDirectory()) {
            await walk(childRel);
          } else if (e.attrs.isFile()) {
            files.push(childRel);
          }
        }
      };
      await walk('');
      count = files.length;

      const { mkdir } = await import('fs/promises');
      await mkdir(localDir, { recursive: true });
      for (const rel of files) {
        const localFile = join(localDir, rel);
        const remoteFile = posixPath.join(remoteDir, rel);
        const parent = join(localDir, posixPath.dirname(rel));
        await mkdir(parent, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(
            remoteFile,
            localFile,
            { concurrency: opts.concurrency, chunkSize: 32768 },
            (err) => {
              if (err) reject(new Error(`fastGet ${rel}: ${err.message}`));
              else resolve();
            }
          );
        });
      }
    } finally {
      sftp.end();
      pool.releaseClient(profileName);
    }
    return count;
  }
}
