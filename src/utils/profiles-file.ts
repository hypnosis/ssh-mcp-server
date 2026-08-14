/**
 * Profiles File Loader
 * Load SSH profiles from JSON configuration file
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger, hideFromLogs } from './logger.js';
import {
  STRICT_HOST_KEY_CHECKING_VALUES,
  type StrictHostKeyChecking,
} from './ssh-config.js';
import type { PathSecurityConfig } from './path-validator.js';

/**
 * Отклонённый профиль: имя, поле, стоявшее там значение и чем оно плохо.
 *
 * Разобранная запись, а не готовая строка: отказ на неё смотрит там, где
 * профиль просят по имени, и собирает свой текст.
 */
export interface BrokenProfile {
  /** Имя профиля в файле */
  name: string;
  /** Поле, из-за которого профиль отклонён */
  field: string;
  /** Значение поля в том виде, в каком оно записано в файле */
  value: string;
  /** Чем значение не годится */
  reason: string;
}

/** Значение поля в виде, пригодном для сообщения об ошибке */
function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Одна строка отказа: профиль, поле, причина и то, что стояло в файле */
export function describeBrokenProfile(entry: BrokenProfile): string {
  return `Profile "${entry.name}" has invalid ${entry.field}: ${entry.reason} (got ${entry.value})`;
}

/** Испорченное поле в записи об ограничении путей, или null если всё в порядке */
interface PathSecurityProblem {
  field: string;
  value: unknown;
  reason: string;
}

/**
 * Что не так с записью об ограничении путей, или null если всё в порядке.
 *
 * Проверяется форма, а не содержимое: список путей обязан быть списком строк,
 * иначе валидатор получит мусор и пропустит всё подряд — то есть защита будет
 * числиться включённой, ничего не запрещая.
 *
 * Правило обязано быть абсолютным. Валидатор сравнивает его с уже раскрытым
 * путём, поэтому `~/.ssh` или `logs` не совпадут ни с чем; подставить сюда
 * чужой домашний или рабочий каталог — то же угадывание, от которого отказался
 * сам валидатор.
 */
function describePathSecurityProblem(value: unknown): PathSecurityProblem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { field: 'pathSecurity', value, reason: 'it must be an object' };
  }

  const record = value as Record<string, unknown>;

  for (const key of ['allowedPaths', 'deniedPaths']) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item.trim())) {
      return {
        field: `pathSecurity.${key}`,
        value: list,
        reason: `${key} must be a list of non-empty strings`,
      };
    }

    const relative = (list as string[]).find((item) => !item.startsWith('/'));
    if (relative !== undefined) {
      return {
        field: `pathSecurity.${key}`,
        value: relative,
        reason: `${key} rule must be an absolute path starting with "/": ` +
          'rules are compared to resolved paths, so "~" and relative prefixes never match',
      };
    }
  }

  if (record.allowTraversal !== undefined && typeof record.allowTraversal !== 'boolean') {
    return {
      field: 'pathSecurity.allowTraversal',
      value: record.allowTraversal,
      reason: 'allowTraversal must be true or false',
    };
  }

  if (
    record.maxPathLength !== undefined &&
    (typeof record.maxPathLength !== 'number' || !Number.isFinite(record.maxPathLength) || record.maxPathLength <= 0)
  ) {
    return {
      field: 'pathSecurity.maxPathLength',
      value: record.maxPathLength,
      reason: 'maxPathLength must be a positive number',
    };
  }

  return null;
}

/**
 * Profiles configuration file structure
 */
interface ProfilesConfig {
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
  /** Host key checking policy: yes | accept-new | no (default: accept-new) */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Ignore the user's ~/.ssh/config for this profile */
  ignoreUserConfig?: boolean;
  /** Ограничения на пути: белый и чёрный списки каталогов */
  pathSecurity?: PathSecurityConfig;
}

/**
 * Result of loading profiles file
 */
export interface ProfilesFileResult {
  /** Loaded profiles configuration */
  config: ProfilesConfig | null;
  /** Validation errors */
  errors: string[];
  /** Профили, отклонённые из-за испорченного поля */
  broken: BrokenProfile[];
}

/**
 * Load profiles from JSON file
 * 
 * @param filePath - Path to profiles JSON file
 * @returns Profiles configuration and errors
 */
