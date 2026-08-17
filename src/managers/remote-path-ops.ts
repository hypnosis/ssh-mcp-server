/**
 * The installer's file operations on the server.
 *
 * Each one is a single command that both coreutils and BusyBox understand.
 * Two spots where a mistake costs the most:
 *
 * 1. Renaming always uses `-T`. Plain `mv` of a directory onto an existing
 *    directory nests it INSIDE and reports success, on both toolsets.
 *    Deleting the live path first and renaming into the gap would open a
 *    window where a dropped connection loses the data for good.
 * 2. A path's kind is determined starting with `test -L`. A broken symlink
 *    is invisible to both `-e` and `-d`: without this check the installer
 *    would think the path was free and fail on the replacement with an
 *    unexplained error.
 */

import { posix as posixPath } from 'path';
import type { ArtifactScan, MountCheck, PathKind, PathOps } from './installer.js';
import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/shell-arg.js';

/** Response markers: parsing goes by these, not by the exit code */
const KIND_MARKERS: Record<string, PathKind> = {
  SSH_MCP_KIND_SYMLINK: 'symlink',
  SSH_MCP_KIND_DIR: 'directory',
  SSH_MCP_KIND_FILE: 'file',
  SSH_MCP_KIND_ABSENT: 'missing',
};

export interface RemoteOpsContext {
  executor: SSHExecutor;
  config: SSHConfig;
  sudo?: boolean;
}

export function remotePathOps(context: RemoteOpsContext): PathOps {
  const { executor, config, sudo } = context;

  const run = (command: string, idempotent = false) =>
    executor.execute(config, command, { sudo, idempotent });

  return {
    async inspect(path: string): Promise<PathKind> {
      const quoted = shellQuote(path);
      // Inside `test` there must be no `--` separator: both BusyBox and
      // dash parse it as an operand ("unknown operand", "binary operator
      // expected") and answer "no such path" for a path that exists.
      // Quoting alone guards against names starting with a dash.
      const result = await run(
        `if [ -L ${quoted} ]; then echo SSH_MCP_KIND_SYMLINK; ` +
        `elif [ -d ${quoted} ]; then echo SSH_MCP_KIND_DIR; ` +
        `elif [ -e ${quoted} ]; then echo SSH_MCP_KIND_FILE; ` +
        `else echo SSH_MCP_KIND_ABSENT; fi`,
        true
      );

      for (const [marker, kind] of Object.entries(KIND_MARKERS)) {
        if (result.stdout.includes(marker)) return kind;
      }

      throw new Error(`cannot tell what ${path} is: ${result.stderr.trim() || 'no answer'}`);
    },

    /**
     * Mount point: the device number differs between the path and its parent.
     *
     * No `stat`, or it uses different syntax (`-f` instead of `-c` on BSD
     * and macOS) — the outcome is "nothing to check with". This does not
     * block the operation: the fallback safety net is `mv -T` refusing on its own.
     */
    async isSeparateFilesystem(path: string): Promise<MountCheck> {
      const parent = posixPath.dirname(path);
      const result = await run(
        `stat -c %d -- ${shellQuote(path)} ${shellQuote(parent)} 2>/dev/null`,
        true
      );

      const devices = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (devices.length !== 2 || devices.some((device) => !/^\d+$/.test(device))) {
        return 'unknown';
      }
      return devices[0] !== devices[1] ? 'separate' : 'same';
    },

    async ensureParent(path: string): Promise<void> {
      const parent = posixPath.dirname(path);
      if (!parent || parent === '/' || parent === '.') return;
      await executor.executeChecked(config, `mkdir -p -- ${shellQuote(parent)}`, {
        sudo,
      });
    },

    async rename(from: string, to: string): Promise<void> {
      await executor.executeChecked(
        config,
        `mv -T -- ${shellQuote(from)} ${shellQuote(to)}`,
        { sudo }
      );
    },

    /**
     * Our temporary paths left next to the target by past operations.
     *
     * Only our own prefixes go into the glob pattern: the target's name is
     * user-supplied, and a `*` or `[` in it would become someone else's
     * wildcard. Filtering by the actual name happens on our side, same as
     * the hash comparison.
     *
     * Read line by line: a name with a newline inside it produces an extra
     * line in the list, but this list is only shown to a human — nothing is
     * ever deleted based on it.
     */
    async listArtifacts(directory: string): Promise<ArtifactScan> {
      const result = await run(
        `find ${shellQuote(directory)} -maxdepth 1 ` +
        `\\( -name '.upload-*' -o -name '.bak-*' \\) 2>/dev/null`,
        true
      );

      return {
        paths: result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        truncated: result.truncated,
      };
    },

    /**
     * Remove a path entirely.
     *
     * No time ceiling, same as the other steps whose duration is set by the
     * data volume: on a router's flash storage or a network drive, cleanup
     * may not fit the usual thirty seconds — and then the temporary path
     * would silently stay on the server.
     */
    async removeTree(path: string): Promise<void> {
      await executor.executeChecked(config, `rm -rf -- ${shellQuote(path)}`, {
        sudo,
        timeout: 0,
      });
    },
  };
}
