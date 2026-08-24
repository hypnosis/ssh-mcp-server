/**
 * SSH File Tools
 * Tools for working with files on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { READS_REMOTE, WRITES_REMOTE } from './annotations.js';
import { PROFILE_PARAM_DESCRIPTION } from './params.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { batchOutcome, CallerError, toolFailure, type ToolResult } from '../utils/tool-result.js';
import {
  failedFile,
  mismatchedFile,
  FILES_OUTPUT_SCHEMA,
  filesSummary,
  OWNER_NEEDS_SUDO,
  writtenFile,
} from './transfer-output.js';
import {
  LIST_OUTPUT_SCHEMA,
  listSummary,
  type EntryType,
  type ListEntry,
  type ListSummary,
} from './file-output.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { getRunner } from '../runner/get-runner.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { sha256OfBuffer } from '../utils/sha256.js';
import {
  mismatchOf,
  verifyRemoteFiles,
  VerificationMismatchError,
} from '../managers/remote-verify.js';
import { install } from '../managers/installer.js';
import { remotePathOps } from '../managers/remote-path-ops.js';
import { resolveRemotePath, type ExpandedPath } from '../managers/path-guard.js';
import { buildSudoStagingPath } from '../utils/tmp-name.js';
import { shellMode, shellOwner, shellQuote } from '../utils/shell-arg.js';
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

/**
 * Markers that begin a record of a listing.
 *
 * A name may hold a newline, so records are cut by marker rather than by
 * line, and the name is printed last — everything before it has a fixed shape.
 */
const LIST_ENTRY_MARK = '__SSH_MCP_LS__';
const LIST_LINK_MARK = '__SSH_MCP_LN__';

/**
 * One walk of the directory, and a second one for the links.
 *
 * `ls` is not used at all: it rounds sizes, prints a year only for old files,
 * moves its columns between servers, and breaks a name with a newline into two
 * rows. `stat` answers the same fields on BusyBox and on coreutils.
 */
function listCommand(path: string, args: FileListArgs): string {
  const safePath = shellQuote(path);
  const depth = args.recursive ? '' : ' -maxdepth 1';
  // The pattern is matched by find, not expanded by the shell, so it travels
  // quoted: a name is a value here, and a value cannot become a second word
  const pattern = args.pattern
    ? ` -name ${shellQuote(requireText(args.pattern, 'pattern', '"*.conf"'))}`
    : '';
  // LC_ALL=C: the refusal message is read by its text, and a server in another
  // locale would answer the same refusal in words nothing here matches
  const walk = `LC_ALL=C find ${safePath} -mindepth 1${depth}${pattern}`;

  return (
    `${walk} -exec stat -c '${LIST_ENTRY_MARK}%s|%Y|%U|%G|%a|%F|%d:%i|%n' {} + ; ` +
    // A link answers against its device and inode rather than against its name:
    // the key never carries a newline, and both sides of the pair need one
    `${walk} -type l -exec stat -c '${LIST_LINK_MARK}%d:%i' {} \\; -exec readlink -- {} \\;`
  );
}

/** What the kind word from `stat -c %F` means for a caller */
function entryType(kind: string): EntryType {
  if (kind === 'directory') return 'dir';
  if (kind === 'symbolic link') return 'symlink';
  // coreutils calls an empty file "regular empty file" and a filled one
  // "regular file": one prefix answers for both
  if (kind.startsWith('regular')) return 'file';
  return 'other';
}

/** Records of one listing, each with the marker that opened it */
function listRecords(stdout: string): Array<{ mark: string; body: string }> {
  const records: Array<{ mark: string; body: string }> = [];

  for (const chunk of stdout.split(new RegExp(`(?=${LIST_ENTRY_MARK}|${LIST_LINK_MARK})`))) {
    for (const mark of [LIST_ENTRY_MARK, LIST_LINK_MARK]) {
      if (chunk.startsWith(mark)) {
        // Exactly one trailing newline goes: it is the one stat printed, and
        // any others belong to the name or to the link target
        records.push({ mark, body: chunk.slice(mark.length).replace(/\n$/, '') });
      }
    }
  }

  return records;
}

/**
 * Entries of a listing, sorted by name.
 *
 * `find` answers in the order the directory happens to hold, and two calls on
 * the same directory would then disagree with each other for no reason.
 */
