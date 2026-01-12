/**
 * Profiles File Loader
 * Load SSH profiles from JSON configuration file
 */
import type { SSHConfig } from './ssh-config.js';
/**
 * Profiles configuration file structure
 */
export interface ProfilesConfig {
    /** Default profile name to use if not specified */
    default?: string;
    /** SSH profiles by name */
    profiles: Record<string, SSHProfileData>;
}
/**
 * SSH profile data in config file
 */
export interface SSHProfileData {
    /** Server address (required) */
    host?: string;
    /** Username for SSH connection (required) */
    username?: string;
    /** SSH port (default: 22) */
    port?: number;
    /** Path to private SSH key */
    privateKeyPath?: string;
    /** Passphrase for encrypted SSH key */
    passphrase?: string;
    /** Password for authentication (not recommended for production) */
    password?: string;
}
/**
 * Result of loading profiles file
 */
export interface ProfilesFileResult {
    /** Loaded profiles configuration */
    config: ProfilesConfig | null;
    /** Validation errors */
    errors: string[];
}
/**
 * Load profiles from JSON file
 *
 * @param filePath - Path to profiles JSON file
 * @returns Profiles configuration and errors
 */
export declare function loadProfilesFile(filePath: string): ProfilesFileResult;
/**
 * Convert profile data to SSHConfig
 */
export declare function profileDataToSSHConfig(data: SSHProfileData): SSHConfig;
//# sourceMappingURL=profiles-file.d.ts.map