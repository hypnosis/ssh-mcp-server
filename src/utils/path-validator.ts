/**
 * Path access rules: allow-list and deny-list of profile directories.
 *
 * Rules are compared against the canonical path — `path-guard` produces it.
 */

import { posix } from 'path';

/** Path access rules, set in the profile */
export interface PathSecurityConfig {
  /** Directories the path may not go outside of */
  allowedPaths?: string[];
  /** Directories that are closed regardless of the allow-list */
  deniedPaths?: string[];
  /** Whether to allow `..` in a path; defaults to yes */
  allowTraversal?: boolean;
  /** Path length limit; unlimited by default */
  maxPathLength?: number;
}

export interface PathValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * A path that can be judged: absolute, with no `.` or `..`, no doubled
 * slashes. resolveRemotePath brings paths to this form.
 *
 * The tilde needs no separate check: only a leading one expands, and that's
 * impossible for a path that already starts with a slash. A `~` in the
 * middle is just an ordinary file name character, and such a path is
 * judged like any other.
 */
function isCanonical(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.includes('//')) return false;

  return path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/**
 * A directory from a rule, in the same form as the path being checked.
 * A tilde or a relative form never reach here: a rule must be absolute,
 * which the profile loader enforces.
 */
function normalizeRule(directory: string): string {
  return posix.normalize(directory);
}

/**
 * Whether a path lies inside a directory.
 *
 * The comparison is done at the name boundary, otherwise a rule catches
 * neighbors too: denying `/root` would also deny `/rootkit`, and allowing
 * `/var/log` would let through `/var/logs-of-someone-else` — a different
 * directory with a similar name.
 */
export function isUnder(path: string, directory: string): boolean {
  const base = directory.length > 1 && directory.endsWith('/')
    ? directory.slice(0, -1)
    : directory;

  if (base === '/') return path.startsWith('/');

  return path === base || path.startsWith(`${base}/`);
}

/** Judges a path against the profile's rules: allow-list, deny-list, length, `..` */
export class PathValidator {
  /** Comparison rules, normalized to the form of the path being checked */
  private readonly deniedPaths: string[];
  private readonly allowedPaths: string[];

  constructor(private config?: PathSecurityConfig) {
    this.deniedPaths = (config?.deniedPaths ?? []).map(normalizeRule);
    this.allowedPaths = (config?.allowedPaths ?? []).map(normalizeRule);
  }

  /** Rejection reason or approval: the path is judged against every configured rule */
  validate(path: string): PathValidationResult {
    if (!this.config) {
      return { valid: true };
    }

    if (this.config.maxPathLength && path.length > this.config.maxPathLength) {
      return {
        valid: false,
        error: `Path too long: ${path.length} chars (max ${this.config.maxPathLength})`
      };
    }
    
    if (this.config.allowTraversal === false && path.includes('..')) {
      return {
        valid: false,
        error: 'Path traversal (..) not allowed for security reasons'
      };
    }
    
    // Rules compare a path against directories, so only a canonical
    // absolute path can be judged: `~` and `logs/app.log` could lead
    // anywhere. resolveRemotePath handles the conversion.
    if (!this.hasRules()) {
      return { valid: true };
    }

    if (!isCanonical(path)) {
      return {
        valid: false,
        error: `Path is not canonical: "${path}". Rules apply to absolute paths ` +
          'with no leading "~", no "." or ".." — resolve it before validating'
      };
    }

    // The deny-list is judged first: it closes a path even inside an allowed one
    for (const denied of this.deniedPaths) {
      if (isUnder(path, denied)) {
        return {
          valid: false,
          error: `Access denied to path: ${denied}`
        };
      }
    }

    if (this.allowedPaths.length > 0) {
      const isAllowed = this.allowedPaths.some(allowed => isUnder(path, allowed));

      if (!isAllowed) {
        return {
          valid: false,
          error: `Path not in allowed list. Allowed: ${this.allowedPaths.join(', ')}`
        };
      }
    }

    return { valid: true };
  }

  /** Whether there are any rules that compare a path against directories */
  private hasRules(): boolean {
    return this.deniedPaths.length > 0 || this.allowedPaths.length > 0;
  }

  /** A batch of paths: the response is the first rejection */
  validateBatch(paths: string[]): PathValidationResult {
    for (const path of paths) {
      const result = this.validate(path);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  }
}

/** A validator for the profile, or nothing — if the profile has no rules */
export function createPathValidator(sshConfig: any): PathValidator | undefined {
  if (sshConfig.pathSecurity) {
    return new PathValidator(sshConfig.pathSecurity);
  }
  return undefined;
}
