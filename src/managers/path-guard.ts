/**
 * Where a path actually leads — decided here, before the working command runs.
 *
 * Profile rules compare a path against directories, so only the canonical
 * form can be compared. Three sources of knowledge, each at its own level:
 *
 *   local    — tilde, working directory, `.`, `..`, doubled slashes;
 *   passport — home directory, one cached probe per session;
 *   server   — where symbolic links actually lead, one probe per path.
 *
 * The server is asked only where rules are configured: without rules there
 * is nothing to determine.
 *
 * Only the path with the tilde expanded goes into the command, nothing
 * else. A collapsed `..` must not be sent: it is resolved after following a
 * link, not before it, and `/var/log/link/../x` means different files here
 * and on the server. The canonical form serves the judgment; the operation
 * runs on the caller's own path.
 */

import { posix as posixPath } from 'path';
import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { createPathValidator } from '../utils/path-validator.js';
import { shellQuote } from '../utils/shell-arg.js';

export interface ExpandedPath {
  path: string;
  /** What a human needs to know: the path did not turn out to be the one they had in mind */
  warnings: string[];
}

/**
 * How path resolution ended:
 *
 *   ok         — the rules matched on everything that could be determined;
 *   rewritten  — the path had to be rewritten into another form (tilde expanded);
 *   unverified — matched by name, but where links lead could not be determined;
 *   denied     — a profile rule blocks it.
 */
type PathOutcome = 'ok' | 'rewritten' | 'unverified' | 'denied';

export interface PathDecision {
  outcome: PathOutcome;
  /** The path to use for the command */
  path: string;
  /** The canonical form the judgment was based on */
  canonical: string;
  /** Where the server says the path leads, if it could be asked */
  target?: string;
  warnings: string[];
  /** Filled in only for denied */
  reason?: string;
}

/** Response marker: banners and the motd end up in the output, the answer does not */
const RESOLVE_MARKER = 'SSH_MCP_PATH';
const UNRESOLVED = 'SSH_MCP_PATH_UNRESOLVED';

/**
 * Turn `~` and `~/…` into a real path.
 *
 * Paths without a tilde are returned as is, without requesting a passport.
 * `~user/…` is rejected: another user's home directory is unknown to us,
 * and guessing it would mean writing or reading the wrong thing.
 */
async function expandRemoteHome(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { sudo?: boolean }
): Promise<ExpandedPath> {
  if (!path || !path.startsWith('~')) return { path, warnings: [] };

  if (path !== '~' && !path.startsWith('~/')) {
    throw new Error(
      `cannot expand "${path}": another user's home directory is not known here. ` +
      'Pass an absolute path instead.'
    );
  }

  const passport = await executor.passport(config);
  if (!passport.home) {
    throw new Error(
      `cannot expand "${path}": the server did not report a home directory. ` +
      'Pass an absolute path instead.'
    );
  }

  const expanded = path === '~' ? passport.home : posixPath.join(passport.home, path.slice(2));

  // Under sudo, the tilde leads to the login user's home, not /root: the
  // address is different, and a human needs to see that
  const warnings = options.sudo
    ? [
        `"${path}" points at ${expanded} — the home of the login user, not root's. ` +
        'Pass an absolute path if you meant a different directory.',
      ]
    : [];

  return { path: expanded, warnings };
}

/**
 * Canonical form for judgment: an absolute path without `.`, `..`, or extra slashes.
 *
 * A relative path is resolved against the home directory — the working
 * directory of a non-interactive command. With no home available, the path
 * is returned as is and never becomes canonical: there's nothing to judge
 * it against by rule, and the validator will say so.
 */
function toCanonical(path: string, home: string): string {
  if (!path.startsWith('/')) {
    if (!home) return path;
    return posixPath.normalize(posixPath.join(home, path));
  }

  return posixPath.normalize(path);
}

/**
 * Ask the server where a path actually leads.
 *
 * `readlink -f` stays silent if a directory in the middle of the path is
 * missing, so the tail is stripped down to the nearest existing ancestor,
 * that ancestor is resolved, and the tail is put back — a link partway
 * through the path is still resolved this way.
 *
 * An empty answer means "cannot be determined" and is not a rejection:
 * servers without `readlink` are not shut out of working.
 */
