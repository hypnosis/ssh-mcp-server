/**
 * SSH Log Tools
 * Tools for working with logs on remote server
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { READS_REMOTE } from './annotations.js';
import { PROFILE_PARAM_DESCRIPTION, SUDO_PARAM_DESCRIPTION } from './params.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor, DEFAULT_TIMEOUT_MS } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import {
  TRUNCATED_OUTPUT_NOTE,
  withTruncationNote,
  DEFAULT_MAX_MATCHES,
  limitMatches,
  matchLimitNote,
  unreadablePath,
} from '../utils/output-notes.js';
import { shellCount, shellQuote } from '../utils/shell-arg.js';
import { requireText, requireTextList } from '../utils/tool-args.js';
import { resolveRemotePath } from '../managers/path-guard.js';
import { posix as posixPath } from 'path';

/** Lines that carry something, as the answer counts them */
function countLines(text: string): number {
  return text ? text.split('\n').filter((line) => line.length > 0).length : 0;
}

/** Characters that make a name count as a pattern instead of a file name */
const GLOB_CHARS = /[*?[]/;

/** How many files a pattern expands to at once */
const MAX_GLOB_MATCHES = 50;

/** Response marker: the path exists under its own name, there is nothing to expand */
const GLOB_LITERAL = 'SSH_MCP_GLOB_LITERAL';

/** ssh_log_tail / ssh_log_search arguments, matching their inputSchema */
interface LogArgs {
  profile?: string;
  path?: unknown;
  lines?: number;
  sudo?: boolean;
  query?: unknown;
  context?: number;
  caseSensitive?: boolean;
  maxMatches?: number;
  recursive?: boolean;
  from?: unknown;
  namesOnly?: boolean;
  since?: unknown;
  timeout?: number;
}

/**
 * What ssh_log_search reports beside the lines themselves.
 *
 * Every field here answers the same question: is an empty answer empty
 * because there was nothing, or because something was not read. A count of
 * zero next to an unread file is the one reading this shape prevents.
 */
interface SearchOutcome {
  matches: number;
  files_searched: number;
  files_unreadable: string[];
  files_skipped: number;
  files_undated: string[];
  limited: boolean;
  truncated: boolean;
}

const SEARCH_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    matches: {
      type: 'number',
      description:
        'Lines in the answer — matches plus any context lines; with namesOnly, matching files.',
    },
    files_searched: { type: 'number' },
    files_unreadable: {
      type: 'array',
      items: { type: 'string' },
      description: 'Opened with an error — not proof the text is absent.',
    },
    files_skipped: {
      type: 'number',
      description: 'Left unread by the since window.',
    },
    files_undated: {
      type: 'array',
      items: { type: 'string' },
      description: 'No recognisable timestamp: searched whole, the window was not applied.',
    },
    limited: {
      type: 'boolean',
      description: 'maxMatches was reached — more exist than are shown.',
    },
    truncated: {
      type: 'boolean',
      description: 'Output was cut mid-answer: incomplete, not empty.',
    },
  },
  required: [
    'matches',
    'files_searched',
    'files_unreadable',
    'files_skipped',
    'files_undated',
    'limited',
    'truncated',
  ],
};


/**
 * Timestamp shapes a log line is likely to carry.
 *
 * Three cover nearly everything written by hand or by a library: ISO
 * (2026-08-19), syslog (Aug 19) and the Apache/nginx access log
 * (19/Aug/2026). A line with none of them cannot be dated, and that is said
 * out loud rather than counted as "not today".
 */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Anything that looks like a date at all — used to tell "no timestamp" from "another day" */
const ANY_TIMESTAMP =
  '[0-9]{4}-[0-9]{2}-[0-9]{2}|[A-Z][a-z]{2} +[0-9]{1,2}|[0-9]{2}/[A-Z][a-z]{2}/[0-9]{4}';

/** How many days back a line filter is still worth building */
const MAX_DATED_DAYS = 31;

/** What `since` asked for, once the server has said what day it is */
interface SinceWindow {
  /** Files untouched for longer than this are not searched at all */
  minutes: number;
  /** Dates whose lines are kept; empty means the window is shorter than a day */
  days: string[];
}

/**
 * Read `since` into minutes and, where it makes sense, into whole days.
 *
 * A window measured in hours has no line filter: a log line carries a date,
 * but "the last two hours" cannot be told from a date alone, and pretending
 * otherwise would drop today's older lines without saying so.
 */
