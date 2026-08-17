/**
 * What we left behind on the machine
 *
 * Control sockets outlive the server exiting: the connection is shared across
 * the machine, and closing it would cut the channel out from under a sibling
 * window. This module only reports facts — which sockets sit in the directory
 * and whether they're alive. Consumers assemble display text themselves:
 * output printing and ssh_monitor.
 */

import { readdir, stat } from 'fs/promises';
import { connect } from 'net';
import { join } from 'path';
import { CONTROL_SOCKET_PREFIX, resolveControlPersistSec } from './ssh-args.js';
import { resolveControlDir } from './runtime-check.js';

/** How long to wait for a response from the local socket before considering its state unknown */
const PROBE_TIMEOUT_MS = 1000;

/**
 * State of a control socket.
 *
 * `stale` — the file is left over from a killed master: the next command
 * will bring the connection back up, but until then the socket takes up
 * space and is misleading.
 */
type ControlSocketState = 'alive' | 'stale' | 'unknown';

export interface ControlSocket {
  path: string;
  /**
   * When the master came up. Not updated by commands, so this time can't be
   * used to judge how much longer the connection has left to live.
   */
  since: Date;
  state: ControlSocketState;
}

/**
 * Whether the connection behind the socket is alive.
 *
 * Connecting without sending a single byte is the normal path: the master
 * accepts it and waits for the protocol handshake, and disconnecting affects
 * neither it nor sibling sessions.
 */
function probeSocket(path: string): Promise<ControlSocketState> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (state: ControlSocketState): void => {
      socket.destroy();
      resolve(state);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish('unknown'));
    socket.on('connect', () => finish('alive'));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown')
    );
  });
}

/**
 * Control sockets left in the directory.
 *
 * The directory belongs to the server, but besides sockets it also holds the
 * askpass script, so names are filtered by prefix. A socket that disappears
 * between reading the directory and probing it is left out of the list: its
 * time ran out, and it's no longer ours.
 */
export async function listControlSockets(
  controlDir: string = resolveControlDir()
): Promise<ControlSocket[]> {
  let names: string[];
  try {
    names = await readdir(controlDir);
  } catch (error) {
    // No directory — no connections were ever made
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sockets: ControlSocket[] = [];

  for (const name of names) {
    if (!name.startsWith(CONTROL_SOCKET_PREFIX)) continue;

    const path = join(controlDir, name);
    try {
      const info = await stat(path);
      // The file type from stat decides right away: only real sockets get probed by connecting
      const state = info.isSocket() ? await probeSocket(path) : 'unknown';
      sockets.push({ path, since: info.mtime, state });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  return sockets;
}

/**
 * How long the connection lives after the last command, in seconds.
 *
 * This is the exact value that goes into the ssh command, so the caller
 * states a deadline, not a promise. The remaining time isn't computed: the
 * socket's timestamp is the moment the master came up — commands don't move it.
 */
export function idleWindowSec(): number {
  return resolveControlPersistSec();
}
