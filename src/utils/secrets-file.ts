/**
 * Secrets kept outside the profiles file.
 *
 * The profiles file gets copied, shown during debugging and committed by accident — a
 * password living there leaks with it. Secrets move to a file that is named as one, whose
 * permissions can be enforced the way ssh enforces them on private keys.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, isAbsolute, resolve as resolvePath } from 'path';
import { hideFromLogs, logger } from './logger.js';

/** Bits that must not be set: anything readable or writable outside the owner */
const FORBIDDEN_MODE_BITS = 0o077;

/**
 * The shape the file must have. Carried into every error message, because the reader of a
 * failure is usually an agent that cannot go and look the format up.
 */
export const SECRETS_FILE_EXAMPLE = `{
  "<profile name>": { "password": "..." },
  "<other profile>": { "passphrase": "..." },
  "<third profile>": { "sudoPassword": "..." }
}`;

/** Secrets for one profile */
export interface ProfileSecrets {
  password?: string;
  passphrase?: string;
  /** What `sudo` is answered with on the server, where that differs from the login password */
  sudoPassword?: string;
}

export interface SecretsFileProblem {
  /** Path as written in the profiles file, for the message to be recognizable */
  path: string;
  reason: string;
}

export type SecretsFileResult =
  | { ok: true; secrets: Record<string, ProfileSecrets> }
  | { ok: false; problem: SecretsFileProblem };

/** `~` at the start stands for the home directory; anywhere else it is an ordinary character */
function expandHome(filePath: string): string {
  if (filePath === '~') {
    return homedir();
  }
  if (filePath.startsWith('~/')) {
    return resolvePath(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve the path a profiles file points at.
 *
 * A relative path is taken from the profiles file, never from the process working
 * directory: the server is started by a client from wherever it likes, and the same config
 * would then mean different files on different runs.
 *
 * @param profilesFilePath - the already resolved path of the profiles file
 */
export function resolveSecretsPath(secretsFile: string, profilesFilePath: string): string {
  const expanded = expandHome(secretsFile);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(dirname(expandHome(profilesFilePath)), expanded);
}

/**
 * Whether the file is exposed to anyone but its owner.
 *
 * Skipped on Windows, where POSIX mode bits do not describe access and every file would
 * look wrong.
 */
function permissionProblem(resolvedPath: string): string | null {
  if (platform() === 'win32') {
    return null;
  }

  const mode = statSync(resolvedPath).mode & 0o777;
  if ((mode & FORBIDDEN_MODE_BITS) === 0) {
    return null;
  }

  const printed = mode.toString(8).padStart(3, '0');
  return (
    `permissions are too open (0${printed}) — it holds passwords and must be readable ` +
    `only by you. Fix with: chmod 600 ${resolvedPath}`
  );
}

/**
 * Read and validate a secrets file.
 *
 * Every failure is reported, never swallowed: a profile whose secret could not be read must
 * not quietly fall back to logging in without one.
 */
export function readSecretsFile(secretsFile: string, profilesFilePath: string): SecretsFileResult {
  const resolvedPath = resolveSecretsPath(secretsFile, profilesFilePath);
  const fail = (reason: string): SecretsFileResult => ({
    ok: false,
    problem: { path: secretsFile, reason },
  });

  if (!existsSync(resolvedPath)) {
    return fail(`file not found: ${resolvedPath}`);
  }

  const permissions = permissionProblem(resolvedPath);
  if (permissions) {
    return fail(permissions);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  } catch (error) {
    return fail(`${resolvedPath} is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(`${resolvedPath} must contain a JSON object keyed by profile name`);
  }

  const secrets: Record<string, ProfileSecrets> = {};

  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(`entry "${name}" in ${resolvedPath} must be an object`);
    }

    const entry = value as Record<string, unknown>;
    const collected: ProfileSecrets = {};

    for (const field of ['password', 'passphrase', 'sudoPassword'] as const) {
      const secret = entry[field];
      if (secret === undefined) {
        continue;
      }
      if (typeof secret !== 'string') {
        return fail(`"${field}" of entry "${name}" in ${resolvedPath} must be a string`);
      }
      // Hidden before it can reach any log line, whatever happens to the profile later
      hideFromLogs(secret);
      collected[field] = secret;
    }

    secrets[name] = collected;
  }

  logger.debug(`[Secrets File] Loaded secrets for ${Object.keys(secrets).length} profiles from ${resolvedPath}`);
  return { ok: true, secrets };
}