function parseSince(value: unknown, today: string): SinceWindow {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`since must be "today", a date like "2026-08-19", or an age like "2h" — got ${JSON.stringify(value)}`);
  }

  const text = value.trim();
  // A day back rather than "since midnight": a wider net costs one extra
  // file to read, a narrower one loses lines written just before midnight
  if (text === 'today') return { minutes: 24 * 60, days: [today] };

  const age = /^([0-9]+)([mhd])$/.exec(text);
  if (age) {
    const amount = Number(age[1]);
    if (amount === 0) throw new Error('since must name a window longer than zero');
    const minutes = age[2] === 'm' ? amount : age[2] === 'h' ? amount * 60 : amount * 24 * 60;
    return { minutes, days: age[2] === 'd' ? daysBack(today, amount) : [] };
  }

  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) {
    throw new Error(`since must be "today", a date like "2026-08-19", or an age like "2h" — got ${JSON.stringify(value)}`);
  }

  const spanDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${text}T00:00:00Z`)) / 86400000) + 1;
  if (spanDays < 1) throw new Error(`since names a day in the future: ${text}`);

  return {
    minutes: spanDays * 24 * 60,
    days: spanDays <= MAX_DATED_DAYS ? daysBack(today, spanDays) : [],
  };
}

/** The last N days, newest first, as YYYY-MM-DD */
function daysBack(today: string, count: number): string[] {
  const start = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(start - index * 86400000).toISOString().slice(0, 10)
  );
}

/** One day in every shape a log might write it */
function timestampAlternatives(days: string[]): string {
  return days
    .flatMap((day) => {
      const [year, month, dayOfMonth] = day.split('-');
      const monthName = MONTH_NAMES[Number(month) - 1];
      const bare = String(Number(dayOfMonth));
      return [day, `${monthName} +0?${bare}`, `${dayOfMonth}/${monthName}/${year}`];
    })
    .join('|');
}

/** Which end of the file the capped matches are taken from */
type MatchEnd = 'start' | 'end';

/**
 * The end the caller asked for, defaulting to the newest matches.
 *
 * A log is read from its end: capped from the start, a search for today's
 * errors answers with January's and calls it a full answer.
 */
function readMatchEnd(value: unknown): MatchEnd {
  if (value === undefined || value === null) return 'end';
  if (value === 'start' || value === 'end') return value;
  throw new Error(`from must be "start" or "end", got ${JSON.stringify(value)}`);
}

/**
 * Log Tools
 */
export class LogTools {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool descriptions for MCP
   */
  getTools(): Tool[] {
    // Both tools take the same file list and the same privilege, and the glob
    // rule has to be said wherever a path is accepted
    const PATH_PARAM = {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
      description:
        'One path, a list, or a glob in the file name: "/var/log/*.log". Expanded by the server\'s ' +
        'find, not a shell — a name with a space or a newline stays one name. A glob in the ' +
        'directory part is refused.',
    };

    const SUDO_PARAM = {
      type: 'boolean',
      description: SUDO_PARAM_DESCRIPTION,
      default: false,
    };

    return [
      // ssh_log_tail
      {
        name: 'ssh_log_tail',
        annotations: { title: 'Tail a log file', ...READS_REMOTE },
        description:
          'Last lines of file(s). path (list | glob), lines, sudo. File size irrelevant. Looking for something -> ssh_log_search.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: PROFILE_PARAM_DESCRIPTION,
            },
            path: PATH_PARAM,
            lines: {
              type: 'number',
              description: 'How many lines from the end. Default: 100',
              default: 100,
            },
            sudo: SUDO_PARAM,
          },
          required: ['profile', 'path'],
        },
      },
      
      // ssh_log_search
      {
        name: 'ssh_log_search',
        annotations: { title: 'Search log files', ...READS_REMOTE },
        description:
          'grep on the server. path (list | glob | tree), query, since:today, from:end, namesOnly, recursive. Empty = no match; unreadable files listed apart.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: {
              type: 'string',
              description: PROFILE_PARAM_DESCRIPTION,
            },
            path: PATH_PARAM,
            query: {
              type: 'string',
              description: 'Regex, grep -E dialect.',
            },
            context: {
              type: 'number',
              description: 'Lines around each match, as grep -C. Excluded by namesOnly. Default: 0',
              default: 0,
            },
            caseSensitive: {
              type: 'boolean',
              description: 'false = case ignored. Default: false',
              default: false,
            },
            recursive: {
              type: 'boolean',
              description:
                'Walk the whole tree, not one level. With a glob: "/etc/nginx/*.conf" reaches those ' +
                'at any depth. Symlinked files are searched, symlinked dirs not descended. Default: false',
              default: false,
            },
            namesOnly: {
              type: 'boolean',
              description:
                'Answer = matching paths, no line bodies. One command for the whole list; maxMatches ' +
                'and context do not apply. Default: false',
              default: false,
            },
            since: {
              type: 'string',
              description:
                'Window: "today" | "2026-08-19" | "2h" | "3d", the day taken from the server. Skips ' +
                'files untouched in it (count reported), then keeps only lines dated inside — ' +
                '2026-08-19, Aug 19, 19/Aug/2026. Undated file: searched whole and named. Under a ' +
                'day filters files, not lines.',
            },
            from: {
              type: 'string',
              enum: ['start', 'end'],
              description:
                'Which end maxMatches keeps: "end" newest (scans the whole file), "start" oldest ' +
                '(stops reading at the cap). Default: end',
              default: 'end',
            },
            maxMatches: {
              type: 'number',
              description:
                `Cap per file; reaching it is reported. Default: ${DEFAULT_MAX_MATCHES}`,
              default: DEFAULT_MAX_MATCHES,
            },
            timeout: {
              type: 'number',
              description:
                `Milliseconds per file, default ${DEFAULT_TIMEOUT_MS}. Raise for multi-gigabyte ` +
                'files with from: "end".',
              default: DEFAULT_TIMEOUT_MS,
            },
            sudo: SUDO_PARAM,
          },
          required: ['profile', 'path', 'query'],
        },
        outputSchema: SEARCH_OUTPUT_SCHEMA,
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
        case 'ssh_log_tail':
          return await this.handleLogTail(request, signal);
        case 'ssh_log_search':
          return await this.handleLogSearch(request, signal);
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return toolFailure(error);
    }
  }
  
  /**
   * Handle ssh_log_tail
   */
  private async handleLogTail(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as LogArgs;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const requested = requireTextList(args.path, 'path', '"/var/log/syslog"');
    // The schema's type guarantees nothing: MCP hands over arguments as is
    const lines = shellCount(args.lines ?? 100, 'lines');
    const sudo = args.sudo || false;

    // Profile rules are checked by buildSafePath — already on the expanded path
    const { paths, notes } = await this.expandPatterns(sshConfig, requested, sudo);

    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, paths[0], sudo);
      const command = `tail -n ${lines} ${safePath}`;
      const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true, signal });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read log: ${result.stderr || result.stdout}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: this.withGlobNotes(
              withTruncationNote(result.stdout || '(empty log)', result.truncated),
              notes
            ),
          },
        ],
      };
    }

    // Multiple logs - structured result
    const results: Array<{
      path: string;
      lines: string[];
      totalLines: number;
      success: boolean;
      truncated?: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = await this.buildSafePath(sshConfig, path, sudo);
        const command = `tail -n ${lines} ${safePath}`;
        const result = await this.executor.execute(sshConfig, command, { sudo, idempotent: true, signal });
        
        if (result.exitCode === 0) {
          const logLines = result.stdout.split('\n').filter(line => line.length > 0);
          results.push({
            path,
            lines: logLines,
            totalLines: logLines.length,
            success: true,
            truncated: result.truncated,
          });
        } else {
          results.push({
            path,
            lines: [],
            totalLines: 0,
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
          lines: [],
          totalLines: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Tail ${results.length} logs (last ${lines} lines):\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `=== ${result.path} (${result.totalLines} lines) ===\n`;
        output += result.lines.join('\n') + '\n';
        if (result.truncated) output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        output += '\n';
      } else {
        output += `=== ${result.path} (ERROR) ===\n`;
        output += `Error: ${result.error}\n\n`;
      }
    }

    return {
      content: [{ type: 'text', text: this.withGlobNotes(output, notes) }],
    };
  }

  /**
   * Handle ssh_log_search
   */
  private async handleLogSearch(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as LogArgs;
    
    // Validate array parameter format
    const validation = validateArrayParameter(args.path, 'path');
    if (!validation.isValid) {
      return createValidationErrorResponse(validation.errorMessage!);
    }
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    const requested = requireTextList(args.path, 'path', '"/var/log/syslog"');
    const query = requireText(args.query, 'query', '"error"');
    const context = shellCount(args.context ?? 0, 'context');
    const caseSensitive = args.caseSensitive || false;
    const maxMatches = shellCount(args.maxMatches ?? DEFAULT_MAX_MATCHES, 'maxMatches');
    const sudo = args.sudo || false;
    const from = readMatchEnd(args.from);
    const namesOnly = args.namesOnly === true;
    const timeout = args.timeout;

    if (namesOnly && context > 0) {
      throw new Error(
        'namesOnly and context cannot be combined: naming the files leaves no lines to show ' +
          'context around. Drop one of the two.'
      );
    }

    // Profile rules are checked by buildSafePath — already on the expanded path
    const expansion = await this.expandPatterns(
      sshConfig,
      requested,
      sudo,
      args.recursive === true
    );
    const notes = expansion.notes;
    // Directories find could not walk are unreadable in the same sense as a
    // file grep could not open, and travel in the same field
    const refusedDirs = expansion.unreadable;
    let paths = expansion.paths;

    // A time window narrows the work twice: files nobody wrote to are not
    // read at all, and in the rest only lines carrying a matching date are
    // kept. Both halves are reported, because a file dropped in silence is
    // indistinguishable from a file with nothing in it
    let dateFilter = '';
    let datedFiles = new Set<string>();
    let filesSkipped = 0;
    let filesUndated: string[] = [];
    if (args.since !== undefined) {
      const window = parseSince(args.since, await this.serverToday(sshConfig, sudo));
      const { fresh, unchecked } = await this.changedWithin(sshConfig, paths, window.minutes, sudo);

      filesSkipped = paths.length - fresh.length - unchecked.length;
      if (filesSkipped > 0) {
        notes.push(
          `Note: ${filesSkipped} of ${paths.length} file(s) were not touched within ` +
            `the window and were not searched.`
        );
      }
      if (unchecked.length > 0) {
        notes.push(
          `Note: the time of ${unchecked.join(', ')} could not be read, so the window was not ` +
            `applied there — searched anyway rather than dropped.`
        );
      }
      paths = [...fresh, ...unchecked];

      if (window.days.length > 0 && paths.length > 0) {
        const dated = await this.filesWithTimestamps(sshConfig, paths, sudo);
        const undated = paths.filter((path) => !dated.has(path));
        filesUndated = undated;
        if (undated.length > 0) {
          notes.push(
            `Note: no recognisable timestamp in ${undated.join(', ')} — searched in full, the time ` +
              `window was not applied there.`
          );
        }
        // The filter is built once for the whole call, but applied only to
        // the files that can answer it
        if (dated.size > 0) dateFilter = timestampAlternatives(window.days);
        paths = [...paths].sort((left, right) => Number(dated.has(right)) - Number(dated.has(left)));
        datedFiles = dated;
      }
    }

    // Build grep flags
    const grepFlags: string[] = [];
    grepFlags.push('-E'); // Extended regex
    if (!caseSensitive) grepFlags.push('-i'); // Case insensitive
    if (context > 0) grepFlags.push(`-C ${context}`); // Context lines
    grepFlags.push('-n'); // Line numbers

    // Only the oldest matches can be capped by grep itself. For the newest
    // ones grep has to read the whole file and the tail is taken after it —
    // the cap then travels as a line count, so it has to allow for the
    // context lines each match brings with it
    if (from === 'start') grepFlags.push(`-m ${maxMatches + 1}`);
    const tailLines = (maxMatches + 1) * (2 * context + 1);

    /**
     * One file's search, as it goes to the server.
     *
     * With a time window the line numbers have to come from the first grep —
     * the date filter runs after it, so numbering there would count the
     * surviving lines instead of the ones in the file.
     */
    const searchCommand = (safePath: string, dated: boolean): string => {
      const flags = dateFilter && dated ? grepFlags.filter((flag) => !flag.startsWith('-m ')) : grepFlags;
      const base = `grep ${flags.join(' ')} ${shellQuote(query)} ${safePath}`;
      const filtered = dateFilter && dated ? `${base} | grep -E ${shellQuote(dateFilter)}` : base;

      if (from === 'start') {
        return filtered === base ? base : `${filtered} | head -n ${tailLines}`;
      }
      return `${filtered} | tail -n ${tailLines}`;
    };

    /**
     * Whether the answer is a failure rather than "nothing matched".
     *
     * Through a pipe the exit code belongs to `tail`, which succeeds even
     * when grep could not open the file. What is left to judge by is the
     * pair: grep prints nothing on failure and says why on stderr.
     */
    const searchFailed = (result: { exitCode: number; stdout: string; stderr: string }): boolean =>
      from === 'start' && !dateFilter
        ? result.exitCode !== 0 && result.exitCode !== 1
        : !result.stdout && result.stderr.trim().length > 0;
    
    // Names only: every file goes into one command, because the answer is a
    // list of paths — asking file by file would be one round trip per file
    // for a question that fits in a single one
    if (namesOnly) {
      const safePaths: string[] = [];
      for (const path of paths) safePaths.push(await this.buildSafePath(sshConfig, path, sudo));

      const command = `grep -l ${caseSensitive ? '-E' : '-iE'} ${shellQuote(query)} ${safePaths.join(' ')}`;
      const result = await this.executor.execute(sshConfig, command, {
        sudo,
        idempotent: true,
        signal,
        timeout,
      });

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Failed to search log: ${result.stderr || result.stdout}`);
      }

      const found = result.stdout.split('\n').filter((line) => line.trim().length > 0);
      // A file that could not be read is named on stderr and is neither a
      // match nor a silent absence: without this line an unreadable file
      // would read as "the text is not in there"
      const unreadable = result.stderr.trim();
      const unreadableFiles = unreadable ? unreadable.split('\n').map(unreadablePath) : [];

      return {
        content: [
          {
            type: 'text',
            text: this.withGlobNotes(
              [
                found.length > 0 ? found.join('\n') : 'No files contain that',
                unreadable ? `\nNot searched:\n${unreadable}` : '',
                result.truncated ? `\n${TRUNCATED_OUTPUT_NOTE}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              notes
            ),
          },
        ],
        structuredContent: {
          matches: found.length,
          files_searched: paths.length - unreadableFiles.length,
          files_unreadable: [...refusedDirs, ...unreadableFiles],
          files_skipped: filesSkipped,
          files_undated: filesUndated,
          // Only whole files are named here, so there is no per-file cap to hit
          limited: false,
          truncated: result.truncated,
        } satisfies SearchOutcome,
      };
    }

    // Single log - simple result
    if (paths.length === 1) {
      const safePath = await this.buildSafePath(sshConfig, paths[0], sudo);
      const command = searchCommand(safePath, datedFiles.has(paths[0]));
      const result = await this.executor.execute(sshConfig, command, {
        sudo,
        idempotent: true,
        signal,
        timeout,
      });

      // grep exit code 1 = no matches (not an error)
      if (searchFailed(result)) {
        throw new Error(`Failed to search log: ${result.stderr || result.stdout}`);
      }

      const outcome = (found: number, limited: boolean): SearchOutcome => ({
        matches: found,
        files_searched: 1,
        files_unreadable: refusedDirs,
        files_skipped: filesSkipped,
        files_undated: filesUndated,
        limited,
        truncated: result.truncated,
      });

      if (!result.stdout) {
        return {
          content: [{ type: 'text', text: this.withGlobNotes('No matches found', notes) }],
          structuredContent: outcome(0, false),
        };
      }

      const limited = limitMatches(result.stdout, maxMatches, from);

      return {
        content: [
          {
            type: 'text',
            text: this.withGlobNotes(
              limited.limited
                ? `${withTruncationNote(limited.text, result.truncated)}\n\n${matchLimitNote(maxMatches)}`
                : withTruncationNote(limited.text, result.truncated),
              notes
            ),
          },
        ],
        structuredContent: outcome(countLines(limited.text), limited.limited),
      };
    }

    // Multiple logs - structured result
    const results: Array<{
      path: string;
      matches: string;
      matchCount: number;
      success: boolean;
      truncated?: boolean;
      limited?: boolean;
      error?: string;
    }> = [];
    
    for (const path of paths) {
      try {
        const safePath = await this.buildSafePath(sshConfig, path, sudo);
        const command = searchCommand(safePath, datedFiles.has(path));
        const result = await this.executor.execute(sshConfig, command, {
          sudo,
          idempotent: true,
          signal,
          timeout,
        });

        // grep exit code 1 = no matches
        if (!searchFailed(result)) {
          const limited = limitMatches(result.stdout, maxMatches, from);
          const matchCount = countLines(limited.text);
          results.push({
            path,
            matches: limited.text || '(no matches)',
            matchCount,
            success: true,
            truncated: result.truncated,
            limited: limited.limited,
          });
        } else {
          results.push({
            path,
            matches: '',
            matchCount: 0,
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
          matches: '',
          matchCount: 0,
          success: false,
          error: error.message,
        });
      }
    }
    
    // Format output
    let output = `Search in ${results.length} logs (query: "${query}"):\n\n`;
    
    for (const result of results) {
      if (result.success) {
        output += `=== ${result.path} (${result.matchCount} matches) ===\n`;
        output += result.matches + '\n';
        if (result.truncated) output += `${TRUNCATED_OUTPUT_NOTE}\n`;
        if (result.limited) output += `${matchLimitNote(maxMatches)}\n`;
        output += '\n';
      } else {
        output += `=== ${result.path} (ERROR) ===\n`;
        output += `Error: ${result.error}\n\n`;
      }
    }

    const failed = results.filter((result) => !result.success);

    return {
      content: [{ type: 'text', text: this.withGlobNotes(output, notes) }],
      structuredContent: {
        matches: results.reduce((total, result) => total + result.matchCount, 0),
        files_searched: results.length - failed.length,
        files_unreadable: [...refusedDirs, ...failed.map((result) => result.path)],
        files_skipped: filesSkipped,
        files_undated: filesUndated,
        limited: results.some((result) => result.limited === true),
        truncated: results.some((result) => result.truncated === true),
      } satisfies SearchOutcome,
    };
  }

  /**
   * The server's own date, asked rather than assumed.
   *
   * "Today" belongs to the machine holding the logs: it may sit in another
   * timezone, and a day taken from here would search the wrong one.
   */
  private async serverToday(sshConfig: any, sudo: boolean): Promise<string> {
    const result = await this.executor.execute(sshConfig, 'date +%Y-%m-%d', {
      sudo,
      idempotent: true,
    });
    const day = result.stdout.trim();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) {
      throw new Error(
        `cannot apply since: the server did not report a usable date (${result.stderr.trim() || day || 'no answer'})`
      );
    }
    return day;
  }

  /**
   * Of the given files, the ones written to inside the window — and the ones
   * whose time could not be read at all.
   *
   * The two are kept apart on purpose. A file find could not look at is not
   * an old file: dropping it here would send it out as "not touched within
   * the window", and a closed directory would read as a quiet log. Whatever
   * could not be checked stays in the search, where an unreadable file is
   * named for what it is.
   */
  private async changedWithin(
    sshConfig: any,
    paths: string[],
    minutes: number,
    sudo: boolean
  ): Promise<{ fresh: string[]; unchecked: string[] }> {
    if (paths.length === 0) return { fresh: paths, unchecked: [] };

    const result = await this.executor.execute(
      sshConfig,
      `find ${paths.map((path) => shellQuote(path)).join(' ')} -maxdepth 0 -mmin -${minutes} -print0`,
      { sudo, idempotent: true }
    );

    // An answer that was cut off cannot be used to drop files: the missing
    // tail would look exactly like "nothing was written there"
    if (result.truncated) return { fresh: paths, unchecked: [] };

    const found = new Set(result.stdout.split('\0').filter((name) => name.length > 0));
    const complained = new Set(
      result.stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map(unreadablePath)
    );

    return {
      fresh: paths.filter((path) => found.has(path)),
      unchecked: paths.filter((path) => !found.has(path) && complained.has(path)),
    };
  }

  /** Of the given files, the ones whose lines carry a date at all */
  private async filesWithTimestamps(
    sshConfig: any,
    paths: string[],
    sudo: boolean
  ): Promise<Set<string>> {
    const result = await this.executor.execute(
      sshConfig,
      `grep -l -E ${shellQuote(ANY_TIMESTAMP)} ${paths.map((path) => shellQuote(path)).join(' ')}`,
      { sudo, idempotent: true }
    );

    return new Set(result.stdout.split('\n').filter((name) => name.length > 0));
  }

  /**
   * Files named by a pattern.
   *
   * `find` expands it by name rather than the server's shell: the path
   * travels in quotes, otherwise a space, `$(…)` and a newline in the name
   * would come alive along with the asterisk. The directory is checked
   * against profile rules here, each matched name through the normal path at
   * its call site.
   *
   * A path that exists under its own name does not count as a pattern: a
   * bracket in a file name is a legal character, not a pattern marker.
   */
  private async expandPatterns(
    sshConfig: any,
    paths: string[],
    sudo: boolean,
    recursive = false
  ): Promise<{ paths: string[]; notes: string[]; unreadable: string[] }> {
    const expanded: string[] = [];
    const notes: string[] = [];
    const unreadable: string[] = [];

    for (const path of paths) {
      const pattern = posixPath.basename(path);
      const directory = posixPath.dirname(path);

      if (GLOB_CHARS.test(directory)) {
        throw new Error(
          `cannot expand "${path}": a pattern is supported in the file name, not in the directory.`
        );
      }

      // Walking a tree, a plain path is a starting point rather than a file:
      // otherwise "search this directory" would have to be written as a
      // pattern that matches everything
      if (!GLOB_CHARS.test(pattern) && !recursive) {
        expanded.push(path);
        continue;
      }

      const hasPattern = GLOB_CHARS.test(pattern);
      const searchRoot = hasPattern ? directory : path;
      const target = await resolveRemotePath(this.executor, sshConfig, searchRoot, {
        sudo,
      });
      for (const warning of target.warnings) {
        logger.warn(`[log-tools] ${warning}`);
      }

      const literal = hasPattern ? posixPath.join(target.path, pattern) : target.path;
      const depth = recursive ? '' : '-maxdepth 1 ';
      const nameFilter = hasPattern ? `-name ${shellQuote(pattern)} ` : '';
      const result = await this.executor.execute(
        sshConfig,
        `if [ -f ${shellQuote(literal)} ]; then printf '${GLOB_LITERAL}\\n'; else ` +
          `find ${shellQuote(target.path)} ${depth}! -type d ` +
          `${nameFilter}-print0; fi`,
        { sudo, idempotent: true }
      );

      // What find could not walk is named, not dropped. Silenced, a closed
      // directory inside the tree leaves the answer looking complete: files
      // that were never looked at cannot be told from files with nothing in them
      const refused = result.stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map(unreadablePath);

      if (result.stdout.split('\n').some((line) => line.trim() === GLOB_LITERAL)) {
        expanded.push(literal);
        continue;
      }

      // A pattern without a leading dot does not name hidden files — same as the shell
      const matches = result.stdout
        .split('\0')
        .filter((name) => name.length > 0)
        .filter((name) => pattern.startsWith('.') || !posixPath.basename(name).startsWith('.'))
        .sort();

      if (matches.length === 0) {
        throw new Error(
          result.truncated
            ? `cannot expand "${path}": the list of matching files was too long to read.`
            : refused.length > 0
              ? `no files match "${path}": ${result.stderr.trim().split('\n')[0]}`
              : `no files match "${path}"`
        );
      }

      if (refused.length > 0) {
        unreadable.push(...refused);
        notes.push(
          `Note: could not look inside ${refused.join(', ')} — anything there was not searched.`
        );
      }

      if (result.truncated) {
        notes.push(`Note: the list of files matching "${path}" was cut off, so it may be incomplete.`);
      }

      if (matches.length > MAX_GLOB_MATCHES) {
        notes.push(
          `Note: "${path}" matched ${matches.length} files, showing the first ${MAX_GLOB_MATCHES}.`
        );
      }

      expanded.push(...matches.slice(0, MAX_GLOB_MATCHES));
    }

    return { paths: expanded, notes, unreadable };
  }

  /** Notes about expanding a pattern go under the answer, not instead of it */
  private withGlobNotes(text: string, notes: string[]): string {
    return notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text;
  }

  /**
   * Log path for the command.
   *
   * `~` is expanded on our side from the passport's home directory and
   * travels in single quotes — the same way as for writing and reading files.
   *
   * Profile rules are checked right here, after expansion. Checking a raw
   * path instead would have the validator judge a made-up `/home/user/secret`
   * for `~/secret`, and a rule forbidding `/root` would never fire for root —
   * the forbidden file's content would come back regardless.
   */
  private async buildSafePath(
    sshConfig: any,
    path: string,
    sudo: boolean
  ): Promise<string> {
    const target = await resolveRemotePath(this.executor, sshConfig, path, { sudo });

    for (const warning of target.warnings) {
      logger.warn(`[log-tools] ${warning}`);
    }

    return shellQuote(target.path);
  }
}
