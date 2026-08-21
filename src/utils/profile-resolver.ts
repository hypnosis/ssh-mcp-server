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
import { watch, FSWatcher } from 'fs';
import { forgetLoggedSecrets, logger } from './logger.js';
import { resetRunnerCache } from '../runner/openssh-runner.js';
import { resetPassportCache } from '../runner/passport.js';
import type { SSHConfig } from './ssh-config.js';
import {
  describeBrokenProfile,
  loadProfilesFile,
  type BrokenProfile,
  type SSHProfileData,
} from './profiles-file.js';

/**
 * Profiles configuration structure
 */
interface ProfilesConfig {
  profiles: Record<string, SSHProfileData>;
  /** Profiles rejected by the loader: name, field, value, reason */
  broken: BrokenProfile[];
}

/**
 * Profiles cache with TTL
 */
interface ProfilesCache {
  config: ProfilesConfig;
  loadedAt: number;
  filePath: string;
}

/**
 * Environment variables
 */
const CACHE_TTL = parseInt(process.env.SSH_MCP_PROFILES_CACHE_TTL || '60000'); // 60 seconds
const WATCH_PROFILES = process.env.SSH_MCP_PROFILES_WATCH !== 'false'; // true by default

/**
 * Profiles cache
 */
let PROFILES_CACHE: ProfilesCache | null = null;

/**
 * File watcher instance
 */
let fileWatcher: FSWatcher | null = null;

/**
 * Load profiles from an already-resolved file path (tilde expanded by the caller)
 */
function loadProfilesFromFile(profilesFile: string): ProfilesConfig {
  logger.debug(`Loading SSH profiles from file: ${profilesFile}`);

  try {
    const result = loadProfilesFile(profilesFile);

    // A broken profile doesn't invalidate its valid neighbors: each error goes
    // to the log as its own line, and the rejection only reaches whoever asks for that profile by name
    for (const message of result.errors) {
      logger.error(`Error in SSH profiles file: ${message}`);
    }

    if (!result.config) {
      throw new Error(`Failed to load SSH profiles: ${result.errors.join('; ')}`);
    }

    const profileCount = Object.keys(result.config.profiles).length;
    logger.info(`Loaded ${profileCount} SSH profiles from file: ${profilesFile}`);

    return {
      profiles: result.config.profiles,
      broken: result.broken,
    };
  } catch (err: any) {
    logger.error(`Exception loading SSH profiles file: ${err.message}`);
    throw err;
  }
}

/**
 * Get profiles with caching and auto-reload
 *
 * SSH_PROFILES_FILE is read and tilde-expanded here, once: the resolved path
 * becomes the cache key and is what the loader and the file watcher act on.
 */
function getProfiles(): ProfilesConfig {
  const rawProfilesFile = process.env.SSH_PROFILES_FILE;

  // The whole diagnosis travels in this message: the server starts without a
  // profiles file, so the first call is where anyone learns the file is missing
  if (!rawProfilesFile) {
    throw new Error(
      'SSH_PROFILES_FILE is not set: point it at a JSON file listing the machines this ' +
        'agent may reach. The resource ssh://profiles/example shows the shape of that file.'
    );
  }

  const profilesFile = expandTilde(rawProfilesFile)!;

  // Check cache
  const now = Date.now();
  const cacheValid = PROFILES_CACHE &&
                     PROFILES_CACHE.filePath === profilesFile &&
                     (now - PROFILES_CACHE.loadedAt) < CACHE_TTL;

  if (cacheValid) {
    logger.debug('[Profiles] Using cached profiles');
    return PROFILES_CACHE!.config;
  }

  // Load profiles
  logger.debug(`[Profiles] Cache expired or invalid, reloading from ${profilesFile}`);

  const config = loadProfilesFromFile(profilesFile);

  PROFILES_CACHE = {
    config,
    loadedAt: now,
    filePath: profilesFile
  };

  logger.info(`[Profiles] Reloaded ${Object.keys(config.profiles).length} profiles`);

  return config;
}

/**
 * Forget everything derived from previous profiles.
 *
 * Secrets kept for masking, transports, and server passports are keyed by
 * destination and outlive a file rewrite: a removed profile stays in memory
 * along with its password, and a server that has since changed keeps getting
 * answered against its old passport. Connections themselves aren't closed —
 * the control socket is shared for the machine, and the next command rides it too.
 *
 * Called where the file could actually have changed, not on every cache
 * expiry — otherwise the passport would be reshot once a minute.
 */
function forgetDerivedState(): void {
  forgetLoggedSecrets();
  resetRunnerCache();
  resetPassportCache();
}

/**
 * Reload profiles from disk, forgetting everything derived from the previous ones
 */
export function reloadProfiles(): void {
  logger.info('[Profiles] Reloading profiles');
  PROFILES_CACHE = null;
  forgetDerivedState();
  getProfiles(); // Load immediately
}

/**
 * Watch SSH_PROFILES_FILE for changes
 */
function watchProfilesFile(filePath: string): void {
  if (!WATCH_PROFILES) {
    logger.debug('[Profiles] File watching disabled (SSH_MCP_PROFILES_WATCH=false)');
    return;
  }
  
  if (fileWatcher) {
    fileWatcher.close();
  }
  
  logger.debug(`[Profiles] Watching ${filePath} for changes...`);
  
  try {
    fileWatcher = watch(filePath, (eventType) => {
      if (eventType === 'change') {
        logger.info(`[Profiles] SSH_PROFILES_FILE changed, reloading...`);
        
        try {
          // Goes through the same door as a manual call: derived state
          // must be forgotten here too, or the two paths drift apart
          reloadProfiles();
          logger.info('[Profiles] Profiles reloaded successfully');
        } catch (error: any) {
          logger.error(`[Profiles] ❌ Failed to reload profiles: ${error.message}`);
        }
      }
    });
    
    fileWatcher.on('error', (error) => {
      logger.error(`[Profiles] File watcher error: ${error.message}`);
    });
    
    logger.info('[Profiles] File watcher started');
  } catch (error: any) {
    logger.error(`[Profiles] Failed to start file watcher: ${error.message}`);
  }
}

