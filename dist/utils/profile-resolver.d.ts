/**
 * Profile Resolver - Load SSH profiles from file
 *
 * Profiles are loaded with caching and auto-reload support:
 * - Cache with TTL (default: 60 seconds)
 * - File watcher for automatic reload on changes
 * - Manual reload via reloadProfiles()
 *
 * @example File configuration
 * ```json
 * {
 *   "default": "production",
 *   "profiles": {
 *     "production": {
 *       "host": "server.example.com",
 *       "username": "admin",
 *       "port": 22,
 *       "privateKeyPath": "~/.ssh/your_private_key"
 *     }
 *   }
 * }
 * ```
 */
import type { SSHConfig } from './ssh-config.js';
/**
 * Force reload profiles (manual)
 */
export declare function reloadProfiles(): void;
/**
 * Resolve SSH configuration from tool arguments
 *
 * Priority:
 * 1. Profile name in args.profile
 * 2. Default profile from SSH_PROFILES_FILE
 *
 * @param args Tool arguments containing profile
 * @returns SSH configuration
 * @throws Error if specified profile is not found
 *
 * @example Using profile name
 * ```typescript
 * resolveSSHConfig({ profile: "production" })
 * ```
 *
 * @example Using default profile
 * ```typescript
 * resolveSSHConfig({}) // Uses default from SSH_PROFILES_FILE
 * ```
 */
export declare function resolveSSHConfig(args: {
    profile?: string;
}): SSHConfig;
/**
 * Get list of available profile names
 * Useful for debugging and error messages
 */
export declare function getAvailableProfiles(): string[];
/**
 * Get default profile name
 */
export declare function getDefaultProfile(): string;
//# sourceMappingURL=profile-resolver.d.ts.map