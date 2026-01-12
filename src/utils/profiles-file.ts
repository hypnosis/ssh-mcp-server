/**
 * Profiles File Loader
 * Load SSH profiles from JSON configuration file
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger.js';
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
export function loadProfilesFile(filePath: string): ProfilesFileResult {
  const errors: string[] = [];

  logger.debug(`[Profiles File] Loading SSH profiles from: ${filePath}`);

  try {
    // Resolve path (support ~ for home directory)
    const resolvedPath = resolveFilePath(filePath);
    logger.debug(`[Profiles File] Resolved path: ${filePath} → ${resolvedPath}`);

    // Check if file exists
    if (!existsSync(resolvedPath)) {
      logger.error(`[Profiles File] ❌ SSH profiles file not found: ${resolvedPath}`);
      errors.push(`SSH profiles file not found: ${resolvedPath}`);
      return { config: null, errors };
    }

    logger.debug(`[Profiles File] File exists, reading content...`);
    // Read and parse JSON
    const fileContent = readFileSync(resolvedPath, 'utf-8');
    logger.debug(`[Profiles File] File read successfully, size: ${fileContent.length} bytes`);
    
    const parsed = JSON.parse(fileContent);
    logger.debug(`[Profiles File] JSON parsed successfully`);

    // Validate structure
    if (typeof parsed !== 'object' || parsed === null) {
      logger.error(`[Profiles File] ❌ SSH profiles file must contain a JSON object`);
      errors.push('SSH profiles file must contain a JSON object');
      return { config: null, errors };
    }

    logger.debug(`[Profiles File] Validating structure...`);
    if (!parsed.profiles || typeof parsed.profiles !== 'object') {
      logger.error(`[Profiles File] ❌ SSH profiles file must have a "profiles" object`);
      errors.push('SSH profiles file must have a "profiles" object');
      return { config: null, errors };
    }

    const profileKeys = Object.keys(parsed.profiles);
    logger.debug(`[Profiles File] Found ${profileKeys.length} profiles in file: ${profileKeys.join(', ')}`);
    
    if (parsed.default) {
      logger.debug(`[Profiles File] Default profile specified: "${parsed.default}"`);
    } else {
      logger.debug(`[Profiles File] No default profile specified`);
    }

    // Validate each profile
    const profiles: Record<string, SSHProfileData> = {};
    let skippedCount = 0;
    let errorCount = 0;
    
    logger.debug(`[Profiles File] Validating each profile...`);
    for (const [name, data] of Object.entries(parsed.profiles)) {
      logger.debug(`[Profiles File] Validating profile: "${name}"`);
      if (typeof data !== 'object' || data === null) {
        errors.push(`Profile "${name}" must be an object`);
        continue;
      }

      const profile = data as any;

      // Пропускаем профили с mode: "local" - они для Docker локального режима, SSH не использует
      if (profile.mode === 'local') {
        logger.debug(`[Profiles File] Skipping profile "${name}" (mode: local) - not suitable for SSH`);
        skippedCount++;
        continue;
      }

      // Validate required fields for SSH
      if (!profile.host || typeof profile.host !== 'string') {
        logger.debug(`[Profiles File] Skipping profile "${name}" - missing or invalid host (not suitable for SSH)`);
        logger.debug(`[Profiles File] Profile "${name}" host value:`, profile.host);
        skippedCount++;
        continue; // Пропускаем без ошибки, просто не добавляем в список
      }

      if (!profile.username || typeof profile.username !== 'string') {
        logger.debug(`[Profiles File] Skipping profile "${name}" - missing or invalid username (not suitable for SSH)`);
        logger.debug(`[Profiles File] Profile "${name}" username value:`, profile.username);
        skippedCount++;
        continue; // Пропускаем без ошибки
      }
      
      logger.debug(`[Profiles File] Profile "${name}" has required fields: host=${profile.host}, username=${profile.username}`);

      // Build SSH profile
      const profileData: SSHProfileData = {
        host: profile.host.trim(),
        username: profile.username.trim(),
      };

      // Optional fields
      if (profile.port !== undefined) {
        const port = typeof profile.port === 'number' ? profile.port : parseInt(String(profile.port), 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          logger.error(`[Profiles File] ❌ Profile "${name}" has invalid port: ${profile.port}`);
          errors.push(`Profile "${name}" has invalid port: ${profile.port}`);
          errorCount++;
          continue;
        }
        profileData.port = port;
        logger.debug(`[Profiles File] Profile "${name}" port: ${port}`);
      } else {
        logger.debug(`[Profiles File] Profile "${name}" using default port: 22`);
      }

      if (profile.privateKeyPath && typeof profile.privateKeyPath === 'string') {
        profileData.privateKeyPath = profile.privateKeyPath.trim();
        logger.debug(`[Profiles File] Profile "${name}" privateKeyPath: ${profileData.privateKeyPath}`);
      } else {
        logger.debug(`[Profiles File] Profile "${name}" no privateKeyPath specified`);
      }

      if (profile.passphrase && typeof profile.passphrase === 'string') {
        profileData.passphrase = profile.passphrase;
        logger.debug(`[Profiles File] Profile "${name}" has passphrase (encrypted key)`);
      }

      if (profile.password && typeof profile.password === 'string') {
        profileData.password = profile.password;
        logger.debug(`[Profiles File] Profile "${name}" has password authentication configured`);
      }

      profiles[name] = profileData;
      logger.debug(`[Profiles File] ✅ Profile "${name}" validated and added`);
    }
    
    logger.debug(`[Profiles File] Validation complete: ${Object.keys(profiles).length} valid profiles, ${skippedCount} skipped, ${errorCount} errors`);

    if (Object.keys(profiles).length === 0) {
      logger.error(`[Profiles File] ❌ No valid profiles found in file`);
      logger.error(`[Profiles File] Skipped: ${skippedCount}, Errors: ${errorCount}`);
      errors.push('No valid profiles found in file');
      return { config: null, errors };
    }

    logger.debug(`[Profiles File] Building config with ${Object.keys(profiles).length} profiles`);
    // Build config
    const config: ProfilesConfig = {
      profiles,
    };

    // Set default profile - проверяем подходит ли указанный default для SSH
    if (parsed.default && typeof parsed.default === 'string') {
      logger.debug(`[Profiles File] Checking default profile: "${parsed.default}"`);
      if (profiles[parsed.default]) {
        // Указанный default подходит для SSH
        config.default = parsed.default;
        logger.debug(`[Profiles File] ✅ Default profile "${parsed.default}" is valid for SSH`);
      } else {
        // Указанный default не подходит для SSH (например, mode: "local")
        // Находим первый подходящий профиль и делаем его default
        const firstValidProfile = Object.keys(profiles)[0];
        if (firstValidProfile) {
          logger.warn(`[Profiles File] ⚠️  Default profile "${parsed.default}" is not suitable for SSH`);
          logger.info(`[Profiles File] Using first valid profile as default: "${firstValidProfile}"`);
          config.default = firstValidProfile;
        }
        // Если firstValidProfile не найден - мы уже проверили это выше (строки 141-144)
        // Просто не устанавливаем default, будет использован первый из profiles
      }
    } else {
      // Default не указан - используем первый подходящий
      logger.debug(`[Profiles File] No default profile specified, using first valid profile`);
      const firstValidProfile = Object.keys(profiles)[0];
      if (firstValidProfile) {
        config.default = firstValidProfile;
        logger.debug(`[Profiles File] Set default to first valid profile: "${firstValidProfile}"`);
      }
    }

    // Если дошли сюда - есть хотя бы один валидный профиль
    // errors могут содержать только некритичные ошибки валидации структуры (которые мы уже обработали)
    // Возвращаем config с пустым массивом errors

    logger.info(`[Profiles File] ✅ Loaded ${Object.keys(profiles).length} SSH profiles from ${resolvedPath}`);
    if (config.default) {
      logger.info(`[Profiles File] Default SSH profile: "${config.default}"`);
    }
    if (skippedCount > 0) {
      logger.info(`[Profiles File] Skipped ${skippedCount} profiles (not suitable for SSH)`);
    }

    return { config, errors: [] };
  } catch (error: any) {
    if (error.name === 'SyntaxError') {
      errors.push(`Invalid JSON in SSH profiles file: ${error.message}`);
    } else {
      errors.push(`Failed to load SSH profiles file: ${error.message}`);
    }
    return { config: null, errors };
  }
}

/**
 * Convert profile data to SSHConfig
 */
export function profileDataToSSHConfig(data: SSHProfileData): SSHConfig {
  // Validate required fields
  if (!data.host || !data.username) {
    throw new Error('Profile must have host and username for SSH connection');
  }

  return {
    host: data.host,
    username: data.username,
    port: data.port || 22,
    privateKeyPath: data.privateKeyPath,
    passphrase: data.passphrase,
    password: data.password,
  };
}

/**
 * Resolve file path with ~ expansion
 */
function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return filePath.replace('~', home);
  }
  return resolve(filePath);
}
