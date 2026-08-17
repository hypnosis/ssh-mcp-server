/**
 * Process safety nets
 *
 * The server handles many independent operations in a row. An error that
 * surfaces outside a handler — from an SFTP channel, a timer, a promise
 * nobody's watching — terminates the whole Node process by default: the
 * client loses not one call but the entire session with every profile.
 * Here such an error becomes a log entry instead, and the server keeps
 * responding.
 *
 * The one exception is a closed channel to the client: there's no one left
 * to work for, and no reason to stay in memory.
 */

import { logger } from './logger.js';

/** The channel to the client was closed from the other side */
function isClientChannelClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}

/** Text for the log: an Error contributes its stack, anything else goes through as-is */
function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

export function installProcessGuards(target: NodeJS.Process = process): void {
  target.on('uncaughtException', (error: Error) => {
    if (isClientChannelClosed(error)) {
      logger.info('[MCP Server] Client channel closed, shutting down');
      target.exit(0);
      return;
    }

    logger.error(
      `[MCP Server] Uncaught exception, the server keeps running: ${describeFailure(error)}`
    );
  });

  target.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      `[MCP Server] Unhandled rejection, the server keeps running: ${describeFailure(reason)}`
    );
  });
}
