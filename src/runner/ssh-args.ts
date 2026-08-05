/**
 * Построение аргументов для системного ssh/scp
 *
 * Чистые функции без побочных эффектов: на вход — конфигурация профиля,
 * на выход — массив аргументов. Массив передаётся в spawn без участия shell,
 * поэтому спецсимволы в путях и именах интерпретироваться не могут.
 *
 * Секреты (пароль, passphrase) здесь не появляются никогда: аргументы процесса
 * видны в `ps` любому пользователю системы. Секрет доставляется через askpass.
 */

import { logger } from '../utils/logger.js';
import type { SSHConfig, StrictHostKeyChecking } from '../utils/ssh-config.js';

export type { StrictHostKeyChecking };

/**
 * Конфигурация профиля для транспорта.
 *
 * Совпадает с конфигурацией профиля: транспортные настройки
 * (проверка ключа хоста, отказ от ~/.ssh/config) живут там же, где host
 * и username, — это часть формата профиля, а не отдельная сущность.
 */
export type RunnerConfig = SSHConfig;

/**
 * Возможности окружения, влияющие на набор аргументов
 */
export interface SshCapabilities {
  /** Поддерживается ли мультиплексирование (на нативном Windows — нет) */
  multiplexing: boolean;
  /** Каталог для управляющих сокетов (права 0700) */
  controlDir: string;
  /**
   * Гоняет ли scp файлы поверх SFTP (клиент 9.0+). От этого зависит судьба
   * удалённого пути: в классическом протоколе его разбирает shell сервера,
   * в SFTP-режиме путь-приёмник берётся буквально.
   */
  scpOverSftp: boolean;
}

/**
 * Настройки, у которых есть разумные значения по умолчанию
 */
export interface SshArgsOptions {
  /** Таймаут установки соединения, секунды */
  connectTimeoutSec?: number;
  /** Интервал keepalive-проб, секунды */
  serverAliveIntervalSec?: number;
  /** Сколько проб без ответа считать разрывом */
  serverAliveCountMax?: number;
}

const DEFAULT_CONTROL_PERSIST_SEC = 600;
const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
/** Имя управляющего сокета начинается с этого — по нему же он и опознаётся в каталоге */
export const CONTROL_SOCKET_PREFIX = 's-';
const DEFAULT_SERVER_ALIVE_INTERVAL_SEC = 15;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;

/** О непонятном значении переменной предупреждаем один раз, а не на каждую команду */
let unknownPersistReported = false;

/**
 * Сколько соединение живёт после последней команды, секунды.
 *
 * Единственный источник: отсюда значение уходит и в команду ssh, и в ответ
 * инструментов о том, что осталось на машине. Ноль означает «закрывать сразу».
 */
export function resolveControlPersistSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SSH_MCP_CONTROL_PERSIST?.trim();
  if (!raw) return DEFAULT_CONTROL_PERSIST_SEC;

  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;

  if (!unknownPersistReported) {
    unknownPersistReported = true;
    logger.warn(
      `[Runner] Unusable SSH_MCP_CONTROL_PERSIST "${raw}", falling back to ${DEFAULT_CONTROL_PERSIST_SEC}. ` +
      `Expected a whole number of seconds, 0 to close immediately`
    );
  }

  return DEFAULT_CONTROL_PERSIST_SEC;
}

/** Забыть, что о значении уже предупреждали (используется в тестах) */
export function resetControlPersistWarning(): void {
  unknownPersistReported = false;
}

/**
 * Значение, которое ssh воспримет как опцию, а не как аргумент.
 * Хост вида "-oProxyCommand=..." в профиле — это подмена команды, а не хост.
 */
function assertNotOptionLike(value: string, fieldName: string): void {
  if (value.startsWith('-')) {
    throw new Error(
      `Invalid ${fieldName} "${value}": value must not start with "-" ` +
      `(it would be interpreted as an ssh option)`
    );
  }
}

/**
 * Нужен ли профилю интерактивный ввод секрета через askpass
 */
export function needsAskpass(config: RunnerConfig): boolean {
  return Boolean(config.password || config.passphrase);
}

/**
 * Путь к управляющему сокету.
 *
 * %C — хэш от (локальный хост, удалённый хост, порт, пользователь): короткий,
 * детерминированный и одинаковый во всех процессах, поэтому разные окна
 * клиента попадают на один и тот же сокет. Длина пути важна: лимит адреса
 * unix-сокета на macOS — 104 байта.
 */
