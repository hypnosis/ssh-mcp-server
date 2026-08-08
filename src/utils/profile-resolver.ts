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
  default: string;
  profiles: Record<string, SSHProfileData>;
  /** Профили, отклонённые загрузчиком: имя, поле, значение, причина */
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
 * Load profiles from file
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

      // Испорченный профиль не отменяет исправных соседей: каждая ошибка уходит
      // в лог отдельной строкой, а отказ достаётся тому, кто просит именно его
      for (const message of result.errors) {
        logger.error(`Error in SSH profiles file: ${message}`);
      }

      if (!result.config) {
        throw new Error(`Failed to load SSH profiles: ${result.errors.join('; ')}`);
      }

      const profileCount = Object.keys(result.config.profiles).length;
      logger.info(`Loaded ${profileCount} SSH profiles from file: ${profilesFile}`);

      return {
        default: result.config.default || Object.keys(result.config.profiles)[0],
        profiles: result.config.profiles,
        broken: result.broken,
      };
    } catch (err: any) {
      logger.error(`Exception loading SSH profiles file: ${err.message}`);
      throw err;
    }
  }
  
  // No fallback - SSH MCP requires profiles
  throw new Error('SSH_PROFILES_FILE environment variable not set. Please configure SSH profiles.');
}

/**
 * Get profiles with caching and auto-reload
 */
function getProfiles(): ProfilesConfig {
  const profilesFile = process.env.SSH_PROFILES_FILE;
  
  if (!profilesFile) {
    throw new Error('SSH_PROFILES_FILE not set');
  }
  
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
  
  const config = loadProfilesFromEnv();
  
  PROFILES_CACHE = {
    config,
    loadedAt: now,
    filePath: profilesFile
  };
  
  logger.info(`[Profiles] Reloaded ${Object.keys(config.profiles).length} profiles`);
  
  return config;
}

/**
 * Забыть всё, что выведено из прежних профилей.
 *
 * Секреты для маскировки, транспорты и паспорта серверов лежат по ключу
 * назначения и переживают перезапись файла: удалённый профиль остаётся в
 * памяти вместе с паролем, а сервер, успевший измениться, отвечает по старому
 * паспорту. Соединения при этом не закрываются — управляющий сокет общий для
 * машины, и следующая команда садится на него же.
 *
 * Зовётся там, где файл действительно мог измениться, а не при каждом
 * истечении срока кэша: иначе паспорт пересниматься раз в минуту.
 */
function forgetDerivedState(): void {
  forgetLoggedSecrets();
  resetRunnerCache();
  resetPassportCache();
}

/**
 * Перечитать профили с диска, забыв всё выведённое из прежних
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
          // Через ту же дверь, что и ручной вызов: производное состояние
          // обязано забываться и здесь, а двумя дорогами оно разъезжается
          reloadProfiles();
          logger.info('[Profiles] ✅ Profiles reloaded successfully');
        } catch (error: any) {
          logger.error(`[Profiles] ❌ Failed to reload profiles: ${error.message}`);
        }
      }
    });
    
    fileWatcher.on('error', (error) => {
      logger.error(`[Profiles] File watcher error: ${error.message}`);
    });
    
    logger.info('[Profiles] ✅ File watcher started');
  } catch (error: any) {
    logger.error(`[Profiles] Failed to start file watcher: ${error.message}`);
  }
}

// Initialize: load profiles and start watching
const profilesFile = process.env.SSH_PROFILES_FILE;
if (profilesFile) {
  // Initial load
  getProfiles();
  
  // Start watching
  watchProfilesFile(profilesFile);
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
 * Единственное место сборки: раньше он был скопирован трижды, и новое поле
 * профиля легко доезжало по одному пути и терялось по двум другим.
 */
function toSSHConfig(profileData: SSHProfileData): SSHConfig {
  return {
    host: profileData.host!,
    username: profileData.username!,
    port: profileData.port || 22,
    privateKeyPath: expandTilde(profileData.privateKeyPath),
    passphrase: profileData.passphrase,
    password: profileData.password,
    strictHostKeyChecking: profileData.strictHostKeyChecking,
    ignoreUserConfig: profileData.ignoreUserConfig,
    pathSecurity: profileData.pathSecurity,
  };
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
  const PROFILES = getProfiles(); // ✅ Use cached profiles with auto-reload
  
  logger.debug(`[Profile Resolver] Resolving SSH config, requested profile: ${args.profile || 'default'}`);
  logger.debug(`[Profile Resolver] Available profiles: ${Object.keys(PROFILES.profiles).join(', ')}`);
  logger.debug(`[Profile Resolver] Default profile: ${PROFILES.default}`);
  
  // Priority 1: Profile name specified
  if (args.profile) {
    logger.debug(`[Profile Resolver] Looking up profile: "${args.profile}"`);
    const profileData = PROFILES.profiles[args.profile];
    
    if (!profileData) {
      // Испорченный профиль в файле есть, и «не найден» увело бы искать опечатку
      // в имени вместо того поля, которое на самом деле мешает
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
  
  // Priority 2: Default profile (check if suitable for SSH)
  const defaultProfileName = PROFILES.default;
  logger.debug(`[Profile Resolver] No profile specified, using default: "${defaultProfileName}"`);

  // Испорченный default никем не подменяется: соседний профиль — другая машина,
  // и команда без явного профиля ушла бы туда молча
  const brokenDefault = PROFILES.broken.find((entry) => entry.name === defaultProfileName);
  if (brokenDefault) {
    logger.error(`[Profile Resolver] ❌ ${describeBrokenProfile(brokenDefault)}`);
    throw new Error(
      `Default ${describeBrokenProfile(brokenDefault)}. ` +
      `Fix it in SSH_PROFILES_FILE or name another profile explicitly.`
    );
  }

  const defaultProfileData = PROFILES.profiles[defaultProfileName];
  
  // If default profile is suitable for SSH - use it
  if (defaultProfileData && defaultProfileData.host && defaultProfileData.username) {
    logger.info(`[Profile Resolver] ✅ Using default SSH profile: "${defaultProfileName}"`);
    logger.debug(`[Profile Resolver] Default profile data: host=${defaultProfileData.host}, port=${defaultProfileData.port || 22}, username=${defaultProfileData.username}`);
    
    const expandedKeyPath = expandTilde(defaultProfileData.privateKeyPath);
    if (defaultProfileData.privateKeyPath && expandedKeyPath !== defaultProfileData.privateKeyPath) {
      logger.debug(`[Profile Resolver] Expanded privateKeyPath: ${defaultProfileData.privateKeyPath} → ${expandedKeyPath}`);
    }
    
    const sshConfig = toSSHConfig(defaultProfileData);


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
      
      const sshConfig = toSSHConfig(profileData);


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
  const PROFILES = getProfiles();
  return Object.keys(PROFILES.profiles);
}

/**
 * Get default profile name
 */
export function getDefaultProfile(): string {
  const PROFILES = getProfiles();
  return PROFILES.default;
}

/**
 * Профили, отклонённые загрузчиком при последней загрузке файла
 */
export function getBrokenProfiles(): BrokenProfile[] {
  const PROFILES = getProfiles();
  return PROFILES.broken;
}
