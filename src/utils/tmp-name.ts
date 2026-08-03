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
 * Build a staging directory for a recursive upload, next to the target dir.
 * /var/www/app → /var/www/.upload-<rand>.app/
 */
export function buildStagingDir(remoteDir: string): string {
  const rand = randomBytes(6).toString('hex');
  const trimmed = remoteDir.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash < 0) {
    return `.upload-${rand}.${trimmed}`;
  }
  const parent = trimmed.slice(0, lastSlash);
  const base = trimmed.slice(lastSlash + 1);
  return `${parent}/.upload-${rand}.${base}`;
}

/**
 * Имя для отложенной старой копии рядом с целью.
 *
 * /var/www/app → /var/www/.bak-<rand>.app
 *
 * Случайный суффикс обязателен: с фиксированным `.bak` повторная установка
 * при оставшейся с прошлой аварии копии перенесла бы боевой каталог внутрь
 * неё, а следующий шаг штатно удалил бы всё вместе.
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

/**
 * Build a remote /tmp staging path used for sudo uploads
 * (sftp under user, then sudo install/move into the protected dir).
 */
export function buildSudoStagingPath(): string {
  const rand = randomBytes(8).toString('hex');
  return `/tmp/.ssh-mcp-upload-${rand}`;
}

/**
 * Single-quote a path for safe inclusion in a shell command.
 * Escapes embedded single quotes via '\'' trick.
 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
