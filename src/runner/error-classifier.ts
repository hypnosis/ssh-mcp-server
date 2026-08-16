/**
 * Классификация сбоев ssh
 *
 * Единственное место, где разбирается текст сообщений OpenSSH. Задача —
 * отличить сбой транспорта (можно повторить) от отказа аутентификации
 * (повторять вредно: каждая попытка засчитывается сервером как неудачный вход)
 * и от честного ненулевого кода удалённой команды (не сбой вовсе).
 */

import {
  SSHAuthError,
  SSHBinaryMissingError,
  SSHHostKeyError,
  SSHMuxLimitError,
  SSHRunnerError,
  SSHChannelClosedError,
  SSHTransportError,
} from './errors.js';

/** Код возврата, которым ssh сообщает о собственном сбое */
export const SSH_FAILURE_EXIT_CODE = 255;

/**
 * Наблюдаемый исход запуска ssh
 */
export interface SpawnOutcome {
  /** Ошибка запуска процесса (ssh не найден и т.п.) */
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  stderr: string;
  /** Нужен, чтобы отличить оборванный канал от команды, вернувшей 255 */
  stdout?: string;
}

const AUTH_PATTERNS = [
  /permission denied/i,
  /too many authentication failures/i,
  /no supported authentication methods/i,
  /authentication failed/i,
];

const HOST_KEY_PATTERNS = [
  /host key verification failed/i,
  /remote host identification has changed/i,
  /host key for .* has changed/i,
];

const TRANSPORT_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection reset by peer/i,
  /connection closed by/i,
  /broken pipe/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
];

const MUX_LIMIT_PATTERNS = [
  /mux_client_request_session/i,
  /open failed: administratively prohibited/i,
];

/**
 * Служебная переписка клиента с собственным управляющим соединением.
 *
 * Отказ в сессии клиент лечит сам — открывает отдельное соединение и
 * возвращает нулевой код (замерено на клиентах 9.2, 9.7 и 10.2). Но жалобу он
 * при этом печатает, и она попадает в stderr команды: тот, кто судит об успехе
 * по непустому stderr, увидит ошибку там, где её не было.
 */
const MUX_NOTICE_PATTERNS = [
  /^mux_client_\w+: /,
  /^ControlSocket .+ already exists, disabling multiplexing$/,
];

/** Убрать служебные строки мультиплексирования из вывода команды */
export function stripMuxNotices(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !matchesAny(line.replace(/\r$/, ''), MUX_NOTICE_PATTERNS))
    .join('\n');
}

/**
 * Признак того, что сервер разорвал уже установленное соединение.
 * Самая частая причина — защитный механизм вроде fail2ban, и без подсказки
 * такую ошибку легко принять за сетевую неполадку.
 */
const SERVER_DROPPED_PATTERNS = [/connection closed by/i, /connection reset by peer/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Похож ли вывод на сообщение самого ssh, а не удалённой команды
 */
function looksLikeSshDiagnostic(stderr: string): boolean {
  return /^(ssh|scp|ssh_|mux_|kex_|Warning: |Permission denied|Host key)/im.test(stderr);
}

/**
 * Разобрать исход запуска.
 *
 * @returns Ошибка транспорта либо null, если сбоя транспорта не было
 *          и результат следует трактовать как обычный ExecResult.
 */
export function classifySpawnOutcome(
  outcome: SpawnOutcome,
  context: { host: string; port: number; idempotent?: boolean }
): SSHRunnerError | null {
  const { spawnError, exitCode, stderr } = outcome;

  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      return new SSHBinaryMissingError(
        'OpenSSH client not found in PATH. Install it (macOS: preinstalled; ' +
        'Debian/Ubuntu: apt install openssh-client; Windows: optional feature ' +
        '"OpenSSH Client"), or pin @hypnosis/ssh-mcp-server@1.x to use the ' +
        'bundled SSH implementation.'
      );
    }
    return new SSHTransportError(`Failed to start ssh: ${spawnError.message}`);
  }

  // Ненулевой код от удалённой команды сбоем транспорта не является
  if (exitCode !== SSH_FAILURE_EXIT_CODE) {
    return null;
  }

  const target = `${context.host}:${context.port}`;
  const detail = stderr.trim() || 'no diagnostic output';

  if (matchesAny(stderr, HOST_KEY_PATTERNS)) {
    return new SSHHostKeyError(
      `Host key verification failed for ${target}. If the server was legitimately ` +
      `rebuilt, remove the stale entry with: ssh-keygen -R ${context.host}. ` +
      `Otherwise this may be a man-in-the-middle attempt. Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  if (matchesAny(stderr, AUTH_PATTERNS)) {
    return new SSHAuthError(
      `Authentication failed for ${target}. Check username, key path and key ` +
      `permissions (600). Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  if (matchesAny(stderr, TRANSPORT_PATTERNS)) {
    const hint = matchesAny(stderr, SERVER_DROPPED_PATTERNS)
      ? ' The server accepted the TCP connection and then dropped it — ' +
        'a rate limiter or ban list (fail2ban, sshd MaxStartups) is a likely cause.'
      : '';
    return new SSHTransportError(
      `Cannot reach ${target}. Details: ${detail}${hint}`,
      { exitCode, stderr }
    );
  }

  // Ниже транспортных проверок намеренно: до кода 255 дело доходит, только
  // когда клиенту не удалось и отдельное соединение, а причина отказа там —
  // не лимит сессий. Стой этот разбор выше, диагноз подменялся бы.
  if (matchesAny(stderr, MUX_LIMIT_PATTERNS)) {
    return new SSHMuxLimitError(
      `Server refused an additional multiplexed session on ${target} ` +
      `(MaxSessions reached). Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  // Код 255 без узнаваемого сообщения: либо ssh сообщил о чём-то новом,
  // либо удалённая команда сама вернула 255. Различаем по виду вывода.
  if (looksLikeSshDiagnostic(stderr)) {
    return new SSHTransportError(
      `ssh failed for ${target}. Details: ${detail}`,
      { exitCode, stderr }
    );
  }

  // Код 255 и ни знака вывода — оборванный канал: команда не успела ничего
  // напечатать, потому что не запускалась. Так отвечает dropbear на залп
  // коротких команд по общему соединению. Признак нестрогий, поэтому он читается
  // только там, где повтор объявлен безопасным: команда, вернувшая 255 сама,
  // остаётся обычным результатом для всех остальных вызовов.
  if (context.idempotent && !stderr.trim() && !(outcome.stdout ?? '').trim()) {
    return new SSHChannelClosedError(
      `The channel to ${target} closed before the command produced output.`,
      { exitCode, stderr }
    );
  }

  return null;
}
