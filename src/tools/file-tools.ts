/**
 * SSH File Tools
 * Tools for working with files on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { READS_REMOTE, WRITES_REMOTE } from './annotations.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { batchOutcome, toolFailure, type ToolResult } from '../utils/tool-result.js';
import {
  failedFile,
  FILES_OUTPUT_SCHEMA,
  writtenFile,
  type FilesSummary,
} from './transfer-output.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { sha256OfBuffer } from '../utils/sha256.js';
import { verifyRemoteFiles } from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath, type ExpandedPath } from '../managers/path-guard.js';
import { buildSudoStagingPath } from '../utils/tmp-name.js';
import { shellGlob, shellMode, shellQuote } from '../utils/shell-arg.js';
import { requireEntryList, requireText, requireTextList } from '../utils/tool-args.js';
import {
  binaryReadMessage,
  looksDamagedAsText,
  truncatedReadMessage,
  withTruncationNote,
} from '../utils/output-notes.js';

/**
 * Up to what size content travels straight through the command channel.
 *
 * Above this bound the file goes to the transport instead: there is no
 * reason to hold megabytes in process memory and push them as one chunk,
 * and the transport can stream them.
 */
const INLINE_WRITE_LIMIT = 256 * 1024;

/**
 * What became of verifying the written data: checked and it matched, there
 * was nothing to check with, or verification was not requested. The three
 * outcomes are not mixed together.
 */
type VerificationOutcome =
  | { status: 'verified' }
  | { status: 'unavailable'; reason: string }
  | { status: 'skipped' };

/** Verification note for the response; a write that wasn't verified has none */
function verificationNote(outcome: VerificationOutcome): string {
  if (outcome.status === 'verified') return ' (sha256 verified)';
  if (outcome.status === 'unavailable') return ` (NOT verified: ${outcome.reason})`;
  return '';
}

/** ssh_file_read arguments, matching its inputSchema */
interface FileReadArgs {
  profile?: string;
  path?: unknown;
  encoding?: string;
  binary?: boolean;
  sudo?: boolean;
}

/** ssh_file_write arguments, matching its inputSchema */
interface FileWriteArgs {
  profile?: string;
  files?: unknown;
}

/** ssh_file_list arguments, matching its inputSchema */
interface FileListArgs {
  profile?: string;
  path?: unknown;
  pattern?: unknown;
  recursive?: boolean;
}

/**
 * File Tools
 */
