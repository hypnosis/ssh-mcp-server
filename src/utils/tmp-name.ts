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

/** Приставки временных имён — по ним узнаём свои следы рядом с целью */
export const ARTIFACT_PREFIXES = ['.upload-', '.bak-'];

/**
 * Вернуть в текст путь, который назвал человек.
 *
 * Данные едут через временное имя рядом с целью, и это имя попадало в сообщения
 * об ошибке: пользователь просил записать `/etc/nginx.conf`, а отказ приходил
 * про `/etc/.upload-7952b8939bc0.nginx.conf` — путь, которого он не называл и
 * найти на сервере уже не может.
 *
 * Временный путь получает пометку, а не просто теряет свой хвост: в одной
 * строке рядом стоят оба пути, и без пометки замена превращает `mv` временной
 * копии на место цели в бессмысленное «переименовать цель саму в себя».
 *
 * Отложенная копия (`.bak-`) под это правило не подпадает: она на сервере
 * лежит, её адрес мы человеку и сообщаем, а стёртый он превращает «не убралась
 * старая копия» в «не удалось удалить боевой путь».
 */
export function hideArtifactNames(text: string): string {
  return text
    .replace(/'([^']*)\.upload-[0-9a-f]{6,}\.([^']*)'/g, "'$1$2 (staging copy)'")
    .replace(/\.upload-[0-9a-f]{6,}\./g, '');
}

/**
 * Похоже ли имя на наш временный путь для этой цели.
 *
 * Проверка нужна точная: рядом лежат и чужие скрытые файлы, и наши же
 * временные пути от **другой** цели в том же каталоге. Назвать чужое своим —
 * значит посоветовать человеку удалить не то.
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
