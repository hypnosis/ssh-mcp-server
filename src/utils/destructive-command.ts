/**
 * Разбор разрушительных команд удаления
 *
 * Ловим не «страшное слово», а конкретную беду: удаление корня, домашнего
 * каталога или системного дерева — в том числе через символическую ссылку,
 * которую по тексту команды не видно вовсе.
 *
 * Замерено на лаборатории, и контейнеры разошлись:
 *   `rm -rf link`  — обе машины удаляют саму ссылку, цель цела;
 *   `rm -rf link/` — BusyBox тоже удаляет ссылку, а coreutils ОПУСТОШАЕТ цель.
 * Значит опасен завершающий слэш (и `link/*`), а `rm -rf link` — обычная
 * уборка, и блокировать её значило бы мешать работе. Решение принимается по
 * худшей из двух машин: пути со слэшем проверяются резолвом.
 *
 * Здесь только разбор строки, без обращений к серверу: чистые функции легко
 * закрыть тестами, а сеть добавляется одним слоем выше.
 */

/** Маркер осознанного подтверждения — тот же приём, что у хука про перезагрузку */
export const CONFIRMATION_MARKER = '# CONFIRMED-DESTRUCTIVE';

/**
 * Системные деревья: снести любое из них равносильно потере машины.
 * `/home` в списке нарочно: это дома всех пользователей, а не только своего.
 */
const SYSTEM_DIRS = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var', '/home', '/root', '/opt', '/srv',
];

/** Что цель означает на самом деле */
export type TargetVerdict = 'root' | 'system' | 'home' | 'safe';

/** Цель удаления, найденная в команде */
export interface RemovalTarget {
  /** Аргумент как он написан в команде */
  raw: string;
  /**
   * Путь без завершающего слэша и без хвостовой `*` — то, что надо резолвить.
   * Для `/var/www/data/` это `/var/www/data`.
   */
  path: string;
  /**
   * Затрагивается ли содержимое цели, а не сама ссылка: путь со слэшем на
   * конце или с `/*`. Только в этом случае симлинк опасен.
   */
  followsLink: boolean;
  /** Раскрывается сервером: переменная, подстановка, шаблон — разобрать нечем */
  expandable: boolean;
}

/** Подтверждена ли команда явным маркером */
export function isConfirmed(command: string): boolean {
  return command.includes(CONFIRMATION_MARKER);
}

/** Убрать кавычки, которыми аргумент мог быть обёрнут целиком */
function unquote(argument: string): string {
  const paired = /^'(.*)'$/.exec(argument) ?? /^"(.*)"$/.exec(argument);
  return paired ? paired[1] : argument;
}

/**
 * Даёт ли набор флагов рекурсивное удаление.
 *
 * `-f` не требуется: без него `rm -r /` спросит подтверждение только на
 * защищённых от записи файлах, а остальное снесёт молча.
 */
function isRecursive(tokens: string[]): boolean {
  for (const token of tokens) {
    if (!token.startsWith('-')) continue;
    if (token === '--recursive') return true;
    if (token.startsWith('--')) continue;
    if (token.includes('r') || token.includes('R')) return true;
  }
  return false;
}

/**
 * Разрезать команду на простые сегменты.
 *
 * Разделители shell (`;`, `&&`, `||`, `|`, перевод строки) не могут стоять
 * внутри аргумента, если он не в кавычках, — а внутри кавычек нам делать
 * нечего: путь с точкой с запятой в имени не тот случай, ради которого
 * стоит усложнять разбор.
 */
function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/);
}

/** Разбить сегмент на слова, не разрывая закавыченные куски */
function tokenize(segment: string): string[] {
  return segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
}

/**
 * Найти цели рекурсивного удаления во всей команде.
 *
 * Пустой список означает «в команде нет рекурсивного rm», а не «всё
 * безопасно»: команда могла быть непонятной формы, и это видно по флагу
 * `expandable` у найденных целей.
 */
