/**
 * Parses destructive removal commands
 *
 * Catches not a "scary word" but a concrete disaster: removing the root, the
 * home directory, or a system tree — including through a symlink that the
 * command's text alone doesn't reveal.
 *
 * `rm -rf link` removes the link itself on both BusyBox and coreutils,
 * leaving the target intact. `rm -rf link/` (and `link/*`) behaves
 * differently: BusyBox still removes just the link, but coreutils empties
 * the target through it. That's why a trailing slash makes a path dangerous
 * while a bare `rm -rf link` does not: paths with a trailing slash are
 * resolved before the target is judged.
 *
 * This module only parses the string, with no calls to the server: pure
 * functions are easy to cover with tests, and the network is added one layer up.
 */

import { splitSegments, tokenize, unquote } from './command-parse.js';

/** Confirmation marker for a deliberate override — the same device as the reboot hook's */
export const CONFIRMATION_MARKER = '# CONFIRMED-DESTRUCTIVE';

/**
 * System trees: removing any one of them is as good as losing the machine.
 * `/home` is in the list on purpose: it holds every user's home, not just one's own.
 */
const SYSTEM_DIRS = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var', '/home', '/root', '/opt', '/srv',
];

/** What a target actually means */
export type TargetVerdict = 'root' | 'system' | 'home' | 'safe';

/** A removal target found in the command */
export interface RemovalTarget {
  /** The argument exactly as written in the command */
  raw: string;
  /**
   * The path without a trailing slash and without a trailing `*` — the part
   * that needs resolving. For `/var/www/data/` this is `/var/www/data`.
   */
  path: string;
  /**
   * Whether the target's contents are affected rather than the link itself:
   * a path with a trailing slash or with `/*`. Only in that case is a symlink dangerous.
   */
  followsLink: boolean;
  /** Expanded by the server: a variable, a substitution, a glob — nothing to parse here */
  expandable: boolean;
}

/** Whether the command carries the explicit confirmation marker */
export function isConfirmed(command: string): boolean {
  return command.includes(CONFIRMATION_MARKER);
}

/**
 * Whether a set of flags makes the removal recursive.
 *
 * `-f` isn't required: without it `rm -r /` only asks for confirmation on
 * write-protected files, and destroys the rest silently.
 */
function isRecursive(tokens: string[]): boolean {
  for (const token of tokens) {
    if (!token.startsWith('-')) continue;
    if (token === '--recursive') return true;
    if (token.startsWith('--')) continue;
    if (token.includes('r') || token.includes('R')) return true;
  }
  return false;
}

/**
 * Find recursive-removal targets across the whole command.
 *
 * An empty list means "no recursive rm in the command", not "everything is
 * safe": the command could have been in an unrecognized form, which shows up
 * as the `expandable` flag on the targets that were found.
 */
export function findRemovalTargets(command: string): RemovalTarget[] {
  const targets: RemovalTarget[] = [];

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment.trim());
    if (tokens.length === 0) continue;

    // The command may follow sudo, env, or a full path: /bin/rm
    let index = 0;
    while (index < tokens.length && /^(sudo|env|nohup|time)$/.test(tokens[index])) index += 1;
    const command0 = tokens[index];
    if (!command0 || !/(^|\/)rm$/.test(unquote(command0))) continue;

    const rest = tokens.slice(index + 1);
    if (!isRecursive(rest)) continue;

    for (const token of rest) {
      if (token === '--') continue;
      if (token.startsWith('-')) continue;

      const raw = unquote(token);
      const expandable = /[$`]|\*|\?|\[/.test(raw);

      // A trailing `*` is the same as a slash: the work is on the contents
      const starred = /\/\*+$/.test(raw);
      const slashed = raw.endsWith('/');
      const path = raw.replace(/\/\*+$/, '').replace(/\/+$/, '') || '/';

      targets.push({ raw, path, followsLink: slashed || starred, expandable });
    }
  }

  return targets;
}

/** Normalize a path for comparison: no trailing slashes, `/` stays `/` */
function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * What a path means when read literally.
 *
 * `home` is the home directory from the server's profile. An empty string
 * means "unknown": then `~` is taken as home by how it's written, since
 * there's nothing to compare it against.
 */
export function classifyTarget(path: string, home = ''): TargetVerdict {
  const value = normalize(path.trim());

  if (value === '/') return 'root';
  if (value === '~' || value === '$HOME' || value === '${HOME}') return 'home';
  if (home && value === normalize(home)) return 'home';

  if (SYSTEM_DIRS.includes(value)) return 'system';

  return 'safe';
}

/** Verdict for one command */
export interface DestructiveVerdict {
  blocked: boolean;
  /** Human-readable explanation: what exactly was stopped, and why */
  reason?: string;
  /** Targets whose fate the text alone can't settle — they need resolving on the server */
  needsResolution: RemovalTarget[];
}

/**
 * Inspect a command from its text alone.
 *
 * Returns either a ready-made refusal, or a list of targets that need
 * resolving on the server: a symlink is only visible from there.
 */
export function inspectCommand(command: string, home = ''): DestructiveVerdict {
  if (isConfirmed(command)) return { blocked: false, needsResolution: [] };

  const targets = findRemovalTargets(command);
  const needsResolution: RemovalTarget[] = [];

  for (const target of targets) {
    const verdict = classifyTarget(target.path, home);
    if (verdict !== 'safe') {
      return {
        blocked: true,
        reason: `"${target.raw}" is ${describe(verdict)}`,
        needsResolution: [],
      };
    }

    // Expansion happens on the server, and what ends up there is unknown. An
    // empty variable turns `rm -rf "$DIR"/*` into wiping the root, so such a
    // case isn't "safe" — it's "cannot be checked".
    if (target.expandable) {
      return {
        blocked: true,
        reason:
          `"${target.raw}" is expanded by the server (variable, substitution or glob), ` +
          'so the actual target cannot be checked before the command runs',
        needsResolution: [],
      };
    }

    if (target.followsLink) needsResolution.push(target);
  }

  return { blocked: false, needsResolution };
}

function describe(verdict: TargetVerdict): string {
  switch (verdict) {
    case 'root':
      return 'the filesystem root';
    case 'home':
      return 'the home directory';
    case 'system':
      return 'a system directory';
    default:
      return 'safe';
  }
}

/**
 * Build the refusal the way the agent will read it.
 *
 * The text must say three things: the command was NOT run, why, and how to
 * run it deliberately — otherwise the agent starts looking for a way around it.
 */
export function blockedMessage(command: string, reason: string): string {
  return (
    `⛔ BLOCKED: ${reason}.\n` +
    'The command was NOT executed.\n' +
    `If this is intended, repeat it with the marker: ${command.trim()} ${CONFIRMATION_MARKER}`
  );
}
