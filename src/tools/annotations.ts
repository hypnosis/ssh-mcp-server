/**
 * Behaviour hints attached to every tool
 *
 * A client reads these before a call to decide whether to run it silently or
 * ask the person first. The names below are the four shapes this server has:
 * reading a remote machine, writing to one, running arbitrary commands, and
 * touching only the connection this process holds.
 *
 * `openWorldHint` is true wherever a remote machine is involved: which server
 * answers depends on the profile, and the server is not ours to predict.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Looks at a remote machine and changes nothing on it */
export const READS_REMOTE: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/** Writes to a machine: the same call twice leaves the same result */
export const WRITES_REMOTE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Runs whatever it is handed, so the effect cannot be known in advance */
export const RUNS_COMMANDS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Touches only this process: its connections, its cached profiles */
export const MANAGES_CONNECTION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
