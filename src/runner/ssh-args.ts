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

import type { SSHConfig } from '../utils/ssh-config.js';

/** Политика проверки ключа хоста */
export type StrictHostKeyChecking = 'yes' | 'accept-new' | 'no';

/**
 * Конфигурация профиля с опциональными транспортными настройками.
 * Поля добавляются к формату профилей аддитивно — старые файлы остаются валидными.
 */
export interface RunnerConfig extends SSHConfig {
  /** Политика проверки ключа хоста (по умолчанию accept-new) */
  strictHostKeyChecking?: StrictHostKeyChecking;
  /** Игнорировать пользовательский ~/.ssh/config */
  ignoreUserConfig?: boolean;
}

/**
 * Возможности окружения, влияющие на набор аргументов
 */
export interface SshCapabilities {
  /** Поддерживается ли мультиплексирование (на нативном Windows — нет) */
  multiplexing: boolean;
  /** Каталог для управляющих сокетов (права 0700) */
  controlDir: string;
}

/**
 * Настройки, у которых есть разумные значения по умолчанию
 */
export interface SshArgsOptions {
  /** Сколько держать соединение живым после последней команды, секунды */
  controlPersistSec?: number;
  /** Таймаут установки соединения, секунды */
  connectTimeoutSec?: number;
  /** Интервал keepalive-проб, секунды */
  serverAliveIntervalSec?: number;
  /** Сколько проб без ответа считать разрывом */
  serverAliveCountMax?: number;
}

const DEFAULT_CONTROL_PERSIST_SEC = 600;
const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_SERVER_ALIVE_INTERVAL_SEC = 15;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;

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
  return `${controlDir}/s-%C`;
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
    controlPersistSec = DEFAULT_CONTROL_PERSIST_SEC,
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
    args.push('-o', `ControlPersist=${controlPersistSec}`);
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
  const remoteSpec = buildRemoteSpec(config.host, remotePath);

  if (direction === 'upload') {
    args.push(localSpec, remoteSpec);
  } else {
    args.push(remoteSpec, localSpec);
  }

  return args;
}
