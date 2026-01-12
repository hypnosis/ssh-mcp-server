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
 *       "host": "server.example.com",
 *       "username": "admin",
 *       "port": 22,
 *       "privateKeyPath": "~/.ssh/your_private_key"
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
  
  if (filepath.startsWith('~')) {
    const home = homedir();
    // Use regex to replace only the leading ~
    return filepath.replace(/^~/, home);
  }
  
  return filepath;
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
  logger.debug(`[Profile Resolver] Resolving SSH config, requested profile: ${args.profile || 'default'}`);
  logger.debug(`[Profile Resolver] Available profiles: ${Object.keys(PROFILES.profiles).join(', ')}`);
  logger.debug(`[Profile Resolver] Default profile: ${PROFILES.default}`);
  
  // Priority 1: Profile name specified
  if (args.profile) {
    logger.debug(`[Profile Resolver] Looking up profile: "${args.profile}"`);
    const profileData = PROFILES.profiles[args.profile];
    
    if (!profileData) {
      const available = Object.keys(PROFILES.profiles).join(', ');
      logger.error(`[Profile Resolver] ❌ Profile "${args.profile}" not found in SSH_PROFILES_FILE`);
      logger.error(`[Profile Resolver] Available profiles: ${available}`);
      throw new Error(
        `Profile "${args.profile}" not found in SSH_PROFILES_FILE. ` +
        `Available profiles: ${available}`
      );
    }
    
    logger.debug(`[Profile Resolver] Profile "${args.profile}" found, validating...`);
    logger.debug(`[Profile Resolver] Profile data: host=${profileData.host}, username=${profileData.username}, port=${profileData.port || 22}`);
    
    // Validate required fields for SSH
    if (!profileData.host || !profileData.username) {
      logger.error(`[Profile Resolver] ❌ Profile "${args.profile}" missing required fields`);
      logger.error(`[Profile Resolver] Profile data:`, profileData);
      throw new Error(`Profile "${args.profile}" must have "host" and "username" fields`);
    }
    
    logger.info(`[Profile Resolver] ✅ Using SSH profile: "${args.profile}"`);
    logger.debug(`[Profile Resolver] Profile details: host=${profileData.host}, port=${profileData.port || 22}, username=${profileData.username}`);
    
    const expandedKeyPath = expandTilde(profileData.privateKeyPath);
    if (profileData.privateKeyPath) {
      logger.debug(`[Profile Resolver] privateKeyPath: ${profileData.privateKeyPath}`);
      if (expandedKeyPath !== profileData.privateKeyPath) {
        logger.debug(`[Profile Resolver] Expanded privateKeyPath: ${profileData.privateKeyPath} → ${expandedKeyPath}`);
      } else {
        logger.debug(`[Profile Resolver] privateKeyPath did not require expansion`);
      }
    } else {
      logger.debug(`[Profile Resolver] No privateKeyPath specified in profile`);
    }
    
    if (profileData.passphrase) {
      logger.debug(`[Profile Resolver] Passphrase provided (key is encrypted)`);
    }
    
    if (profileData.password) {
      logger.debug(`[Profile Resolver] Password authentication configured`);
    }
    
    const sshConfig: SSHConfig = {
      host: profileData.host,
      username: profileData.username,
      port: profileData.port || 22,
      privateKeyPath: expandedKeyPath,
      passphrase: profileData.passphrase,
      password: profileData.password,
    };
    
    logger.debug(`[Profile Resolver] Resolved SSH config:`, {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      privateKeyPath: sshConfig.privateKeyPath,
      hasPassphrase: !!sshConfig.passphrase,
      hasPassword: !!sshConfig.password,
    });
    
    return sshConfig;
  }
  
  // Priority 2: Default profile (check if suitable for SSH)
  const defaultProfileName = PROFILES.default;
  logger.debug(`[Profile Resolver] No profile specified, using default: "${defaultProfileName}"`);
  const defaultProfileData = PROFILES.profiles[defaultProfileName];
  
  // If default profile is suitable for SSH - use it
  if (defaultProfileData && defaultProfileData.host && defaultProfileData.username) {
    logger.info(`[Profile Resolver] ✅ Using default SSH profile: "${defaultProfileName}"`);
    logger.debug(`[Profile Resolver] Default profile data: host=${defaultProfileData.host}, port=${defaultProfileData.port || 22}, username=${defaultProfileData.username}`);
    
    const expandedKeyPath = expandTilde(defaultProfileData.privateKeyPath);
    if (defaultProfileData.privateKeyPath && expandedKeyPath !== defaultProfileData.privateKeyPath) {
      logger.debug(`[Profile Resolver] Expanded privateKeyPath: ${defaultProfileData.privateKeyPath} → ${expandedKeyPath}`);
    }
    
    const sshConfig: SSHConfig = {
      host: defaultProfileData.host,
      username: defaultProfileData.username,
      port: defaultProfileData.port || 22,
      privateKeyPath: expandedKeyPath,
      passphrase: defaultProfileData.passphrase,
      password: defaultProfileData.password,
    };
    
    logger.debug(`[Profile Resolver] Resolved SSH config from default profile:`, {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      privateKeyPath: sshConfig.privateKeyPath,
      hasPassphrase: !!sshConfig.passphrase,
      hasPassword: !!sshConfig.password,
    });
    
    return sshConfig;
  }
  
  // Priority 3: Search for first suitable profile (default not suitable for SSH)
  logger.warn(`[Profile Resolver] ⚠️  Default profile "${defaultProfileName}" is not suitable for SSH (missing host or username)`);
  logger.debug(`[Profile Resolver] Default profile data:`, defaultProfileData);
  logger.debug(`[Profile Resolver] Searching for first valid SSH profile...`);
  
  for (const [profileName, profileData] of Object.entries(PROFILES.profiles)) {
    if (profileData.host && profileData.username) {
      logger.info(`[Profile Resolver] ✅ Using first valid SSH profile: "${profileName}"`);
      logger.debug(`[Profile Resolver] Profile data: host=${profileData.host}, port=${profileData.port || 22}, username=${profileData.username}`);
      
      const expandedKeyPath = expandTilde(profileData.privateKeyPath);
      if (profileData.privateKeyPath && expandedKeyPath !== profileData.privateKeyPath) {
        logger.debug(`[Profile Resolver] Expanded privateKeyPath: ${profileData.privateKeyPath} → ${expandedKeyPath}`);
      }
      
      const sshConfig: SSHConfig = {
        host: profileData.host,
        username: profileData.username,
        port: profileData.port || 22,
        privateKeyPath: expandedKeyPath,
        passphrase: profileData.passphrase,
        password: profileData.password,
      };
      
      logger.debug(`[Profile Resolver] Resolved SSH config from first valid profile:`, {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        privateKeyPath: sshConfig.privateKeyPath,
        hasPassphrase: !!sshConfig.passphrase,
        hasPassword: !!sshConfig.password,
      });
      
      return sshConfig;
    }
  }
  
  // No suitable profile found
  logger.error(`[Profile Resolver] ❌ No valid SSH profile found`);
  logger.error(`[Profile Resolver] Available profiles: ${Object.keys(PROFILES.profiles).join(', ')}`);
  logger.error(`[Profile Resolver] All profiles must have "host" and "username" fields for SSH`);
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