export function findRemovalTargets(command: string): RemovalTarget[] {
  const targets: RemovalTarget[] = [];

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment.trim());
    if (tokens.length === 0) continue;

    // Команда может идти после sudo, env и через полный путь: /bin/rm
    let index = 0;
    while (index < tokens.length && /^(sudo|env|nohup|time)$/.test(tokens[index])) index += 1;
    const command0 = tokens[index];
    if (!command0 || !/(^|\/)rm$/.test(unquote(command0))) continue;

    const rest = tokens.slice(index + 1);
    if (!isRecursive(rest)) continue;

    for (const token of rest) {
      if (token === '--') continue;
      if (token.startsWith('-')) continue;

      const raw = unquote(token);
      const expandable = /[$`]|\*|\?|\[/.test(raw);

      // Хвостовая `*` — то же самое, что слэш: работа идёт с содержимым
      const starred = /\/\*+$/.test(raw);
      const slashed = raw.endsWith('/');
      const path = raw.replace(/\/\*+$/, '').replace(/\/+$/, '') || '/';

      targets.push({ raw, path, followsLink: slashed || starred, expandable });
    }
  }

  return targets;
}

/** Нормализовать путь для сравнения: без хвостовых слэшей, `/` остаётся `/` */
function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Что означает путь, если понимать его буквально.
 *
 * `home` — домашний каталог из паспорта сервера. Пустая строка означает «не
 * знаем»: тогда `~` считается домом по написанию, а сравнить с настоящим
 * путём нечем.
 */
export function classifyTarget(path: string, home = ''): TargetVerdict {
  const value = normalize(path.trim());

  if (value === '/') return 'root';
  if (value === '~' || value === '$HOME' || value === '${HOME}') return 'home';
  if (home && value === normalize(home)) return 'home';

  if (SYSTEM_DIRS.includes(value)) return 'system';

  return 'safe';
}

/** Итог проверки одной команды */
export interface DestructiveVerdict {
  blocked: boolean;
  /** Человеческое объяснение: что именно и почему остановлено */
  reason?: string;
  /** Цели, судьбу которых по строке не решить — нужен резолв на сервере */
  needsResolution: RemovalTarget[];
}

/**
 * Проверить команду по одному только тексту.
 *
 * Возвращает либо готовый отказ, либо список целей, которые надо резолвить
 * на сервере: симлинк виден только оттуда.
 */
export function inspectCommand(command: string, home = ''): DestructiveVerdict {
  if (isConfirmed(command)) return { blocked: false, needsResolution: [] };

  const targets = findRemovalTargets(command);
  const needsResolution: RemovalTarget[] = [];

  for (const target of targets) {
    const verdict = classifyTarget(target.path, home);
    if (verdict !== 'safe') {
      return {
        blocked: true,
        reason: `"${target.raw}" is ${describe(verdict)}`,
        needsResolution: [],
      };
    }

    // Раскрытие делает сервер, и что там окажется — неизвестно. Пустая
    // переменная превращает `rm -rf "$DIR"/*` в снос корня, поэтому такой
    // случай не «безопасно», а «проверить нечем».
    if (target.expandable) {
      return {
        blocked: true,
        reason:
          `"${target.raw}" is expanded by the server (variable, substitution or glob), ` +
          'so the actual target cannot be checked before the command runs',
        needsResolution: [],
      };
    }

    if (target.followsLink) needsResolution.push(target);
  }

  return { blocked: false, needsResolution };
}

function describe(verdict: TargetVerdict): string {
  switch (verdict) {
    case 'root':
      return 'the filesystem root';
    case 'home':
      return 'the home directory';
    case 'system':
      return 'a system directory';
    default:
      return 'safe';
  }
}

/**
 * Собрать отказ в том виде, в каком его прочитает агент.
 *
 * Текст обязан говорить три вещи: команда НЕ выполнена, почему, и как
 * выполнить её осознанно, — иначе агент начнёт подбирать обходы.
 */
export function blockedMessage(command: string, reason: string): string {
  return (
    `⛔ BLOCKED: ${reason}.\n` +
    'The command was NOT executed.\n' +
    `If this is intended, repeat it with the marker: ${command.trim()} ${CONFIRMATION_MARKER}`
  );
}
