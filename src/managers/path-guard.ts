/**
 * Куда путь ведёт на самом деле — решается здесь, до рабочей команды.
 *
 * Правила профиля сравнивают путь с каталогами, поэтому сравнивать можно
 * только канонический вид. Три источника знания, каждый на своём уровне:
 *
 *   локально  — тильда, рабочий каталог, `.`, `..`, сдвоенные слэши;
 *   паспорт   — домашний каталог, одна проба за сессию из кэша;
 *   сервер    — куда ведут символические ссылки, одна проба на путь.
 *
 * Сервер спрашивается только там, где заданы правила: без них выяснять нечего,
 * и быстрый путь остаётся без единого лишнего обращения.
 *
 * Что уезжает в команду: путь с раскрытой тильдой и ничего больше. Свёрнутый
 * `..` отправлять нельзя — он считается после перехода по ссылке, а не до неё,
 * и `/var/log/link/../x` у нас и на сервере означают разные файлы. Замеренная
 * на лаборатории разница: сервер отвечает `/x`, лексическая свёртка даёт
 * `/var/log/x`. Поэтому канонический вид служит суждению, а операция идёт по
 * тому пути, который назвал вызывающий.
 */

import { posix as posixPath } from 'path';
import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { createPathValidator } from '../utils/path-validator.js';
import { shellQuote } from '../utils/shell-arg.js';

export interface ExpandedPath {
  path: string;
  /** Что человек должен узнать: путь получился не тот, о котором он думал */
  warnings: string[];
}

/**
 * Чем закончился разбор пути:
 *
 *   ok         — правила сошлись на всём, что удалось выяснить;
 *   rewritten  — путь пришлось привести к другому виду (раскрыта тильда);
 *   unverified — по имени сошлось, а куда ведут ссылки — выяснить нечем;
 *   denied     — правило профиля не пускает.
 */
export type PathOutcome = 'ok' | 'rewritten' | 'unverified' | 'denied';

export interface PathDecision {
  outcome: PathOutcome;
  /** Путь для команды */
  path: string;
  /** Канонический вид, по которому судили */
  canonical: string;
  /** Куда ведёт путь по мнению сервера, если его удалось спросить */
  target?: string;
  warnings: string[];
  /** Заполнено только у denied */
  reason?: string;
}

/** Маркер ответа: баннер и motd в вывод попадают, ответ — нет */
const RESOLVE_MARKER = 'SSH_MCP_PATH';
const UNRESOLVED = 'SSH_MCP_PATH_UNRESOLVED';

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

  const passport = await executor.passport(config);
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

/**
 * Канонический вид для суждения: абсолютный путь без `.`, `..` и лишних слэшей.
 *
 * Относительный путь достраивается от домашнего каталога: рабочим каталогом
 * неинтерактивной команды на всех узлах лаборатории оказался именно он, так
 * что `logs/app.log` и `~/logs/app.log` — один и тот же файл.
 *
 * Дома нет — путь возвращается как есть и каноническим не становится. Судить
 * его правилами нечем, и валидатор об этом скажет: подставить сюда корень
 * значило бы вернуться к угадыванию, из-за которого правила и не работали.
 */
function toCanonical(path: string, home: string): string {
  if (!path.startsWith('/')) {
    if (!home) return path;
    return posixPath.normalize(posixPath.join(home, path));
  }

  return posixPath.normalize(path);
}

/**
 * Спросить сервер, куда путь ведёт на самом деле.
 *
 * `readlink -f` молчит, если в середине пути нет каталога, — а записывать в
 * ещё не созданное дерево нам приходится постоянно. Поэтому хвост снимается
 * до ближайшего существующего предка, резолвится он, и хвост возвращается
 * на место: ссылка в середине так всё равно раскрывается.
 *
 * Пустой ответ значит «выяснить нечем» и отказом не является: сервер без
 * `readlink` — обычный роутер, и запрещать ему работу правило не должно.
 */