export function loadProfilesFile(filePath: string): ProfilesFileResult {
  const errors: string[] = [];
  const broken: BrokenProfile[] = [];

  /** Отклонить профиль: ошибка уходит наверх и строкой, и разобранной записью */
  const reject = (name: string, field: string, value: unknown, reason: string): void => {
    const entry: BrokenProfile = { name, field, value: formatValue(value), reason };
    logger.error(`[Profiles File] ❌ ${describeBrokenProfile(entry)}`);
    errors.push(describeBrokenProfile(entry));
    broken.push(entry);
  };

  logger.debug(`[Profiles File] Loading SSH profiles from: ${filePath}`);

  try {
    // Resolve path (support ~ for home directory)
    const resolvedPath = resolveFilePath(filePath);
    logger.debug(`[Profiles File] Resolved path: ${filePath} → ${resolvedPath}`);

    // Check if file exists
    if (!existsSync(resolvedPath)) {
      logger.error(`[Profiles File] ❌ SSH profiles file not found: ${resolvedPath}`);
      errors.push(`SSH profiles file not found: ${resolvedPath}`);
      return { config: null, errors, broken };
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
      return { config: null, errors, broken };
    }

    logger.debug(`[Profiles File] Validating structure...`);
    if (!parsed.profiles || typeof parsed.profiles !== 'object') {
      logger.error(`[Profiles File] ❌ SSH profiles file must have a "profiles" object`);
      errors.push('SSH profiles file must have a "profiles" object');
      return { config: null, errors, broken };
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

    logger.debug(`[Profiles File] Validating each profile...`);
    for (const [name, data] of Object.entries(parsed.profiles)) {
      logger.debug(`[Profiles File] Validating profile: "${name}"`);
      if (typeof data !== 'object' || data === null) {
        reject(name, 'entry', data, 'a profile must be an object');
        continue;
      }

      const profile = data as any;

      // Секреты прячем от лога до всех проверок: профиль могут отсеять как
      // непригодный для SSH (нет host, чужой mode, плохой порт), но пароль в
      // нём настоящий, и в лог ему нельзя ни при каком исходе разбора
      hideFromLogs(typeof profile.password === 'string' ? profile.password : undefined);
      hideFromLogs(typeof profile.passphrase === 'string' ? profile.passphrase : undefined);

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
          reject(name, 'port', profile.port, 'port must be a number between 1 and 65535');
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

      // Опечатка в политике проверки ключа хоста не должна проходить молча:
      // тихий откат к значению по умолчанию ослабил бы защиту незаметно
      if (profile.strictHostKeyChecking !== undefined) {
        if (!STRICT_HOST_KEY_CHECKING_VALUES.includes(profile.strictHostKeyChecking)) {
          reject(
            name,
            'strictHostKeyChecking',
            profile.strictHostKeyChecking,
            `allowed values are ${STRICT_HOST_KEY_CHECKING_VALUES.join(', ')}`
          );
          continue;
        }
        profileData.strictHostKeyChecking = profile.strictHostKeyChecking as StrictHostKeyChecking;
      }

      if (profile.ignoreUserConfig === true) {
        profileData.ignoreUserConfig = true;
        logger.debug(`[Profiles File] Profile "${name}" ignores the user's ~/.ssh/config`);
      }

      // Ограничения на пути. Испорченная запись — ошибка профиля, а не тихий
      // пропуск: молча забытое правило выглядит как включённая защита, которой
      // на самом деле нет
      if (profile.pathSecurity !== undefined) {
        const problem = describePathSecurityProblem(profile.pathSecurity);
        if (problem) {
          reject(name, problem.field, problem.value, problem.reason);
          continue;
        }
        profileData.pathSecurity = profile.pathSecurity as PathSecurityConfig;
        logger.debug(`[Profiles File] Profile "${name}" restricts paths`);
      }

      profiles[name] = profileData;
      logger.debug(`[Profiles File] ✅ Profile "${name}" validated and added`);
    }
    
    logger.debug(`[Profiles File] Validation complete: ${Object.keys(profiles).length} valid profiles, ${skippedCount} skipped, ${broken.length} errors`);

    if (Object.keys(profiles).length === 0) {
      logger.error(`[Profiles File] ❌ No valid profiles found in file`);
      logger.error(`[Profiles File] Skipped: ${skippedCount}, Errors: ${broken.length}`);
      errors.push('No valid profiles found in file');
      return { config: null, errors, broken };
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
      } else if (broken.some((entry) => entry.name === parsed.default)) {
        // Испорченный default остаётся на своём имени: сосед вместо него увёл бы
        // команду без явного профиля на другой сервер
        config.default = parsed.default;
        logger.error(`[Profiles File] ❌ Default profile "${parsed.default}" is broken and stays unusable`);
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

    logger.info(`[Profiles File] ✅ Loaded ${Object.keys(profiles).length} SSH profiles from ${resolvedPath}`);
    if (config.default) {
      logger.info(`[Profiles File] Default SSH profile: "${config.default}"`);
    }
    if (skippedCount > 0) {
      logger.info(`[Profiles File] Skipped ${skippedCount} profiles (not suitable for SSH)`);
    }

    // Ошибки испорченных профилей едут наверх и при уцелевших соседях: иначе
    // профиль исчезает молча, а default съезжает на другой сервер
    return { config, errors, broken };
  } catch (error: any) {
    if (error.name === 'SyntaxError') {
      errors.push(`Invalid JSON in SSH profiles file: ${error.message}`);
    } else {
      errors.push(`Failed to load SSH profiles file: ${error.message}`);
    }
    return { config: null, errors, broken };
  }
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
