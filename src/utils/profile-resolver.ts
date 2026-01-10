/**
 * Profile Resolver - Load SSH profiles from file
 * 
 * Profiles are loaded ONCE from SSH_PROFILES_FILE environment variable at module import.
 * This provides synchronous access with zero I/O overhead.
 * 
 * @example File configuration
 * ```json
 * {
 *   "default": "production",
 *   "profiles": {
 *     "production": {
 *       "host": "109.172.39.241",
 *       "username": "root",
 *       "port": 22,
 *       "privateKeyPath": "~/.ssh/id_rsa"
 *     }
 *   }
 * }
 * ```
 */

import { homedir } from 'os';
import { logger } from './logger.js';
import type { SSHConfig } from './ssh-config.js';
import { loadProfilesFile, type SSHProfileData } from './profiles-file.js';

/**
 * Profiles configuration structure
 */
interface ProfilesConfig {
  default: string;
  profiles: Record<string, SSHProfileData>;
}

/**
 * Load profiles from file
 * This function runs ONCE at module import time
 * 
 * Priority:
 * 1. SSH_PROFILES_FILE - path to JSON file (required for SSH MCP)
 * 2. Fallback to error (no local mode for SSH)
 */
function loadProfilesFromEnv(): ProfilesConfig {
  // Load from file (SSH_PROFILES_FILE)
  const profilesFile = process.env.SSH_PROFILES_FILE;
  
  if (profilesFile) {
    logger.debug(`Loading SSH profiles from file: ${profilesFile}`);
    
    try {
      const result = loadProfilesFile(profilesFile);
      
      if (result.errors.length > 0) {
        logger.error('Errors loading SSH profiles file:', result.errors);
        throw new Error(`Failed to load SSH profiles: ${result.errors.join(', ')}`);
      }
      
      if (result.config) {
        const profileCount = Object.keys(result.config.profiles).length;
        logger.info(`Loaded ${profileCount} SSH profiles from file: ${profilesFile}`);
        
        return {
          default: result.config.default || Object.keys(result.config.profiles)[0],
          profiles: result.config.profiles
        };
      }
    } catch (err: any) {
      logger.error(`Exception loading SSH profiles file: ${err.message}`);
      throw err;
    }
  }
  
  // No fallback - SSH MCP requires profiles
  throw new Error('SSH_PROFILES_FILE environment variable not set. Please configure SSH profiles.');
}

/**
 * Profiles loaded at module initialization (once)
 */
const PROFILES: ProfilesConfig = loadProfilesFromEnv();

/**
 * Expand tilde (~) in file paths to user home directory
 * Works cross-platform (macOS, Linux, Windows)
 */
function expandTilde(filepath?: string): string | undefined {
  if (!filepath) return undefined;
  
  return filepath.startsWith('~/')
    ? filepath.replace('~', homedir())
    : filepath;
}

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
export function resolveSSHConfig(args: {
  profile?: string;
}): SSHConfig {
  // Priority 1: Profile name specified
  if (args.profile) {
    const profileData = PROFILES.profiles[args.profile];
    
    if (!profileData) {
      const available = Object.keys(PROFILES.profiles).join(', ');
      throw new Error(
        `Profile "${args.profile}" not found in SSH_PROFILES_FILE. ` +
        `Available profiles: ${available}`
      );
    }
    
    // Validate required fields for SSH
    if (!profileData.host || !profileData.username) {
      throw new Error(`Profile "${args.profile}" must have "host" and "username" fields`);
    }
    
    logger.debug(`Using SSH profile: ${args.profile}`);
    const expandedKeyPath = expandTilde(profileData.privateKeyPath);
    if (profileData.privateKeyPath && expandedKeyPath !== profileData.privateKeyPath) {
      logger.debug(`Expanded privateKeyPath: ${profileData.privateKeyPath} → ${expandedKeyPath}`);
    }
    
    return {
      host: profileData.host,
      username: profileData.username,
      port: profileData.port || 22,
      privateKeyPath: expandedKeyPath,
      passphrase: profileData.passphrase,
      password: profileData.password,
    };
  }
  
  // Priority 2: Default profile (проверяем подходит ли для SSH)
  const defaultProfileName = PROFILES.default;
  const defaultProfileData = PROFILES.profiles[defaultProfileName];
  
  // Если default profile подходит для SSH - используем его
  if (defaultProfileData.host && defaultProfileData.username) {
    logger.debug(`Using default SSH profile: ${defaultProfileName}`);
    const expandedKeyPath = expandTilde(defaultProfileData.privateKeyPath);
    if (defaultProfileData.privateKeyPath && expandedKeyPath !== defaultProfileData.privateKeyPath) {
      logger.debug(`Expanded privateKeyPath: ${defaultProfileData.privateKeyPath} → ${expandedKeyPath}`);
    }
    
    return {
      host: defaultProfileData.host,
      username: defaultProfileData.username,
      port: defaultProfileData.port || 22,
      privateKeyPath: expandedKeyPath,
      passphrase: defaultProfileData.passphrase,
      password: defaultProfileData.password,
    };
  }
  
  // Priority 3: Ищем первый подходящий профиль (default не подходит для SSH)
  logger.debug(`Default profile "${defaultProfileName}" is not suitable for SSH, searching for first valid profile...`);
  for (const [profileName, profileData] of Object.entries(PROFILES.profiles)) {
    if (profileData.host && profileData.username) {
      logger.debug(`Using first valid SSH profile: ${profileName}`);
      const expandedKeyPath = expandTilde(profileData.privateKeyPath);
      if (profileData.privateKeyPath && expandedKeyPath !== profileData.privateKeyPath) {
        logger.debug(`Expanded privateKeyPath: ${profileData.privateKeyPath} → ${expandedKeyPath}`);
      }
      
      return {
        host: profileData.host,
        username: profileData.username,
        port: profileData.port || 22,
        privateKeyPath: expandedKeyPath,
        passphrase: profileData.passphrase,
        password: profileData.password,
      };
    }
  }
  
  // Не нашли подходящий профиль
  throw new Error('No valid SSH profile found. Profiles must have "host" and "username" fields.');
}

/**
 * Get list of available profile names
 * Useful for debugging and error messages
 */
export function getAvailableProfiles(): string[] {
  return Object.keys(PROFILES.profiles);
}

/**
 * Get default profile name
 */
export function getDefaultProfile(): string {
  return PROFILES.default;
}
