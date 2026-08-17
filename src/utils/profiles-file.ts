/**
 * Profiles File Loader
 * Load SSH profiles from JSON configuration file
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger, hideFromLogs } from './logger.js';
import {
  readSecretsFile,
  SECRETS_FILE_EXAMPLE,
  type ProfileSecrets,
  type SecretsFileResult,
} from './secrets-file.js';
import {
  STRICT_HOST_KEY_CHECKING_VALUES,
  type StrictHostKeyChecking,
} from './ssh-config.js';
import type { PathSecurityConfig } from './path-validator.js';

/**
 * A rejected profile: its name, the offending field, the value it held, and why it's bad.
 *
 * A parsed record rather than a ready-made string: the rejection is looked up
 * where a profile is requested by name, and it composes its own message there.
 */
export interface BrokenProfile {
  /** Profile name in the file */
  name: string;
  /** Field that caused the profile to be rejected */
  field: string;
  /** Field value as it was written in the file */
  value: string;
  /** Why the value doesn't work */
  reason: string;
  /**
   * What a correct value looks like, printed after the reason.
   *
   * The reader of a rejected profile is usually an agent with no way to go and look the
   * format up, so the message carries it.
   */
  hint?: string;
}

/** Field value formatted for use in an error message */
function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One rejection line: profile, field, reason, and what was in the file */
export function describeBrokenProfile(entry: BrokenProfile): string {
  const described = `Profile "${entry.name}" has invalid ${entry.field}: ${entry.reason} (got ${entry.value})`;
  return entry.hint ? `${described}\n${entry.hint}` : described;
}

/** The broken field in a path-security entry, or null if it's fine */
interface PathSecurityProblem {
  field: string;
  value: unknown;
  reason: string;
}

/**
 * What's wrong with a path-security entry, or null if it's fine.
 *
 * Checks shape, not content: the path list must be a list of strings, or the
 * validator receives garbage and lets everything through — protection would
 * count as enabled while blocking nothing.
 *
 * A rule must be absolute. The validator compares it against an already
 * resolved path, so `~/.ssh` or `logs` would never match anything; guessing
 * at someone's home or working directory here is the same guesswork the
 * validator itself refuses to do.
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
  /** Secrets file used by every profile that does not name its own */
  secretsFile?: string;
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
  /**
   * Where this profile's password and passphrase are kept, instead of in this file.
   * Overrides the file-level `secretsFile`. A relative path is taken from the profiles file.
   */
  secretsFile?: string;
  /** Host key checking policy: yes | accept-new | no (default: accept-new) */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Ignore the user's ~/.ssh/config for this profile */
  ignoreUserConfig?: boolean;
  /** Path restrictions: allowed and denied directory lists */
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
  /** Profiles rejected because of a broken field */
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

  /** Reject a profile: the error is reported both as a string and as a parsed record */
  const reject = (name: string, field: string, value: unknown, reason: string, hint?: string): void => {
    const entry: BrokenProfile = { name, field, value: formatValue(value), reason, hint };
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
    
    const rootSecretsFile =
      typeof parsed.secretsFile === 'string' ? parsed.secretsFile.trim() : undefined;

    // One read per file, however many profiles point at it
    const secretsCache = new Map<string, SecretsFileResult>();
    const readSecretsCached = (secretsFile: string): SecretsFileResult => {
      const cached = secretsCache.get(secretsFile);
      if (cached) {
        return cached;
      }
      const result = readSecretsFile(secretsFile, resolvedPath);
      secretsCache.set(secretsFile, result);
      return result;
    };

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

      // Secrets are hidden from the log before any checks: a profile may still
      // get filtered out as unfit for SSH (no host, wrong mode, bad port), but
      // its password is real and must not reach the log under any outcome
      hideFromLogs(typeof profile.password === 'string' ? profile.password : undefined);
      hideFromLogs(typeof profile.passphrase === 'string' ? profile.passphrase : undefined);

      // Skip profiles with mode: "local" - they're for Docker local mode, SSH doesn't use them
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
        continue; // Skip without an error, just don't add it to the list
      }

      if (!profile.username || typeof profile.username !== 'string') {
        logger.debug(`[Profiles File] Skipping profile "${name}" - missing or invalid username (not suitable for SSH)`);
        logger.debug(`[Profiles File] Profile "${name}" username value:`, profile.username);
        skippedCount++;
        continue; // Skip without an error
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

      // A secret kept outside this file wins: the inline fields stay supported for
      // compatibility, but this file gets copied and shown, and a password should not
      // travel with it
      const ownSecretsFile =
        typeof profile.secretsFile === 'string' && profile.secretsFile.trim()
          ? profile.secretsFile.trim()
          : undefined;
      const secretsFile = ownSecretsFile ?? rootSecretsFile;

      if (secretsFile) {
        const result = readSecretsCached(secretsFile);
        if (!result.ok) {
          reject(
            name,
            'secretsFile',
            result.problem.path,
            result.problem.reason,
            `Expected format:\n${SECRETS_FILE_EXAMPLE}`
          );
          continue;
        }

        const secrets: ProfileSecrets | undefined = result.secrets[name];
        if (secrets?.password) {
          profileData.password = secrets.password;
        }
        if (secrets?.passphrase) {
          profileData.passphrase = secrets.passphrase;
        }

        // Only worth saying when the profile named a file of its own: with a shared file,
        // key-based profiles legitimately have no entry
        if (!secrets && ownSecretsFile) {
          logger.warn(
            `[Profiles File] Profile "${name}" points at ${ownSecretsFile}, which has no entry named "${name}"`
          );
        }
      }

      if ((profileData.password || profileData.passphrase) && (profile.password || profile.passphrase)) {
        logger.warn(
          `[Profiles File] Profile "${name}" keeps a secret inline. Move it to a secrets file ` +
          `(see "secretsFile") — this file is not the place for one.`
        );
      }

      // A typo in the host key checking policy must not pass silently:
      // a quiet fallback to the default would weaken protection unnoticed
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

      // Path restrictions. A broken entry is a profile error, not a silent
      // skip: a rule dropped without notice would look like enabled
      // protection that isn't actually there
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
      logger.debug(`[Profiles File] Profile "${name}" validated and added`);
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

    logger.info(`[Profiles File] Loaded ${Object.keys(profiles).length} SSH profiles from ${resolvedPath}`);
    if (skippedCount > 0) {
      logger.info(`[Profiles File] Skipped ${skippedCount} profiles (not suitable for SSH)`);
    }

    // Errors from broken profiles are reported even when valid neighbors
    // survive: otherwise the profile disappears from the list silently, and its
    // absence is only discovered by whoever asks for it by name
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
