/**
 * Temporary path name helpers for atomic upload (.tmp.<rand>)
 */

import { randomBytes } from 'crypto';

/**
 * Build a temp filename next to the target path, on the same FS,
 * so a final rename() stays atomic and avoids EXDEV.
 *
 * /etc/nginx/site.conf → /etc/nginx/.upload-<rand>.site.conf
 */
export function buildTempPath(remotePath: string): string {
  const rand = randomBytes(6).toString('hex');
  const lastSlash = remotePath.lastIndexOf('/');
  if (lastSlash < 0) {
    return `.upload-${rand}.${remotePath}`;
  }
  const dir = remotePath.slice(0, lastSlash);
  const base = remotePath.slice(lastSlash + 1);
  return `${dir}/.upload-${rand}.${base}`;
}

/**
 * Name for a deferred old copy next to the target.
 *
 * /var/www/app → /var/www/.bak-<rand>.app
 *
 * The random suffix is mandatory: with a fixed `.bak`, a re-install with a
 * copy left over from a previous crash would move the live directory inside
 * it, and the next step would routinely delete everything together.
 */
export function buildBackupPath(path: string): string {
  const rand = randomBytes(6).toString('hex');
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash < 0) {
    return `.bak-${rand}.${trimmed}`;
  }
  const parent = trimmed.slice(0, lastSlash);
  const base = trimmed.slice(lastSlash + 1);
  return `${parent}/.bak-${rand}.${base}`;
}

/** Temp name prefixes — used to recognize our own traces next to the target */
export const ARTIFACT_PREFIXES = ['.upload-', '.bak-'];

/**
 * Restore the path the human named, in the text.
 *
 * Data travels under a temp name next to the target, and that name was
 * leaking into error messages: the human asked to write `/etc/nginx.conf`,
 * and the rejection came back about `/etc/.upload-7952b8939bc0.nginx.conf`
 * — a path they never named and can no longer find on the server.
 *
 * The temp path gets a note rather than simply losing its suffix: both
 * paths end up next to each other on one line, and without the note, the
 * substitution turns the `mv` of the staged copy onto the target into a
 * meaningless "rename the target to itself".
 *
 * The deferred copy (`.bak-`) doesn't fall under this rule: it stays on the
 * server, and we do tell the human its address — erasing it would turn "the
 * old copy wasn't cleaned up" into "failed to delete the live path".
 */
export function hideArtifactNames(text: string): string {
  return text
    .replace(/'([^']*)\.upload-[0-9a-f]{6,}\.([^']*)'/g, "'$1$2 (staging copy)'")
    .replace(/\.upload-[0-9a-f]{6,}\./g, '');
}

/**
 * Whether a name looks like our temp path for this target.
 *
 * The check needs to be exact: the same directory can hold both unrelated
 * hidden files and our own temp paths for a **different** target. Calling
 * someone else's file ours means telling the human to delete the wrong one.
 */
export function isArtifactOf(name: string, base: string): boolean {
  return ARTIFACT_PREFIXES.some((prefix) => {
    if (!name.startsWith(prefix)) return false;
    const rest = name.slice(prefix.length);
    const dot = rest.indexOf('.');
    return dot > 0 && /^[0-9a-f]+$/.test(rest.slice(0, dot)) && rest.slice(dot + 1) === base;
  });
}

/**
 * Build a remote /tmp staging path used for sudo uploads
 * (sftp under user, then sudo install/move into the protected dir).
 */
export function buildSudoStagingPath(): string {
  const rand = randomBytes(8).toString('hex');
  return `/tmp/.ssh-mcp-upload-${rand}`;
}
