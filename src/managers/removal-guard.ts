/**
 * Where a removal actually leads.
 *
 * The command text shows a name, not a target: `rm -rf /var/www/data/`,
 * where `data` is a link to `/`, reads as cleaning up an app directory, but
 * on coreutils it wipes the root. The only way to know the truth is to ask
 * the server, so there is one request here: resolving paths via `readlink -f`.
 *
 * The request is made only for targets ending in a slash or `/*`: `rm -rf
 * link` without a trailing slash removes the link itself and nothing more
 * — there's nothing to check there.
 */

import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/shell-arg.js';
import { classifyTarget, type RemovalTarget } from '../utils/destructive-command.js';

/** Answer from a server that has nothing to resolve a path with */
const NO_READLINK = 'SSH_MCP_NO_READLINK';

export interface ResolutionVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * Check where removal targets actually lead.
 *
 * Three outcomes, never mixed: the target is safe, the target leads into
 * the root or a system tree, there is nothing to check with. The last one
 * is also a block: not knowing is not a reason to proceed with removal, it's a reason to ask the owner.
 */
export async function resolveRemovalTargets(
  executor: SSHExecutor,
  config: SSHConfig,
  targets: RemovalTarget[],
  options: { sudo?: boolean }
): Promise<ResolutionVerdict> {
  if (targets.length === 0) return { blocked: false };

  const passport = await executor.passport(config);

  // Paths go one per line, and the order is preserved — that's what we match against
  const probes = targets
    .map((target) => `readlink -f -- ${shellQuote(target.path)} 2>/dev/null || echo`)
    .join('; ');
  const command =
    `command -v readlink >/dev/null 2>&1 || { echo ${NO_READLINK}; exit 0; }; ${probes}`;

  const result = await executor.execute(config, command, {
    sudo: options.sudo,
    idempotent: true,
  });

  if (result.stdout.includes(NO_READLINK)) {
    return {
      blocked: true,
      reason:
        'the server has no readlink, so there is no way to tell whether the target is a ' +
        'symlink into the root or a system directory',
    };
  }

  const resolved = result.stdout.split('\n').map((line) => line.trim());

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const actual = resolved[index];

    if (!actual) {
      return {
        blocked: true,
        reason: `"${target.raw}" could not be resolved on the server, so its real target is unknown`,
      };
    }

    const verdict = classifyTarget(actual, passport.home);
    if (verdict !== 'safe') {
      const where =
        verdict === 'root' ? 'the filesystem root' : verdict === 'home' ? 'the home directory' : 'a system directory';
      const via = actual === target.path ? '' : ` (via symlink → ${actual})`;
      return { blocked: true, reason: `"${target.raw}" is ${where}${via}` };
    }
  }

  return { blocked: false };
}
