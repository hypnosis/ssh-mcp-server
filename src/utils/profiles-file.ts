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

  try {
    // Resolve path (support ~ for home directory)
    const resolvedPath = resolveFilePath(filePath);

    // Check if file exists
    if (!existsSync(resolvedPath)) {
      errors.push(`SSH profiles file not found: ${resolvedPath}`);
      return { config: null, errors };
    }

    // Read and parse JSON
    const fileContent = readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(fileContent);

    // Validate structure
    if (typeof parsed !== 'object' || parsed === null) {
      errors.push('SSH profiles file must contain a JSON object');
      return { config: null, errors };
    }

    if (!parsed.profiles || typeof parsed.profiles !== 'object') {
      errors.push('SSH profiles file must have a "profiles" object');
      return { config: null, errors };
    }

    // Validate each profile
    const profiles: Record<string, SSHProfileData> = {};
    for (const [name, data] of Object.entries(parsed.profiles)) {
      if (typeof data !== 'object' || data === null) {
        errors.push(`Profile "${name}" must be an object`);
        continue;
      }

      const profile = data as any;

      // Пропускаем профили с mode: "local" - они для Docker локального режима, SSH не использует
      if (profile.mode === 'local') {
        logger.debug(`Skipping profile "${name}" (mode: local) - not suitable for SSH`);
        continue;
      }

      // Validate required fields for SSH
      if (!profile.host || typeof profile.host !== 'string') {
        logger.debug(`Skipping profile "${name}" - missing host (not suitable for SSH)`);
        continue; // Пропускаем без ошибки, просто не добавляем в список
      }

      if (!profile.username || typeof profile.username !== 'string') {
        logger.debug(`Skipping profile "${name}" - missing username (not suitable for SSH)`);
        continue; // Пропускаем без ошибки
      }

      // Build SSH profile
      const profileData: SSHProfileData = {
        host: profile.host.trim(),
        username: profile.username.trim(),
      };

      // Optional fields
      if (profile.port !== undefined) {
        const port = typeof profile.port === 'number' ? profile.port : parseInt(String(profile.port), 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          errors.push(`Profile "${name}" has invalid port: ${profile.port}`);
          continue;
        }
        profileData.port = port;
      }

      if (profile.privateKeyPath && typeof profile.privateKeyPath === 'string') {
        profileData.privateKeyPath = profile.privateKeyPath.trim();
      }

      if (profile.passphrase && typeof profile.passphrase === 'string') {
        profileData.passphrase = profile.passphrase;
      }

      if (profile.password && typeof profile.password === 'string') {
        profileData.password = profile.password;
      }

      profiles[name] = profileData;
    }

    if (Object.keys(profiles).length === 0) {
      errors.push('No valid profiles found in file');
      return { config: null, errors };
    }

    // Build config
    const config: ProfilesConfig = {
      profiles,
    };

    // Set default profile - проверяем подходит ли указанный default для SSH
    if (parsed.default && typeof parsed.default === 'string') {
      if (profiles[parsed.default]) {
        // Указанный default подходит для SSH
        config.default = parsed.default;
      } else {
        // Указанный default не подходит для SSH (например, mode: "local")
        // Находим первый подходящий профиль и делаем его default
        const firstValidProfile = Object.keys(profiles)[0];
        if (firstValidProfile) {
          logger.info(`Default profile "${parsed.default}" is not suitable for SSH, using first valid profile: "${firstValidProfile}"`);
          config.default = firstValidProfile;
        }
        // Если firstValidProfile не найден - мы уже проверили это выше (строки 141-144)
        // Просто не устанавливаем default, будет использован первый из profiles
      }
    } else {
      // Default не указан - используем первый подходящий
      const firstValidProfile = Object.keys(profiles)[0];
      if (firstValidProfile) {
        config.default = firstValidProfile;
      }
    }

    // Если дошли сюда - есть хотя бы один валидный профиль
    // errors могут содержать только некритичные ошибки валидации структуры (которые мы уже обработали)
    // Возвращаем config с пустым массивом errors

    logger.info(`Loaded ${Object.keys(profiles).length} SSH profiles from ${resolvedPath}`);
    if (config.default) {
      logger.info(`Default SSH profile: ${config.default}`);
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
