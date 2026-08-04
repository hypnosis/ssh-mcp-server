/**
 * Проверка окружения: есть ли системный ssh и что он умеет
 *
 * Результат вычисляется один раз за процесс: версия клиента не меняется
 * на ходу, а спавн процесса на каждую команду был бы лишним.
 */

import { execFile } from 'child_process';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { SSHUnsupportedConfigError } from './errors.js';
import { needsAskpass, type RunnerConfig, type SshCapabilities } from './ssh-args.js';

/** Разобранная версия OpenSSH */
export interface SshVersion {
  major: number;
  minor: number;
  /** Исходная строка, как её напечатал ssh -V */
  raw: string;
}

/** Что умеет обнаруженный клиент */
export interface SshRuntime {
  /** Найден ли бинарник */
  available: boolean;
  version?: SshVersion;
  /** Поддерживается ли мультиплексирование соединений */
  multiplexing: boolean;
  /** Почему мультиплексирование недоступно */
  multiplexingDisabledReason?: string;
  /** Поддерживается ли SSH_ASKPASS_REQUIRE=force — без него нельзя подать пароль */
  askpassForce: boolean;
  /**
   * Идёт ли передача файлов поверх SFTP, а не классическим протоколом scp.
   * От этого зависит судьба удалённого пути: в классическом протоколе его
   * разбирает shell сервера, в SFTP-режиме путь-приёмник берётся буквально.
   */
  scpOverSftp: boolean;
  /** Каталог для управляющих сокетов и askpass-скрипта */
  controlDir: string;
}

/** ControlPersist появился в OpenSSH 5.6 */
const MIN_MULTIPLEXING_VERSION = { major: 5, minor: 6 };
/** SSH_ASKPASS_REQUIRE появился в OpenSSH 8.4 */
const MIN_ASKPASS_FORCE_VERSION = { major: 8, minor: 4 };
/** С OpenSSH 9.0 scp по умолчанию гоняет файлы поверх SFTP */
const MIN_SFTP_TRANSFER_VERSION = { major: 9, minor: 0 };

let cachedRuntime: SshRuntime | undefined;

/**
 * Разобрать вывод `ssh -V`
 *
 * Примеры: "OpenSSH_10.2p1, LibreSSL 3.3.6",
 *          "OpenSSH_8.9p1 Ubuntu-3ubuntu0.4, OpenSSL 3.0.2",
 *          "OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3"
 */
export function parseSshVersion(output: string): SshVersion | undefined {
  // Между OpenSSH_ и номером может стоять название сборки, как в Windows-порте
  const match = /OpenSSH_(?:[A-Za-z][A-Za-z_]*_)?(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    raw: output.trim().split('\n')[0],
  };
}

/** Не меньше ли версия указанного минимума */
function isAtLeast(version: SshVersion, minimum: { major: number; minor: number }): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  return version.minor >= minimum.minor;
}

/**
 * Вычислить возможности по версии и платформе — чистая функция
 */
export function computeRuntime(input: {
  platform: NodeJS.Platform;
  version?: SshVersion;
  controlDir: string;
}): SshRuntime {
  const { platform, version, controlDir } = input;

  if (!version) {
    return {
      available: false,
      multiplexing: false,
      multiplexingDisabledReason: 'ssh not found',
      askpassForce: false,
      scpOverSftp: false,
      controlDir,
    };
  }

  if (platform === 'win32') {
    // Мультиплексирование опирается на передачу дескрипторов через unix-сокеты,
    // чего в Windows нет. Всё остальное работает, но каждая команда будет
    // открывать своё соединение.
    return {
      available: true,
      version,
      multiplexing: false,
      multiplexingDisabledReason: 'connection multiplexing is not supported by OpenSSH on Windows',
      askpassForce: false,
      scpOverSftp: isAtLeast(version, MIN_SFTP_TRANSFER_VERSION),
      controlDir,
    };
  }

  const multiplexing = isAtLeast(version, MIN_MULTIPLEXING_VERSION);

  return {
    available: true,
    version,
    multiplexing,
    multiplexingDisabledReason: multiplexing
      ? undefined
      : `ControlPersist requires OpenSSH 5.6+, found ${version.raw}`,
    askpassForce: isAtLeast(version, MIN_ASKPASS_FORCE_VERSION),
    scpOverSftp: isAtLeast(version, MIN_SFTP_TRANSFER_VERSION),
    controlDir,
  };
}

/**
 * Каталог для управляющих сокетов.
 *
 * Не во временном каталоге системы: предсказуемое имя в общедоступном месте —
 * это возможность подсунуть свой сокет. Права 0700 оставляют доступ владельцу.
 */
export function resolveControlDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SSH_MCP_CONTROL_DIR || join(homedir(), '.ssh', 'ssh-mcp');
}

/** Создать каталог с правами 0700, если его ещё нет */
export function ensureControlDir(controlDir: string): void {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
}

/** Запустить `ssh -V` и вернуть его вывод */
function readSshVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // ssh -V печатает версию в stderr
    execFile('ssh', ['-V'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(undefined);
        return;
      }
      resolve(`${stderr}${stdout}`.trim() || undefined);
    });
  });
}

/**
 * Обнаружить системный ssh и его возможности (результат кэшируется)
 */
export async function detectRuntime(options: { force?: boolean } = {}): Promise<SshRuntime> {
  if (cachedRuntime && !options.force) {
    return cachedRuntime;
  }

  const controlDir = resolveControlDir();
  const output = await readSshVersion();
  const version = output ? parseSshVersion(output) : undefined;
  const runtime = computeRuntime({ platform: process.platform, version, controlDir });

  if (!runtime.available) {
    logger.warn('[Runner] OpenSSH client not found in PATH — SSH tools will fail until it is installed');
  } else {
    logger.info(
      `[Runner] ${runtime.version?.raw}, multiplexing: ${runtime.multiplexing ? 'on' : 'off'}` +
      (runtime.multiplexingDisabledReason ? ` (${runtime.multiplexingDisabledReason})` : '')
    );
    if (runtime.multiplexing) {
      ensureControlDir(controlDir);
    }
  }

  cachedRuntime = runtime;
  return runtime;
}

/** Сбросить кэш — используется в тестах */
export function resetRuntimeCache(): void {
  cachedRuntime = undefined;
}

/** Возможности в форме, которую ожидает построение аргументов */
export function toCapabilities(runtime: SshRuntime): SshCapabilities {
  return {
    multiplexing: runtime.multiplexing,
    controlDir: runtime.controlDir,
    scpOverSftp: runtime.scpOverSftp,
  };
}

/**
 * Проверить, что окружение потянет этот профиль.
 *
 * @throws SSHUnsupportedConfigError если профилю нужен ввод секрета,
 *         а клиент этого не умеет
 */
export function assertProfileSupported(config: RunnerConfig, runtime: SshRuntime): void {
  if (!needsAskpass(config)) return;

  if (process.platform === 'win32') {
    throw new SSHUnsupportedConfigError(
      'Password and passphrase authentication is not supported on Windows with the ' +
      'OpenSSH backend. Use a passphrase-less key (privateKeyPath), or pin ' +
      '@hypnosis/ssh-mcp-server@1.x.'
    );
  }

  if (!runtime.askpassForce) {
    throw new SSHUnsupportedConfigError(
      `Password and passphrase authentication requires OpenSSH 8.4+ ` +
      `(SSH_ASKPASS_REQUIRE), found ${runtime.version?.raw ?? 'unknown version'}. ` +
      `Upgrade OpenSSH, or use a passphrase-less key (privateKeyPath).`
    );
  }
}