async function resolveOnServer(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { profileName: string; sudo?: boolean }
): Promise<string | undefined> {
  const command =
    `p=${shellQuote(path)}; t=''; ` +
    'while [ ! -e "$p" ]; do case "$p" in ' +
    '*/*) t="/${p##*/}$t"; p="${p%/*}"; [ -z "$p" ] && p=/ ;; ' +
    `*) p='' ; break ;; esac; done; ` +
    `[ -z "$p" ] && { echo ${UNRESOLVED}; exit 0; }; ` +
    'r=$(readlink -f -- "$p" 2>/dev/null); ' +
    `[ -z "$r" ] && { echo ${UNRESOLVED}; exit 0; }; ` +
    '[ "$r" = / ] && r=""; ' +
    `printf '${RESOLVE_MARKER} %s\\n' "$r$t"`;

  const result = await executor.execute(config, command, {
    profileName: options.profileName,
    sudo: options.sudo,
    idempotent: true,
  });

  const line = result.stdout.split('\n').find((candidate) => candidate.includes(RESOLVE_MARKER));
  if (!line || result.stdout.includes(UNRESOLVED)) return undefined;

  // BusyBox отдаёт корень сдвоенным слэшем: `//root/x` вместо `/root/x`
  const answer = line.slice(line.indexOf(RESOLVE_MARKER) + RESOLVE_MARKER.length).trim();
  return answer ? posixPath.normalize(answer) : '/';
}

/**
 * Разобрать путь и решить, что с ним делать.
 *
 * Правило применяется дважды: к имени и к тому, куда имя ведёт. Запрещает
 * любое из двух — иначе ссылка внутри разрешённого каталога выносила бы данные
 * куда угодно, оставаясь по имени законной.
 */
export async function decideRemotePath(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { profileName: string; sudo?: boolean }
): Promise<PathDecision> {
  const expanded = await expandRemoteHome(executor, config, path, options);
  const rewritten = expanded.path !== path;

  const validator = createPathValidator(config);
  if (!validator) {
    return {
      outcome: rewritten ? 'rewritten' : 'ok',
      path: expanded.path,
      canonical: expanded.path,
      warnings: expanded.warnings,
    };
  }

  // Дом нужен только относительному пути, и только он один за ним ходит
  const home = expanded.path.startsWith('/')
    ? ''
    : (await executor.passport(config)).home;
  const canonical = toCanonical(expanded.path, home);

  const deny = (subject: string, error: string): PathDecision => ({
    outcome: 'denied',
    path: expanded.path,
    canonical,
    warnings: expanded.warnings,
    reason: `${subject}: ${error}`,
  });

  const byName = validator.validate(canonical);
  if (!byName.valid) return deny(canonical, byName.error!);

  const target = await resolveOnServer(executor, config, canonical, options);

  if (!target) {
    return {
      outcome: 'unverified',
      path: expanded.path,
      canonical,
      warnings: [
        ...expanded.warnings,
        `"${canonical}" was checked by name only: the server could not resolve it, ` +
        'so a symlink pointing elsewhere would go unnoticed.',
      ],
    };
  }

  if (target !== canonical) {
    const byTarget = validator.validate(target);
    if (!byTarget.valid) return deny(`${canonical} → ${target}`, byTarget.error!);
  }

  return {
    outcome: rewritten ? 'rewritten' : 'ok',
    path: expanded.path,
    canonical,
    target,
    warnings: expanded.warnings,
  };
}

/**
 * Раскрыть путь и проверить его правилами доступа профиля.
 *
 * Порядок здесь и есть суть: правила применяются к тому пути, по которому
 * операция пойдёт на самом деле. Раньше проверка шла до раскрытия, а `~/…`
 * валидатор подменял на `/home/user/…` — путь, которого не существует. На
 * сервере с входом под root запрет `deniedPaths: ['/root']` из-за этого не
 * срабатывал вовсе, а разрешение `allowedPaths: ['/root']` наоборот
 * отказывало в собственном каталоге.
 */
export async function resolveRemotePath(
  executor: SSHExecutor,
  config: SSHConfig,
  path: string,
  options: { profileName: string; sudo?: boolean }
): Promise<ExpandedPath> {
  const decision = await decideRemotePath(executor, config, path, options);

  if (decision.outcome === 'denied') {
    throw new Error(`Path validation failed: ${decision.reason}`);
  }

  return { path: decision.path, warnings: decision.warnings };
}
