/**
 * Паспорт сервера
 *
 * Одна проба за сессию вместо россыпи одиночных проверок «а есть ли на сервере
 * bash / timeout / чем считать хэши». Дальше все решения принимаются по паспорту,
 * а не отдельными обращениями к серверу.
 *
 * Два правила, без которых паспорт сам стал бы источником отказов:
 *
 * 1. Проба запускается как `sh -c '…'`. Удалённая команда исполняется login-shell
 *    пользователя, а он может оказаться csh или fish с другим синтаксисом; запуск
 *    программы с аргументом валиден в любом shell. Удалённый сторож к пробе не
 *    применяется — язык команд как раз ею и выясняется.
 * 2. Ответ читается по маркеру: баннер, motd и посторонний вывод игнорируются.
 *    Маркера нет — считаем, что не знаем ничего, и работаем по осторожному пути.
 *    Паспорт ускоряет и уточняет, но ничего не разрешает.
 */

import { logger } from '../utils/logger.js';

/** Чем на сервере считать sha256 */
export type Sha256Tool = 'sha256sum' | 'openssl' | 'none';

/** Какой набор базовых утилит стоит на сервере */
type UtilityFlavor = 'coreutils' | 'busybox' | 'unknown';

export interface ServerPassport {
  /** Есть ли bash — от этого зависит язык, на котором мы шлём команды */
  bash: boolean;
  sha256: Sha256Tool;
  coreutils: UtilityFlavor;
  rsync: boolean;
  /** Есть ли утилита `timeout` для удалённого сторожа */
  remoteTimeout: boolean;
  /**
   * Есть ли `setsid` — им отвязывается фоновая задача.
   *
   * Без него задача остаётся в сессии ssh и её нельзя снять группой:
   * pid лидера совпадает с pgid только у отдельной сессии.
   */
  setsid: boolean;
  install: boolean;
  /** Что сказал `uname -s` — для диагностики и текстов ошибок */
  os: string;
  /**
   * Домашний каталог пользователя — единственное, чем можно раскрыть `~`.
   *
   * Раскрывать тильду на сервере нельзя: путь уходит в командах в одинарных
   * кавычках, где `~` остаётся буквой, а без кавычек любое имя с пробелом или
   * `$` разъедется. Пустая строка означает «не знаем» — тогда `~`-путь
   * отклоняется, а не угадывается.
   */
  home: string;
  /** Удалось ли вообще прочитать паспорт */
  known: boolean;
}

const MARKER = 'SSH_MCP_PASSPORT';

/**
 * Самое осторожное состояние: ничего не предполагаем.
 *
 * Ни bash, ни удалённого сторожа, хэши считать нечем. Каждое из этих значений
 * приводит к более медленному, но безопасному пути — и ни одно из них не
 * запрещает саму операцию.
 */
export const UNKNOWN_PASSPORT: ServerPassport = Object.freeze({
  bash: false,
  sha256: 'none',
  coreutils: 'unknown',
  rsync: false,
  remoteTimeout: false,
  setsid: false,
  install: false,
  os: 'unknown',
  home: '',
  known: false,
});

/**
 * Проба: одна строка вывода, ничего лишнего.
 *
 * Набор утилит различается по `ls --version`: он есть у coreutils и отсутствует
 * у BusyBox. Проверять этим же способом `sha256sum` нельзя — его может не быть
 * вовсе, и тогда машина ошибочно считалась бы BusyBox-ом.
 *
 * Домашний каталог печатается последним: в нём бывают пробелы, и читать его
 * приходится до конца строки, а не как остальные поля.
 */