async function resolveOnServer(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { sudo?: boolean }
): Promise<string | undefined> {
  const command =
    `p=${shellQuote(path)}; t=''; ` +
    'while [ ! -e "$p" ]; do case "$p" in ' +
    '*/*) t="/${p##*/}$t"; p="${p%/*}"; [ -z "$p" ] && p=/ ;; ' +
    `*) p='' ; break ;; esac; done; ` +
    `[ -z "$p" ] && { echo ${UNRESOLVED}; exit 0; }; ` +
    'r=$(readlink -f -- "$p" 2>/dev/null); ' +
    `[ -z "$r" ] && { echo ${UNRESOLVED}; exit 0; }; ` +
    '[ "$r" = / ] && r=""; ' +
    `printf '${RESOLVE_MARKER} %s\\n' "$r$t"`;

  const result = await executor.execute(config, command, {
    sudo: options.sudo,
    idempotent: true,
  });

  const line = result.stdout.split('\n').find((candidate) => candidate.includes(RESOLVE_MARKER));
  if (!line || result.stdout.includes(UNRESOLVED)) return undefined;

  // BusyBox reports root with a doubled slash: `//root/x` instead of `/root/x`
  const answer = line.slice(line.indexOf(RESOLVE_MARKER) + RESOLVE_MARKER.length).trim();
  return answer ? posixPath.normalize(answer) : '/';
}

/**
 * Resolve a path and decide what to do with it.
 *
 * The rule is applied twice: to the name and to where the name leads. If
 * either one denies it, the path is denied — otherwise a link inside an
 * allowed directory could carry data anywhere while still looking legitimate by name.
 */
export async function decideRemotePath(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { sudo?: boolean }
): Promise<PathDecision> {
  const expanded = await expandRemoteHome(executor, config, path, options);
  const rewritten = expanded.path !== path;

  const validator = createPathValidator(config);
  if (!validator) {
    return {
      outcome: rewritten ? 'rewritten' : 'ok',
      path: expanded.path,
      canonical: expanded.path,
      warnings: expanded.warnings,
    };
  }

  // Only a relative path needs the home directory, and it's the only one that requests it
  const home = expanded.path.startsWith('/')
    ? ''
    : (await executor.passport(config)).home;
  const canonical = toCanonical(expanded.path, home);

  const deny = (subject: string, error: string): PathDecision => ({
    outcome: 'denied',
    path: expanded.path,
    canonical,
    warnings: expanded.warnings,
    reason: `${subject}: ${error}`,
  });

  const byName = validator.validate(canonical);
  if (!byName.valid) return deny(canonical, byName.error!);

  const target = await resolveOnServer(executor, config, canonical, options);

  if (!target) {
    return {
      outcome: 'unverified',
      path: expanded.path,
      canonical,
      warnings: [
        ...expanded.warnings,
        `"${canonical}" was checked by name only: the server could not resolve it, ` +
        'so a symlink pointing elsewhere would go unnoticed.',
      ],
    };
  }

  if (target !== canonical) {
    const byTarget = validator.validate(target);
    if (!byTarget.valid) return deny(`${canonical} → ${target}`, byTarget.error!);
  }

  return {
    outcome: rewritten ? 'rewritten' : 'ok',
    path: expanded.path,
    canonical,
    target,
    warnings: expanded.warnings,
  };
}

/**
 * Expand a path and check it against the profile's access rules.
 *
 * The order is the whole point: the rules are applied to the path the
 * operation actually takes, not to the one the caller named.
 */
export async function resolveRemotePath(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { sudo?: boolean }
): Promise<ExpandedPath> {
  const decision = await decideRemotePath(executor, config, path, options);

  if (decision.outcome === 'denied') {
    throw new Error(`Path validation failed: ${decision.reason}`);
  }

  return { path: decision.path, warnings: decision.warnings };
}