export function buildControlPath(controlDir: string): string {
  return `${controlDir}/${CONTROL_SOCKET_PREFIX}%C`;
}

/**
 * Опции, общие для ssh и scp
 */
export function buildCommonOptions(
  config: RunnerConfig,
  caps: SshCapabilities,
  options: SshArgsOptions = {}
): string[] {
  assertNotOptionLike(config.host, 'host');
  assertNotOptionLike(config.username, 'username');
  if (config.privateKeyPath) {
    assertNotOptionLike(config.privateKeyPath, 'privateKeyPath');
  }

  const {
    connectTimeoutSec = DEFAULT_CONNECT_TIMEOUT_SEC,
    serverAliveIntervalSec = DEFAULT_SERVER_ALIVE_INTERVAL_SEC,
    serverAliveCountMax = DEFAULT_SERVER_ALIVE_COUNT_MAX,
  } = options;

  const args: string[] = [];

  // Пользовательский ~/.ssh/config читается по умолчанию: он даёт ProxyJump,
  // ssh-agent и политики алгоритмов бесплатно. Наши -o всегда его перекрывают.
  if (config.ignoreUserConfig) {
    args.push('-F', process.platform === 'win32' ? 'NUL' : '/dev/null');
  }

  // Мультиплексирование — то, ради чего всё затевалось: одна аутентификация
  // на окно ControlPersist вместо одной на каждую команду.
  if (caps.multiplexing) {
    args.push('-o', 'ControlMaster=auto');
    args.push('-o', `ControlPath=${buildControlPath(caps.controlDir)}`);
    args.push('-o', `ControlPersist=${resolveControlPersistSec()}`);
  }

  // Штатный keepalive вместо самодельных пингов командой
  args.push('-o', `ServerAliveInterval=${serverAliveIntervalSec}`);
  args.push('-o', `ServerAliveCountMax=${serverAliveCountMax}`);
  args.push('-o', `ConnectTimeout=${connectTimeoutSec}`);

  args.push('-o', `StrictHostKeyChecking=${config.strictHostKeyChecking ?? 'accept-new'}`);

  // Без этого предупреждения вида "Permanently added ..." попадают в stderr
  // и ломают классификацию ошибок
  args.push('-o', 'LogLevel=ERROR');

  args.push('-o', `User=${config.username}`);

  if (config.privateKeyPath) {
    args.push('-o', `IdentityFile=${config.privateKeyPath}`);
    // Без IdentitiesOnly клиент перебирает все ключи агента по очереди,
    // и каждый отвергнутый сервер считает неудачной попыткой входа
    args.push('-o', 'IdentitiesOnly=yes');
  } else if (config.password) {
    args.push('-o', 'PubkeyAuthentication=no');
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
    args.push('-o', 'NumberOfPasswordPrompts=1');
  }

  // BatchMode запрещает любые запросы ввода, включая askpass. Для профилей
  // с паролем или passphrase его ставить нельзя — иначе секрет некуда подать.
  if (!needsAskpass(config)) {
    args.push('-o', 'BatchMode=yes');
  }

  return args;
}

/**
 * Аргументы для выполнения команды: ssh [опции] <host> <command>
 */
export function buildSshArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  command: string,
  options: SshArgsOptions & { requestTty?: boolean } = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);

  args.push('-p', String(config.port ?? 22));

  if (options.requestTty) {
    // -tt форсирует псевдотерминал даже без локального tty. Нужен программам,
    // читающим /dev/tty напрямую. Побочный эффект — stderr сливается в stdout.
    args.push('-tt');
  }

  args.push(config.host);
  args.push(command);

  return args;
}

/**
 * Аргументы управляющей команды: ssh -O check|exit <host>
 */
export function buildControlArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  controlCommand: 'check' | 'exit' | 'stop',
  options: SshArgsOptions = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);
  args.push('-p', String(config.port ?? 22));
  args.push('-O', controlCommand);
  args.push(config.host);
  return args;
}

/**
 * Что происходит с удалённым путём по дороге к серверу.
 *
 * Замерено на одном клиенте (OpenSSH 10.2) в обоих режимах:
 * - `literal` — цель загрузки в SFTP-режиме. Путь уходит как есть, и обратный
 *   слэш стал бы частью имени: файл лёг бы под именем `a\ b.txt`, а следом
 *   развалились бы сверка, переименование и уборка — они ищут путь без него.
 * - `glob` — источник скачивания. Шаблоны раскрывает клиент, и `star*name.txt`
 *   тащит три посторонних файла; обратный слэш это чинит.
 * - `shell` — классический протокол (клиенты до 9.0). Путь разбирает shell
 *   сервера: пробел рвёт его на два аргумента, а `$(id)` исполняется.
 */
