/**
 * Behaviour hints attached to every tool
 *
 * A client reads these before a call to decide whether to run it silently or
 * ask the person first. The names below are the four shapes this server has:
 * reading a remote machine, writing to one, running arbitrary commands, and
 * touching only the connection this process holds.
 *
 * Only hints that differ from the protocol default are written out. The spec
 * fixes those defaults — `readOnlyHint` false, `destructiveHint` true,
 * `idempotentHint` false, `openWorldHint` true — and every one of them is the
 * cautious reading, so a hint left unsaid never makes a call look safer than
 * it is. `destructiveHint: true` is the exception we keep spelled out: a client
 * that ignores the defaults must not mistake a write for an additive one.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Looks at a remote machine and changes nothing on it */
export const READS_REMOTE: ToolAnnotations = {
  readOnlyHint: true,
};

/** Writes to a machine: the same call twice leaves the same result */
export const WRITES_REMOTE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
};

/** Runs whatever it is handed, so the effect cannot be known in advance */
export const RUNS_COMMANDS: ToolAnnotations = {
  destructiveHint: true,
};

/** Touches only this process: its connections, its cached profiles */
export const MANAGES_CONNECTION: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