export const PASSPORT_PROBE_COMMAND =
  `sh -c 'printf "${MARKER} bash=%s sha256=%s coreutils=%s rsync=%s timeout=%s setsid=%s install=%s os=%s home=%s\\n" ` +
  `"$(command -v bash >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v sha256sum >/dev/null 2>&1 && echo sha256sum || { command -v openssl >/dev/null 2>&1 && echo openssl || echo none; })" ` +
  `"$(ls --version >/dev/null 2>&1 && echo coreutils || echo busybox)" ` +
  `"$(command -v rsync >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v timeout >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v setsid >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v install >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(uname -s 2>/dev/null || echo unknown)" ` +
  `"$HOME"'`;

/** Разобрать вывод пробы. Незнакомые значения трактуются как «не знаем». */
export function parsePassport(stdout: string): ServerPassport {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  if (!line) return UNKNOWN_PASSPORT;

  const body = line.slice(line.indexOf(MARKER) + MARKER.length).trim();

  // Домашний каталог отрезается первым и целиком: в нём бывают пробелы, и
  // разбор по ним обрезал бы путь до первого — то есть увёл бы запись в
  // соседний каталог
  const homeAt = body.indexOf('home=');
  const home = homeAt >= 0 ? body.slice(homeAt + 'home='.length).trim() : '';

  const fields = new Map<string, string>();
  for (const token of (homeAt >= 0 ? body.slice(0, homeAt) : body).trim().split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
  }

  const isSet = (key: string): boolean => fields.get(key) === '1';
  const sha256 = fields.get('sha256');
  const coreutils = fields.get('coreutils');

  return {
    bash: isSet('bash'),
    sha256: sha256 === 'sha256sum' || sha256 === 'openssl' ? sha256 : 'none',
    coreutils: coreutils === 'coreutils' || coreutils === 'busybox' ? coreutils : 'unknown',
    rsync: isSet('rsync'),
    remoteTimeout: isSet('timeout'),
    setsid: isSet('setsid'),
    install: isSet('install'),
    os: fields.get('os') || 'unknown',
    // Только абсолютный путь: всё остальное — признак того, что переменной на
    // сервере нет, и лучше отказать, чем записать файл наугад
    home: home.startsWith('/') ? home : '',
    known: true,
  };
}

/** Проба, снимающая паспорт: возвращает stdout удалённой команды */
export type PassportProbe = () => Promise<string>;

/**
 * Ключ назначения — тот же `user@host:port`, что у кэша транспортов.
 *
 * Считается в одном месте: инструменты спрашивают паспорт через executor,
 * транспорт — сам у себя, и оба обязаны попадать в одну запись кэша.
 */
export function passportKey(config: { username: string; host: string; port?: number }): string {
  return `${config.username}@${config.host}:${config.port ?? 22}`;
}

/**
 * Кэшируется промис, а не результат: иначе две параллельные первые команды
 * запустят пробу наперегонки и дадут два лишних обращения к серверу.
 */
const passportCache = new Map<string, Promise<ServerPassport>>();

/**
 * Паспорт назначения. Ключ — то же `user@host:port`, что у кэша транспортов:
 * два профиля на один сервер под одним пользователем видят один паспорт.
 */
export async function getServerPassport(
  key: string,
  probe: PassportProbe
): Promise<ServerPassport> {
  const cached = passportCache.get(key);
  if (cached) return cached;

  const pending = probe()
    .then(parsePassport)
    .catch((error: Error) => {
      // Сбой пробы не должен мешать самой операции: она может быть вполне
      // выполнима. Запись не оставляем — следующий вызов попробует снова.
      passportCache.delete(key);
      logger.debug(`[Passport] ${key}: probe failed (${error.message}), assuming nothing`);
      return UNKNOWN_PASSPORT;
    });

  passportCache.set(key, pending);
  return pending;
}

/**
 * Забыть паспорт назначения.
 *
 * Нужно, когда сервер изменился под нами: обещанной утилиты не оказалось на
 * месте, сменились учётные данные, переставили пакеты.
 */
export function invalidatePassport(key: string): void {
  passportCache.delete(key);
}

/** Сбросить весь кэш (используется в тестах) */
export function resetPassportCache(): void {
  passportCache.clear();
}