export type RemotePathUse = 'literal' | 'glob' | 'shell';

/**
 * Подготовить удалённый путь к передаче.
 *
 * Экранирование обратным слэшем — единственное, что работает: одинарные кавычки
 * в SFTP-режиме становятся частью имени, а в классическом дают `protocol error`.
 *
 * Не трогаем разделитель пути, безопасную латиницу с цифрами, тильду и всё, что
 * вне ASCII. Тильду — потому что её раскрывает сервер, и `\~/app.conf` уехал бы
 * в несуществующий каталог с именем `~` (замерено). Кириллицу — потому что она
 * работает и без экранирования.
 *
 * Перевод строки и возврат каретки не экранируются: `\` перед переводом строки
 * означает продолжение строки, символ исчезает, и имя становится другим. В
 * SFTP-режиме такой путь работает как есть, а в классическом остаток строки
 * выполняется на сервере как команда — поэтому там он отклоняется.
 */
export function prepareRemotePath(remotePath: string, use: RemotePathUse): string {
  if (use === 'literal') return remotePath;

  if (use === 'shell' && /[\n\r]/.test(remotePath)) {
    throw new Error(
      `Invalid remote path ${JSON.stringify(remotePath)}: a newline cannot be passed safely ` +
        'to the classic scp protocol (OpenSSH before 9.0) — the rest of the line would run ' +
        'on the server as a command'
    );
  }

  return escapeRemotePath(remotePath);
}

/** Экранировать всё, что удалённая сторона прочтёт как разметку, а не как имя */
export function escapeRemotePath(remotePath: string): string {
  return remotePath.replace(/[^A-Za-z0-9._/~\n\r\u0080-\uFFFF-]/g, (char) => `\\${char}`);
}

/**
 * Удалённый путь в формате scp.
 *
 * IPv6-адрес заключается в скобки, иначе двоеточия внутри адреса
 * будут прочитаны как разделитель хоста и пути.
 */
export function buildRemoteSpec(host: string, remotePath: string): string {
  const isIPv6 = host.includes(':');
  const hostPart = isIPv6 ? `[${host}]` : host;
  return `${hostPart}:${remotePath}`;
}

/**
 * Локальный путь для scp.
 *
 * Путь, содержащий двоеточие до первого слэша, scp примет за удалённый —
 * префикс "./" снимает двусмысленность.
 */
export function normalizeLocalSpec(localPath: string): string {
  const firstSlash = localPath.indexOf('/');
  const firstColon = localPath.indexOf(':');
  const colonLooksRemote = firstColon !== -1 && (firstSlash === -1 || firstColon < firstSlash);

  if (colonLooksRemote && !localPath.startsWith('/') && !localPath.startsWith('./')) {
    return `./${localPath}`;
  }
  return localPath;
}

/**
 * Аргументы передачи файла: scp [опции] <src> <dst>
 *
 * scp переиспользует то же master-соединение, что и ssh, потому что получает
 * те же ControlPath/ControlMaster — передача файла не создаёт новый вход.
 */
export function buildScpArgs(
  config: RunnerConfig,
  caps: SshCapabilities,
  direction: 'upload' | 'download',
  localPath: string,
  remotePath: string,
  options: SshArgsOptions & { recursive?: boolean } = {}
): string[] {
  const args = buildCommonOptions(config, caps, options);

  // У scp порт задаётся заглавной -P, в отличие от ssh
  args.push('-P', String(config.port ?? 22));
  args.push('-q');

  if (options.recursive) {
    args.push('-r');
  }

  const localSpec = normalizeLocalSpec(localPath);
  // Цель загрузки в SFTP-режиме — единственный путь, который уходит буквально:
  // экранирование сделало бы обратный слэш частью имени (замерено)
  const use: RemotePathUse = !caps.scpOverSftp ? 'shell' : direction === 'upload' ? 'literal' : 'glob';
  const remoteSpec = buildRemoteSpec(config.host, prepareRemotePath(remotePath, use));

  if (direction === 'upload') {
    args.push(localSpec, remoteSpec);
  } else {
    args.push(remoteSpec, localSpec);
  }

  return args;
}