export class FileTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool descriptions for MCP
   */
  getTools(): Tool[] {
    return [
      // ssh_file_read
      {
        name: 'ssh_file_read',
        annotations: { title: 'Read a remote file', ...READS_REMOTE },
        description:
          'Read file(s) from remote server. Supports single file or batch reading. ' +
          'For binaries use binary=true (reads via scp, returns base64). ' +
          'For large files prefer ssh_download.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            path: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'File path or array of file paths to read',
            },
            encoding: {
              type: 'string',
              enum: ['utf8', 'base64'],
              description: 'File encoding. Default: utf8',
              default: 'utf8',
            },
            binary: {
              type: 'boolean',
              description:
                'Read via scp and return base64 (binary-safe). Default: false. Implies encoding=base64.',
              default: false,
            },
            sudo: {
              type: 'boolean',
              description: 'Read files with sudo. Default: false',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      
      // ssh_file_write
      {
        name: 'ssh_file_write',
        annotations: { title: 'Write a remote file', ...WRITES_REMOTE },
        description:
          'Write file(s) to remote server. Supports single file or batch writing. ' +
          'Optional flags per file: verify (sha256 after write), atomic (ignored — the write always ' +
          'uses a temp path next to the target and renames into place), ' +
          'binary (content is base64; uploaded via scp — required for binaries). ' +
          'For files >256KB, binaries, or directories prefer ssh_upload.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            files: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    mode: { type: 'string', description: 'File permissions (e.g., "644", "755")' },
                    sudo: { type: 'boolean', description: 'Write with sudo' },
                    verify: {
                      type: 'boolean',
                      description: 'Verify sha256 after write. Default: false.',
                    },
                    atomic: {
                      type: 'boolean',
                      description:
                        'Ignored: the write always writes to a temp path next to the target and ' +
                        'renames into place. Accepted so existing calls keep working.',
                    },
                    binary: {
                      type: 'boolean',
                      description:
                        'Content is base64-encoded; upload via scp. Default: false.',
                    },
                  },
                  required: ['path', 'content'],
                },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      content: { type: 'string' },
                      mode: { type: 'string' },
                      sudo: { type: 'boolean' },
                      verify: { type: 'boolean' },
                      atomic: { type: 'boolean' },
                      binary: { type: 'boolean' },
                    },
                    required: ['path', 'content'],
                  },
                },
              ],
              description: 'Single file object or array of file objects to write',
            },
          },
          required: ['files'],
        },
        outputSchema: FILES_OUTPUT_SCHEMA,
      },
      
      // ssh_file_list
      {
        name: 'ssh_file_list',
        annotations: { title: 'List a remote directory', ...READS_REMOTE },
        description: 'List files in directory on remote server',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: 'SSH profile name',
            },
            path: {
              type: 'string',
              description: 'Directory path to list',
            },
            pattern: {
              type: 'string',
              description: 'File pattern (e.g., "*.log", "*.conf")',
            },
            recursive: {
              type: 'boolean',
              description: 'List files recursively. Default: false',
              default: false,
            },
          },
          required: ['path'],
        },
      },
    ];
  }
  
  /**
   * Handle tool call
   */
  async handleCall(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const toolName = request.params.name;
    
    try {
      switch (toolName) {
        case 'ssh_file_read':
          return await this.handleFileRead(request, signal);
        case 'ssh_file_write':
          return await this.handleFileWrite(request);
        case 'ssh_file_list':
          return await this.handleFileList(request, signal);
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return toolFailure(error);
    }
  }
  
  /**
   * Handle ssh_file_read
   */
  private async handleFileRead(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as FileReadArgs;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    const sshConfig = resolveSSHConfig({ profile: args.profile });

    const requested = requireTextList(args.path, 'path', '"/etc/hosts"');
    const binary = args.binary === true;
    const encoding = binary ? 'base64' : (args.encoding || 'utf8');
    const sudo = args.sudo || false;

    // Paths are expanded and checked against the rules before the first
    // command — the whole list at once: a refusal on the fifth file must not
    // arrive after the first four have already been read
    const paths: string[] = [];
    for (const path of requested) {
      const target = await resolveRemotePath(this.executor, sshConfig, path, { sudo });
      for (const warning of target.warnings) logger.warn(`[file-tools] ${warning}`);
      paths.push(target.path);
    }

    // Single file - simple result
    if (paths.length === 1) {
      if (binary) {
        const b64 = await this.readFileBinary(sshConfig, paths[0]);
        return { content: [{ type: 'text', text: b64 }] };
      }
      const command = this.buildReadCommand(paths[0], encoding);

      const result = await this.executor.execute(sshConfig, command, {
        sudo,
        idempotent: true,
        signal,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr || result.stdout}`);
      }

      // A partial file cannot be handed out as a file: whoever reads it next would take it for the whole content
      if (result.truncated) {
        throw new Error(`Failed to read file: ${truncatedReadMessage(paths[0])}`);
      }

      if (encoding === 'utf8' && looksDamagedAsText(result.stdout)) {
        throw new Error(`Failed to read file: ${binaryReadMessage(paths[0])}`);
      }

      return {
        content: [{ type: 'text', text: result.stdout }],
      };
    }
    
    // Multiple files - structured result
    const results: Array<{
      path: string;
      content: string;
      size: number;
      success: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        if (binary) {
          const b64 = await this.readFileBinary(sshConfig, path);
          results.push({
            path,
            content: b64,
            size: Buffer.from(b64, 'base64').length,
            success: true,
          });
          continue;
        }
        const command = this.buildReadCommand(path, encoding);

        const result = await this.executor.execute(sshConfig, command, {
          sudo,
          idempotent: true,
          signal,
        });

        if (result.exitCode === 0 && result.truncated) {
          results.push({
            path,
            content: '',
            size: 0,
            success: false,
            error: truncatedReadMessage(path),
          });
        } else if (result.exitCode === 0 && encoding === 'utf8' && looksDamagedAsText(result.stdout)) {
          results.push({
            path,
            content: '',
            size: 0,
            success: false,
            error: binaryReadMessage(path),
          });
        } else if (result.exitCode === 0) {
          results.push({
            path,
            content: result.stdout,
            size: Buffer.byteLength(result.stdout, 'utf8'),
            success: true,
          });
        } else {
          results.push({
            path,
            content: '',
            size: 0,
            success: false,
            error: result.stderr || result.stdout,
          });
        }
      } catch (error: any) {
        // A cancellation is not "this file failed to read": otherwise a
        // cancelled call would return a list with gaps instead of a refusal
        if (signal?.aborted) throw error;
        results.push({
          path,
          content: '',
          size: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = '';

    for (const result of results) {
      if (result.success) {
        output += `✓ ${result.path} (${result.size} bytes)\n`;
        output += '─'.repeat(60) + '\n';
        output += result.content + '\n\n';
      } else {
        output += `✗ ${result.path}\n`;
        output += `  Error: ${result.error}\n\n`;
      }
    }

    return batchOutcome('Read', results.filter((r) => r.success).length, results.length, output);
  }

  /**
   * Handle ssh_file_write
   */
  private async handleFileWrite(request: CallToolRequest) {
    const args = (request.params.arguments ?? {}) as FileWriteArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    // The shape is validated entirely before the first write: without this, a
    // missing `files` fell through to an internal `Cannot read properties of
    // undefined`, and `files: []` cheerfully answered "Write 0 files" for
    // work that never ran.
    const requested = requireEntryList(args.files, 'files', ['path', 'content'],
      '{"path": "/etc/app.conf", "content": "..."}');

    // Paths are expanded and checked against the rules before the first
    // write — the whole list at once: a refusal on the fifth file must not
    // arrive after the first four have already landed on the server
    const files: Array<{ file: any; target: ExpandedPath }> = [];
    for (const file of requested) {
      files.push({
        file,
        target: await resolveRemotePath(this.executor, sshConfig, file.path, {
          sudo: file.sudo === true,
        }),
      });
    }

    // Single file - simple result
    if (files.length === 1) {
      const { file, target } = files[0];
      const written = await this.writeFileRouted(sshConfig, file, target);

      // The path printed is where the file actually ended up: with `~` it
      // differs from what was requested, and the user needs to see the real address
      const notes = written.warnings.map((warning) => `\n⚠ ${warning}`).join('');

      return {
        content: [
          {
            type: 'text',
            text: `File written successfully: ${written.path}${verificationNote(written.verification)}${notes}`,
          },
        ],
        structuredContent: {
          files: [writtenFile(written.path, written.verification, this.contentBytes(file))],
        } satisfies FilesSummary,
      };
    }

    // Multiple files - structured result
    const results: Array<{
      path: string;
      success: boolean;
      bytesWritten: number;
      warnings?: string[];
      verification?: VerificationOutcome;
      error?: string;
    }> = [];

    for (const { file, target } of files) {
      try {
        const written = await this.writeFileRouted(sshConfig, file, target);
        results.push({
          path: written.path,
          success: true,
          warnings: written.warnings,
          verification: written.verification,
          bytesWritten: this.contentBytes(file),
        });
      } catch (error: any) {
        results.push({
          path: target.path,
          success: false,
          bytesWritten: 0,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = '';

    for (const result of results) {
      if (result.success) {
        const verified = result.verification ? verificationNote(result.verification) : '';
        output += `✓ ${result.path} (${result.bytesWritten} bytes)${verified}\n`;
        for (const warning of result.warnings || []) {
          output += `  ⚠ ${warning}\n`;
        }
      } else {
        output += `✗ ${result.path}\n`;
        output += `  Error: ${result.error}\n`;
      }
    }

    const answer = batchOutcome(
      'Write',
      results.filter((r) => r.success).length,
      results.length,
      output
    );

    // Even a call where nothing landed carries the summary: which file failed
    // and on what is the answer the caller acts on
    answer.structuredContent = {
      files: results.map((result) =>
        result.success && result.verification
          ? writtenFile(result.path, result.verification, result.bytesWritten)
          : failedFile(result.path, result.error ?? 'write failed')
      ),
    } satisfies FilesSummary;

    return answer;
  }

  /** Size of what the caller asked to write: base64 is counted after decoding */
  private contentBytes(file: { content?: string; binary?: boolean }): number {
    return file.binary
      ? Buffer.from(file.content || '', 'base64').length
      : Buffer.byteLength(file.content || '', 'utf8');
  }
  
  /**
   * Write a file to the server.
   *
   * One path handles any content: data lands on a staging path next to the
   * target and takes its place via the installer. Only how the staging path
   * gets filled differs — small content streams into the `cat` command's
   * stdin, large and binary content goes to the transport.
   *
   * Content never appears inside the command string. A heredoc glues it into
   * the command text, and on live servers that corrupts the write: an
   * apostrophe turns into five characters, the string `SSHEOF` inside the
   * text cuts the file short, and the remainder executes as commands.
   */
  private async writeFileRouted(
    sshConfig: any,
    file: {
      path: string;
      content: string;
      mode?: string;
      sudo?: boolean;
      verify?: boolean;
      atomic?: boolean;
      binary?: boolean;
    },
    /** Expanded destination path, already checked against the rules */
    target: ExpandedPath
  ): Promise<{ path: string; warnings: string[]; verification: VerificationOutcome }> {
    const buf = file.binary
      ? Buffer.from(file.content || '', 'base64')
      : Buffer.from(file.content || '', 'utf8');

    // Mode is validated before the first command: a refusal halfway through
    // would leave behind a staging path and a write nobody asked for
    const mode = file.mode ? shellMode(file.mode, 'mode') : undefined;

    const expectedHash = sha256OfBuffer(buf);
    // The verification outcome travels into the response: without it,
    // "matched" and "nothing to verify with" both look to the client like an
    // equally successful write
    let verification: VerificationOutcome = { status: 'skipped' };
    const ops = remotePathOps({
      executor: this.executor,
      config: sshConfig,
      sudo: file.sudo,
    });

    const outcome = await install(ops, {
      finalPath: target.path,
      kind: 'file',
      stage: (staging) =>
        buf.length > INLINE_WRITE_LIMIT
          ? this.stageByTransport(sshConfig, staging, buf, file.sudo)
          : this.stageByStdin(sshConfig, staging, buf, file.sudo),
      verify: async (staging) => {
        if (!file.verify) return null;

        const result = await verifyRemoteFiles(
          this.executor,
          sshConfig,
          [{ path: staging, hash: expectedHash }],
          { sudo: file.sudo }
        );

        if (result.status === 'mismatched') {
          return `local=${expectedHash}, remote differs`;
        }

        // "Nothing to verify with" is not the same as a corrupted write:
        // refusing here would tear down a sound write on a server that lacks sha256sum and openssl
        if (result.status === 'unavailable') {
          logger.warn(`[file-tools] verification skipped: ${result.reason}`);
          verification = { status: 'unavailable', reason: result.reason };
        } else {
          verification = { status: 'verified' };
        }

        return null;
      },
      finalize: async (staging) => {
        if (!mode) return;
        await this.executor.executeChecked(
          sshConfig,
          `chmod ${mode} -- ${shellQuote(staging)}`,
          { sudo: file.sudo }
        );
      },
    });

    return {
      path: outcome.path,
      warnings: [...target.warnings, ...outcome.warnings],
      verification,
    };
  }

  /**
   * Fill the staging path via a stdin stream.
   *
   * The content travels as bytes over the channel, not as command text, so
   * the shell never parses it: quotes, line boundaries and the null byte all
   * mean nothing to it. Holds on both BusyBox and dash, on both backends.
   */
  private async stageByStdin(
    sshConfig: any,
    staging: string,
    content: Buffer,
    sudo?: boolean
  ): Promise<void> {
    await this.executor.executeChecked(sshConfig, `cat > ${shellQuote(staging)}`, {
      sudo,
      stdin: content,
    });
  }

  /** Fill the staging path via the transport: for large and binary content */
  private async stageByTransport(
    sshConfig: any,
    staging: string,
    content: Buffer,
    sudo?: boolean
  ): Promise<void> {
    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-write-'));
    const localFile = join(localDir, 'payload.bin');
    writeFileSync(localFile, content);

    try {
      const runner = await getRunner(sshConfig);

      if (!sudo) {
        await runner.upload(localFile, staging);
        return;
      }

      // Under sudo the transfer runs as the connecting user into /tmp, and the
      // copy appears next to the target already privileged. `install` does
      // not fit here: it copies over the target, destroying the old content
      // before the new one is written — exactly what this protocol forbids
      const handoff = buildSudoStagingPath();
      await runner.upload(localFile, handoff);
      try {
        await this.executor.executeChecked(
          sshConfig,
          `cp -- ${shellQuote(handoff)} ${shellQuote(staging)}`,
          { sudo: true }
        );
      } finally {
        await this.executor
          .execute(sshConfig, `rm -f -- ${shellQuote(handoff)}`, {})
          .catch(() => undefined);
      }
    } finally {
      try { rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Fetch the whole file and return base64.
   * Needed when binary=true: `cat` through a PTY corrupts bytes outside utf8.
   */
  private async readFileBinary(
    sshConfig: any,
    remotePath: string
  ): Promise<string> {
    const localDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-read-'));
    const localFile = join(localDir, 'payload.bin');
    try {
      const runner = await getRunner(sshConfig);
      await runner.download(remotePath, localFile);

      const data = await readFile(localFile);
      return data.toString('base64');
    } finally {
      try { rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Handle ssh_file_list
   */
  private async handleFileList(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as FileListArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const path = requireText(args.path, 'path', '"/var/log"');
    const target = await resolveRemotePath(this.executor, sshConfig, path, {});
    const safePath = shellQuote(target.path);

    let command = 'ls -lah';
    
    if (args.recursive) {
      command = 'ls -lRah';
    }
    
    if (args.pattern) {
      // The pattern must expand on the server, so it does not go into quotes:
      // everything except the pattern characters is neutralized with a backslash
      command += ` ${safePath}/${shellGlob(args.pattern, 'pattern')}`;
    } else {
      command += ` ${safePath}`;
    }
    
    const result = await this.executor.execute(sshConfig, command, {
      idempotent: true,
      signal,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list files: ${result.stderr || result.stdout}`);
    }

    return {
      content: [{ type: 'text', text: withTruncationNote(result.stdout, result.truncated) }],
    };
  }
  
  /**
   * File read command.
   *
   * The path arrives here already expanded and travels in single quotes —
   * the same way as for a write.
   */
  private buildReadCommand(path: string, encoding: string): string {
    return `${encoding === 'base64' ? 'base64' : 'cat'} ${shellQuote(path)}`;
  }
}