function parseListEntries(stdout: string, base: string): ListEntry[] {
  const targets = new Map<string, string>();
  const entries: ListEntry[] = [];
  const prefix = base.endsWith('/') ? base : `${base}/`;

  for (const { mark, body } of listRecords(stdout)) {
    if (mark !== LIST_LINK_MARK) continue;
    const newline = body.indexOf('\n');
    if (newline !== -1) targets.set(body.slice(0, newline), body.slice(newline + 1));
  }

  for (const { mark, body } of listRecords(stdout)) {
    if (mark !== LIST_ENTRY_MARK) continue;

    const fields = body.split('|');
    if (fields.length < 8) continue;

    const [size, mtime, owner, group, mode, kind, key] = fields;
    const path = fields.slice(7).join('|');
    const type = entryType(kind);

    entries.push({
      name: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      type,
      size: parseInt(size, 10) || 0,
      mode,
      owner,
      group,
      mtime: parseInt(mtime, 10) || 0,
      target: type === 'symlink' ? targets.get(key) ?? null : null,
    });
  }

  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Paths the walk was turned away from, with the reason the server gave.
 *
 * The message differs between servers — coreutils quotes the path, BusyBox
 * does not — and a listing missing exactly the interesting directory reads as
 * a complete one.
 */
function parseRefusals(stderr: string): Array<{ path: string; reason: string }> {
  const refusals: Array<{ path: string; reason: string }> = [];

  for (const line of stderr.split('\n')) {
    const match = line.match(/^find: '?(.+?)'?: (.+)$/);
    if (match) refusals.push({ path: match[1], reason: match[2] });
  }

  return refusals;
}

/** Seconds since epoch as a date a person reads, in UTC */
function listTime(mtime: number): string {
  return new Date(mtime * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

/** The listing for reading: the same fields the structure carries, in columns */
function formatListing(summary: ListSummary): string {
  const lines = [`${summary.path} — ${summary.entries.length} entr${summary.entries.length === 1 ? 'y' : 'ies'}`];
  const width = (pick: (entry: ListEntry) => string) =>
    Math.max(0, ...summary.entries.map((entry) => pick(entry).length));
  const ownerWidth = width((entry) => `${entry.owner}:${entry.group}`);
  const sizeWidth = width((entry) => String(entry.size));

  if (summary.entries.length > 0) lines.push('');

  for (const entry of summary.entries) {
    const owner = `${entry.owner}:${entry.group}`.padEnd(ownerWidth);
    const size = String(entry.size).padStart(sizeWidth);
    const tail = entry.type === 'dir' ? '/' : entry.target !== null ? ` -> ${entry.target}` : '';

    lines.push(`${entry.mode.padStart(4)}  ${owner}  ${size}  ${listTime(entry.mtime)}  ${entry.name}${tail}`);
  }

  if (summary.unreadable.length > 0) {
    lines.push('', 'NOT READ:');
    for (const refusal of summary.unreadable) lines.push(`  - ${refusal}`);
  }

  return lines.join('\n');
}

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

/**
 * One entry of ssh_file_write, described once for both shapes the tool takes.
 *
 * A single file and a list of them are the same entry; written twice, the two
 * copies drift and the list ends up the poorer of the pair.
 */
const fileEntry = {
  path: { type: 'string', description: 'Where the file goes.' },
  content: {
    type: 'string',
    description:
      'The whole new content, written byte for byte. Replaces the file, never extends it; no ' +
      'trailing newline is added.',
  },
  mode: {
    type: 'string',
    description: 'Octal string, "644", for this file alone. Applied before the file takes its place.',
  },
  sudo: {
    type: 'boolean',
    description:
      'Write as root, for this file alone — /etc and anywhere the profile user cannot write. Default: false',
  },
  owner: {
    type: 'string',
    description:
      '"root:root", for this file alone. Set before the file takes its place. Needs sudo; ' +
      'without it the answer says it was not applied.',
  },
  verify: {
    type: 'boolean',
    description:
      'Compare sha256 before the file takes its place. A mismatch fails the call and ' +
      'leaves the path as it was. Default: true',
  },
  binary: {
    type: 'boolean',
    description: 'content is base64, decoded before writing. Default: false',
  },
} as const;

/** ssh_file_list arguments, matching its inputSchema */
interface FileListArgs {
  profile?: string;
  path?: unknown;
  pattern?: unknown;
  recursive?: boolean;
  sudo?: boolean;
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
          'Reads text files from a server, several of them in one call. A file it could not read is named ' +
          'with the reason, never returned empty or cut short as if that were the content. To look for ' +
          'something inside logs rather than read them, ssh_log_search greps on the server.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: PROFILE_PARAM_DESCRIPTION,
            },
            path: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description:
                'One path, or a list: ["/etc/hosts", "/etc/resolv.conf"]. An unreadable file costs the ' +
                'list nothing — the others still come back.',
            },
            encoding: {
              type: 'string',
              enum: ['utf8', 'base64'],
              description:
                'base64 keeps non-text bytes intact but still goes through the command channel and its ' +
                'size limit. Real binary -> binary below. Default: utf8',
              default: 'utf8',
            },
            binary: {
              type: 'boolean',
              description:
                'Fetch over the transport, not the command channel; answer in base64. The safe way for ' +
                'non-text, implies encoding=base64. Default: false',
              default: false,
            },
            sudo: {
              type: 'boolean',
              description: 'Read as root, for files the profile user cannot open. Default: false',
              default: false,
            },
          },
          required: ['profile', 'path'],
        },
      },
      
      // ssh_file_write
      {
        name: 'ssh_file_write',
        annotations: { title: 'Write a remote file', ...WRITES_REMOTE },
        description:
          'Writes text files on a server, several in one call, each with its own path, permissions, ' +
          'owner and sudo. A file is replaced whole and never appears half-written; there is no append. For ' +
          'something that already exists on this machine, use ssh_upload.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: PROFILE_PARAM_DESCRIPTION,
            },
            files: {
              oneOf: [
                { type: 'object', properties: fileEntry, required: ['path', 'content'] },
                {
                  type: 'array',
                  items: { type: 'object', properties: fileEntry, required: ['path', 'content'] },
                },
              ],
              description:
                'One file, or a list — mode and sudo decided per file, not per call.',
            },
          },
          required: ['profile', 'files'],
        },
        outputSchema: FILES_OUTPUT_SCHEMA,
      },
      
      // ssh_file_list
      {
        name: 'ssh_file_list',
        annotations: { title: 'List a remote directory', ...READS_REMOTE },
        description:
          'Lists a directory on a server: every entry with its size, mode, owner and modification time, ' +
          'as fields. A directory it was not allowed to enter is named rather than left out, and a ' +
          'listing cut short by the output limit says so. To see what is inside a file, use ssh_file_read.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: PROFILE_PARAM_DESCRIPTION,
            },
            path: {
              type: 'string',
              description: 'Directory to list.',
            },
            pattern: {
              type: 'string',
              description: 'Glob matched on the machine: "*.conf". Without it every entry comes back.',
            },
            recursive: {
              type: 'boolean',
              description:
                'Descend into subdirectories. A deep tree is cut at the output limit and says so. Default: false',
              default: false,
            },
            sudo: {
              type: 'boolean',
              description: 'List as root, for directories the profile user cannot open. Default: false',
              default: false,
            },
          },
          required: ['profile', 'path'],
        },
        outputSchema: LIST_OUTPUT_SCHEMA,
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
          throw new CallerError(`Unknown tool: ${toolName}`);
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
      let written: Awaited<ReturnType<FileTools['writeFileRouted']>>;
      try {
        written = await this.writeFileRouted(sshConfig, file, target);
      } catch (error: any) {
        // One file answers with the same summary a batch does: the outcome of
        // the only file would otherwise be readable from the text alone
        const failure = toolFailure(error);
        const mismatch = mismatchOf(error);
        failure.structuredContent = filesSummary([
          mismatch
            ? mismatchedFile(mismatch.path, mismatch.message)
            : failedFile(target.path, error.message),
        ]);
        return failure;
      }

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
        structuredContent: filesSummary([
          writtenFile(written.path, written.verification, this.contentBytes(file)),
        ]),
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
      /** The write reached the server and came back different */
      mismatched?: boolean;
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
          mismatched: !!mismatchOf(error),
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
    answer.structuredContent = filesSummary(
      results.map((result) => {
        if (result.success && result.verification) {
          return writtenFile(result.path, result.verification, result.bytesWritten);
        }
        const reason = result.error ?? 'write failed';
        return result.mismatched
          ? mismatchedFile(result.path, reason)
          : failedFile(result.path, reason);
      })
    );

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
      owner?: string;
      verify?: boolean;
      binary?: boolean;
    },
    /** Expanded destination path, already checked against the rules */
    target: ExpandedPath
  ): Promise<{ path: string; warnings: string[]; verification: VerificationOutcome }> {
    const buf = file.binary
      ? Buffer.from(file.content || '', 'base64')
      : Buffer.from(file.content || '', 'utf8');

    // Mode and owner are validated before the first command: a refusal halfway
    // through would leave behind a staging path and a write nobody asked for
    const mode = file.mode ? shellMode(file.mode, 'mode') : undefined;
    const owner = file.owner ? shellOwner(file.owner, 'owner') : undefined;

    const expectedHash = sha256OfBuffer(buf);
    // The verification outcome travels into the response: without it,
    // "matched" and "nothing to verify with" both look to the client like an
    // equally successful write
    let verification: VerificationOutcome = { status: 'skipped' };
    /** A named owner that chown could not take: the file lands anyway, and silence would hide it */
    let ownerWarnings: string[] = [];
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
        if (file.verify === false) return null;

        const result = await verifyRemoteFiles(
          this.executor,
          sshConfig,
          [{ path: staging, hash: expectedHash }],
          { sudo: file.sudo }
        );

        if (result.status === 'mismatched') {
          // Thrown rather than returned as a reason: the outcome has a word of
          // its own in the answer, and a plain reason arrives as "not checked"
          throw new VerificationMismatchError(
            `what landed at ${target.path} differs from what was sent ` +
              `(local sha256 ${expectedHash})`,
            target.path,
            1,
            1
          );
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
        if (mode) {
          await this.executor.executeChecked(
            sshConfig,
            `chmod ${mode} -- ${shellQuote(staging)}`,
            { sudo: file.sudo }
          );
        }

        if (!owner) return;

        // Under a regular user chown refuses any name but its own, and a
        // dropped owner is visible only in `ls -l` on the server
        if (!file.sudo) {
          ownerWarnings = [OWNER_NEEDS_SUDO];
          return;
        }

        await this.executor.executeChecked(
          sshConfig,
          `chown ${owner} -- ${shellQuote(staging)}`,
          { sudo: true }
        );
      },
    });

    return {
      path: outcome.path,
      warnings: [...target.warnings, ...outcome.warnings, ...ownerWarnings],
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

    const sudo = args.sudo === true;
    const path = requireText(args.path, 'path', '"/var/log"');
    const target = await resolveRemotePath(this.executor, sshConfig, path, { sudo });

    // The tilde under sudo leads to the login user's home rather than root's,
    // and the path guard says so — the listing must not swallow that
    for (const warning of target.warnings) logger.warn(`[file-tools] ${warning}`);

    const result = await this.executor.execute(sshConfig, listCommand(target.path, args), {
      sudo,
      idempotent: true,
      signal,
    });

    const entries = parseListEntries(result.stdout, target.path);
    const refusals = parseRefusals(result.stderr);

    // A refusal at the door of the directory that was asked for leaves nothing
    // to answer with; one met inside the walk leaves everything else, and that
    // is a listing with a hole in it rather than a failed call
    const atTheDoor = refusals.filter((refusal) => refusal.path === target.path);
    if (result.exitCode !== 0 && entries.length === 0 && (atTheDoor.length > 0 || refusals.length === 0)) {
      throw new Error(`Failed to list files: ${result.stderr || result.stdout}`);
    }

    // The walk runs twice — once for the fields, once for the link targets —
    // and one closed directory turns them away both times: a single hole must
    // not be counted as two
    const unreadable = [
      ...new Set(
        refusals
          .filter((refusal) => refusal.path !== target.path)
          .map((refusal) => `${refusal.path}: ${refusal.reason}`)
      ),
    ];

    const summary = listSummary(target.path, entries, unreadable, result.truncated === true);

    return {
      content: [{ type: 'text', text: withTruncationNote(formatListing(summary), result.truncated) }],
      structuredContent: summary,
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
