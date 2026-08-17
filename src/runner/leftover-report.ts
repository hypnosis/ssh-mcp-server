/**
 * Report on exit what connections are still open on the machine.
 *
 * Connections outlive the server on purpose: the control socket is shared,
 * and closing it would break the channel for a neighboring window. We don't
 * count how long each one has left to live — the socket's timestamp shows
 * when the connection came up, not the last command run over it.
 */

import { logger } from '../utils/logger.js';
import { listControlSockets, idleWindowSec } from './control-sockets.js';

export async function reportLeftoverConnections(): Promise<void> {
  const sockets = await listControlSockets();
  if (sockets.length === 0) return;

  const alive = sockets.filter((socket) => socket.state === 'alive');
  const stale = sockets.filter((socket) => socket.state === 'stale');

  logger.info(
    `Left ${alive.length} connection(s) open (will close automatically after ${idleWindowSec()}s idle)`
  );
  for (const socket of alive) {
    logger.info(`  ${socket.path} — opened ${socket.since.toISOString()}`);
  }
  if (stale.length > 0) {
    logger.info(`Stale sockets: ${stale.length} — will be cleaned up on next command`);
  }
  logger.info('To close immediately: ssh -O exit <server> with the same profile settings');
}
