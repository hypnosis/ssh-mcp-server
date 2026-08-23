/**
 * The command that stops a cancelled call on the server.
 *
 * Cancelling drops the local ssh client, and that is where it used to end:
 * with multiplexing the sshd process owning the command stays alive as long
 * as the master does, so the command never learns the channel is gone and
 * runs to completion. Nothing on the server side signals the loss — neither
 * the parent dying, nor EOF on stdin, nor a write error on stdout.
 *
 * So the stop is sent, not awaited: the marker sitting in the command's
 * arguments makes it findable, and its process group is already its own —
 * sshd gives each command a fresh one.
 */

import { shellQuote } from '../utils/shell-arg.js';

/** What a call marker starts with — the tail is random and unique per call */
export const CALL_MARKER_PREFIX = 'ssh-mcp-call-';

/**
 * Find the marked process and signal its whole group, reading `/proc`.
 *
 * The marker is looked for in `/proc/<pid>/cmdline`, which any user can read.
 * The environment would have been the tidier place for it, but `environ` is
 * closed to everyone except the process itself — reading another one's needs
 * ptrace rights that neither a container nor a hardened kernel grants, root
 * included.
 *
 * The loop skips its own process group. Splitting the marker in the source
 * isn't enough on its own: the shell glues the halves back together, so the
 * running `grep` carries the whole marker in its own arguments and the loop
 * would find itself — and stop halfway through, leaving the command it came
 * for alive.
 *
 * The group id is read past the closing parenthesis of `/proc/<pid>/stat`:
 * the process name sits inside those parentheses and may hold spaces, which
 * would shift every field counted from the left.
 *
 * `kill -TERM -<pgid>` is written without `--` — BusyBox refuses the command
 * outright when it's there.
 */
function procLoop(marker: string): string {
  return (
    `mine=$(sed -e "s/.*) //" /proc/$$/stat | cut -d" " -f3); ` +
    `for p in /proc/[0-9]*; do ` +
    `grep -qa "${marker}" "$p/cmdline" 2>/dev/null || continue; ` +
    `g=$(sed -e "s/.*) //" "$p/stat" 2>/dev/null | cut -d" " -f3); ` +
    `if [ -z "$g" ] || [ "$g" = "$mine" ]; then continue; fi; ` +
    `kill -TERM -"$g" 2>/dev/null; ` +
    `done`
  );
}

/**
 * The same search where there is no `/proc`: BSD and macOS keep process
 * arguments in `ps` and nowhere else.
 *
 * `ps -Ao pid,pgid,args` prints those three columns on BusyBox, coreutils
 * and macOS alike. `ps -o pgid= -p $$` does not: BusyBox rejects `-p`, so
 * the shell's own group is picked out of the same listing instead of asked
 * for separately.
 */
function psLoop(marker: string): string {
  return (
    `mine=$(ps -Ao pid,pgid 2>/dev/null | awk -v me=$$ '$1==me{print $2}'); ` +
    `ps -Ao pid,pgid,args 2>/dev/null | grep "${marker}" | while read p g rest; do ` +
    `if [ -z "$g" ] || [ "$g" = "$mine" ]; then continue; fi; ` +
    `kill -TERM -"$g" 2>/dev/null; ` +
    `done`
  );
}

/**
 * Which of the two searches the server can actually run.
 *
 * The test is the very file the first one reads. `/proc` existing is not
 * enough: FreeBSD's procfs, when mounted at all, offers `cmdline` but no
 * `stat`, so a directory check would pick the branch that cannot work there.
 */
function killLoop(marker: string): string {
  return `if [ -r /proc/$$/stat ]; then ${procLoop(marker)}; else ${psLoop(marker)}; fi`;
}

export interface CancelCommand {
  command: string;
  /** Password for `sudo -S`, when the elevated form needs one */
  stdin?: string;
}

/**
 * Build the stop for a cancelled call.
 *
 * A command running under sudo is owned by root, and a signal from the login
 * user never reaches it — so the search itself goes under sudo, where it
 * covers both halves at once. Without a password sudo is asked in its
 * non-interactive form: there is no terminal to answer a prompt on, and a
 * waiting sudo would hold the stop until its own deadline. The plain form
 * follows as a fallback — it still takes down the wrapper and everything the
 * login user owns.
 */
export function buildCancelCommand(
  marker: string,
  options: { elevated?: boolean; shell?: string; password?: string } = {}
): CancelCommand {
  const loop = killLoop(marker);
  if (!options.elevated) return { command: loop };

  const shell = options.shell ?? 'sh';
  const quoted = shellQuote(loop);

  if (options.password) {
    return { command: `sudo -S -p '' ${shell} -c ${quoted}`, stdin: `${options.password}\n` };
  }

  return { command: `sudo -n ${shell} -c ${quoted} 2>/dev/null; ${loop}` };
}