// Initialize: load profiles and start watching. A file that will not load must not end
// the process here — this runs on import, where nothing can catch it yet, and the same
// error reaches whoever calls a tool, with its message intact
if (process.env.SSH_PROFILES_FILE) {
  try {
    // Initial load resolves and tilde-expands the path, caching it
    getProfiles();

    // Watch the same resolved path the cache and loader used
    watchProfilesFile(PROFILES_CACHE!.filePath);
  } catch (error: any) {
    logger.warn(`[Profiles] Profiles file did not load: ${error.message}`);
  }
}

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
 * Build a connection config from profile data.
 *
 * The single place this is assembled: it used to be copied three times, and
 * a new profile field would easily reach one path while getting lost on the other two.
 */
function toSSHConfig(profileData: SSHProfileData): SSHConfig {
  return {
    host: profileData.host!,
    username: profileData.username!,
    port: profileData.port || 22,
    privateKeyPath: expandTilde(profileData.privateKeyPath),
    passphrase: profileData.passphrase,
    password: profileData.password,
    sudoPassword: profileData.sudoPassword,
    strictHostKeyChecking: profileData.strictHostKeyChecking,
    ignoreUserConfig: profileData.ignoreUserConfig,
    pathSecurity: profileData.pathSecurity,
  };
}

/**
 * Resolve SSH configuration from tool arguments
 *
 * The profile is always named by the caller: every profile is a different machine,
 * so there is nothing sensible to fall back to.
 *
 * @param args Tool arguments containing profile
 * @returns SSH configuration
 * @throws Error if no profile is named, or the named one is missing or broken
 *
 * @example
 * ```typescript
 * resolveSSHConfig({ profile: "production" })
 * ```
 */
export function resolveSSHConfig(args: {
  profile?: string;
}): SSHConfig {
  const PROFILES = getProfiles(); // Use cached profiles with auto-reload
  
  logger.debug(`[Profile Resolver] Resolving SSH config, requested profile: ${args.profile || 'none given'}`);
  logger.debug(`[Profile Resolver] Available profiles: ${Object.keys(PROFILES.profiles).join(', ')}`);

  if (args.profile) {
    logger.debug(`[Profile Resolver] Looking up profile: "${args.profile}"`);
    const profileData = PROFILES.profiles[args.profile];
    
    if (!profileData) {
      // A broken profile does exist in the file, and "not found" would send someone
      // hunting for a typo in the name instead of the field that's actually the problem
      const rejected = PROFILES.broken.find((entry) => entry.name === args.profile);
      if (rejected) {
        logger.error(`[Profile Resolver] ❌ ${describeBrokenProfile(rejected)}`);
        throw new Error(
          `${describeBrokenProfile(rejected)}. Fix it in SSH_PROFILES_FILE.`
        );
      }

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
    
    logger.debug(`[Profile Resolver] Using SSH profile: "${args.profile}"`);
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
    
    const sshConfig = toSSHConfig(profileData);

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
  
  // No profile named. Nothing is substituted for it: profiles are separate machines,
  // and picking one on the caller's behalf would send the command to a server they never
  // asked for.
  // The list is never empty here: a file without a single usable profile fails to load
  // at all, and getProfiles() throws before reaching this point.
  const available = Object.keys(PROFILES.profiles);
  logger.error(`[Profile Resolver] ❌ No profile specified`);
  throw new Error(`No profile specified. Name one explicitly: ${available.join(', ')}`);
}

/**
 * Get list of available profile names
 * Useful for debugging and error messages
 */
export function getAvailableProfiles(): string[] {
  const PROFILES = getProfiles();
  return Object.keys(PROFILES.profiles);
}

/**
 * One profile as it may be shown to anyone: what it connects to, never what it
 * logs in with.
 *
 * The key path is left out along with the secret itself — it names a file on
 * this machine, and knowing where the key lives helps no caller work.
 */
export interface ProfileDescription {
  name: string;
  host: string;
  port: number;
  username: string;
  /** Which way the login goes: by key, by password, or left to the user's ssh config */
  auth: 'key' | 'password' | 'ssh-config';
}

/** How this profile logs in, without saying what with */
function authOf(profileData: SSHProfileData): ProfileDescription['auth'] {
  if (profileData.privateKeyPath) return 'key';
  if (profileData.password || profileData.secretsFile) return 'password';
  return 'ssh-config';
}

/**
 * The configured profiles, described without a single secret.
 *
 * Answers the question an agent otherwise puts to a person: which machines are
 * there, and how does one get in.
 */
export function describeProfiles(): ProfileDescription[] {
  const PROFILES = getProfiles();

  return Object.entries(PROFILES.profiles).map(([name, profileData]) => ({
    name,
    host: profileData.host!,
    port: profileData.port || 22,
    username: profileData.username!,
    auth: authOf(profileData),
  }));
}

/**
 * Profiles rejected by the loader on the last file load
 */
export function getBrokenProfiles(): BrokenProfile[] {
  const PROFILES = getProfiles();
  return PROFILES.broken;
}
