/**
 * SSH Configuration Module
 * Manages the SSH configuration for remote servers
 */

import type { PathSecurityConfig } from './path-validator.js';

/**
 * Host key verification policy.
 * `accept-new` — trust the key on first connection, but flag a change.
 */
export type StrictHostKeyChecking = 'yes' | 'accept-new' | 'no';

export const STRICT_HOST_KEY_CHECKING_VALUES: StrictHostKeyChecking[] = ['yes', 'accept-new', 'no'];

/**
 * SSH configuration for connecting to a remote server
 */
export interface SSHConfig {
  /** Server address (IP or domain name) */
  host: string;
  /** SSH port (default 22) */
  port?: number;
  /** Username for the SSH connection */
  username: string;
  /** Path to the private SSH key */
  privateKeyPath?: string;
  /** Passphrase for an encrypted SSH key */
  passphrase?: string;
  /** Password for authentication (not recommended for production) */
  password?: string;
  /** Host key verification policy (default accept-new; openssh backend only) */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Ignore the user's ~/.ssh/config (openssh backend only) */
  ignoreUserConfig?: boolean;
  /**
   * Path access restrictions: allow-list and deny-list of directories.
   *
   * Set in the profile — tools take their rules only from here.
   */
  pathSecurity?: PathSecurityConfig;
}
