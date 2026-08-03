/**
 * Раскрытие `~` в настоящий путь — до того, как путь попадёт в команду.
 *
 * Раскрывать тильду на сервере нельзя: путь уезжает в одинарных кавычках, где
 * `~` остаётся буквой, а без кавычек его пришлось бы отдавать shell целиком.
 * Прежний обход — подставить `$HOME` и взять путь в двойные кавычки — требовал
 * экранировать `$`, обратные кавычки и `!`, и на последнем ломался: в двойных
 * кавычках обратный слэш перед `!` не съедается, поэтому `~/файл!` уезжал как
 * `файл\!`.
 *
 * Домашний каталог известен из паспорта сервера — одна проба за сессию,
 * дальше из кэша. Поэтому раскрытие стоит нам ничего, а путь всегда едет
 * одинаково: в одинарных кавычках, без единого места для подстановки.
 */

import { posix as posixPath } from 'path';
import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';

export interface ExpandedPath {
  path: string;
  /** Что человек должен узнать: путь получился не тот, о котором он думал */
  warnings: string[];
}

/**
 * Превратить `~` и `~/…` в настоящий путь.
 *
 * Пути без тильды возвращаются как есть и паспорт не запрашивают.
 * `~user/…` отклоняется: чужой домашний каталог нам неизвестен, а угадывать
 * его — значит писать или читать не то.
 */
export async function expandRemoteHome(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { profileName: string; sudo?: boolean }
): Promise<ExpandedPath> {
  if (!path || !path.startsWith('~')) return { path, warnings: [] };

  if (path !== '~' && !path.startsWith('~/')) {
    throw new Error(
      `cannot expand "${path}": another user's home directory is not known here. ` +
      'Pass an absolute path instead.'
    );
  }

  const passport = await executor.passport(config, options.profileName);
  if (!passport.home) {
    throw new Error(
      `cannot expand "${path}": the server did not report a home directory. ` +
      'Pass an absolute path instead.'
    );
  }

  const expanded = path === '~' ? passport.home : posixPath.join(passport.home, path.slice(2));

  // Под sudo сервер раньше раскрывал тильду сам — уже от имени root, то есть
  // в /root. Теперь адрес другой, и молчать об этом нельзя: это другой файл
  const warnings = options.sudo
    ? [
        `"${path}" points at ${expanded} — the home of the login user, not root's. ` +
        'Pass an absolute path if you meant a different directory.',
      ]
    : [];

  return { path: expanded, warnings };
}
