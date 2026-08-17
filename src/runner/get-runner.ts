/**
 * The doorway to the transport layer
 *
 * The only place where tools obtain a connection. There is no choice inside:
 * commands go through the system ssh client. The doorway stays in place to
 * support old servers — a future fork would land here as a single layer,
 * not as branching scattered across every tool.
 */

import type { SSHConfig } from '../utils/ssh-config.js';
import { getOpenSshRunner } from './openssh-runner.js';
import type { CommandRunner } from './types.js';

/**
 * Get the transport for a connection
 */
export async function getRunner(config: SSHConfig): Promise<CommandRunner> {
  return getOpenSshRunner(config);
}
