/**
 * Сверка переданных файлов по хэшам
 *
 * Один способ на все случаи: имена файлов идут аргументами, сервер печатает
 * хэши, сравнение происходит у нас. Так работает и coreutils, и BusyBox —
 * длинные опции (`--quiet`) и приём манифеста на stdin (`sha256sum -c -`)
 * нужны не везде, а на встраиваемых системах их нет вовсе.
 *
 * Исходов ровно три, и они не смешиваются: сошлось, не сошлось, проверить
 * нечем. Раньше «нечем» приходило кодом 127 и текстом в stderr, а искали его
 * в stdout — и передача на сервер без sha256sum выглядела как испорченная.
 */

import { invalidatePassport, passportKey, type Sha256Tool } from '../runner/passport.js';
import { logger } from '../utils/logger.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/tmp-name.js';
import type { SSHExecutor } from './ssh-executor.js';

/** Сколько имён отдаём одной команде */
const MAX_PATHS_PER_COMMAND = 100;
/** Предел длины командной строки; на встраиваемых системах он куда ниже обычного */
const MAX_COMMAND_LENGTH = 32 * 1024;
/** Код возврата shell, когда программы нет на месте */
const COMMAND_NOT_FOUND = 127;

export interface VerifyEntry {
  path: string;
  hash: string;
}

export type VerifyOutcome =
  | { status: 'matched' }
  | { status: 'mismatched'; paths: string[] }
  | { status: 'unavailable'; reason: string };

/**
 * Сверить файлы на сервере с локально посчитанными хэшами.
 *
 * Не бросает на неудачной проверке: несовпадение — это ответ, по которому
 * вызывающий решает сам (одному нужно откатить установку, другому — только
 * предупредить).
 */
export async function verifyRemoteFiles(
  executor: SSHExecutor,
  config: SSHConfig,
  entries: VerifyEntry[],
  options: { profileName: string; sudo?: boolean }
): Promise<VerifyOutcome> {
  if (entries.length === 0) {
    // Пустой список — это не «всё сошлось»: скорее всего файлы не нашлись
    return { status: 'unavailable', reason: 'there were no files to verify' };
  }

  const passport = await executor.passport(config, options.profileName);
  if (passport.sha256 === 'none') {
    return {
      status: 'unavailable',
      reason: passport.known
        ? 'neither sha256sum nor openssl is available on the server'
        : 'the server did not answer which hashing tool it has',
    };
  }

  const remoteHashes = await collectRemoteHashes(executor, config, entries, passport.sha256, options);

  if (remoteHashes === 'tool-missing') {
    // Паспорт обещал утилиту, а её нет: сервер изменился под нами.
    // Забываем запись и спрашиваем заново — вдруг остался openssl.
    invalidatePassport(passportKey(config));
    const refreshed = await executor.passport(config, options.profileName);

    if (refreshed.sha256 === 'none' || refreshed.sha256 === passport.sha256) {
      return { status: 'unavailable', reason: `${passport.sha256} is not available on the server` };
    }

    const retried = await collectRemoteHashes(executor, config, entries, refreshed.sha256, options);
    if (retried === 'tool-missing') {
      return { status: 'unavailable', reason: `${refreshed.sha256} is not available on the server` };
    }
    return compare(entries, retried);
  }

  return compare(entries, remoteHashes);
}

/** Спросить у сервера хэши всех файлов, разбив список на посильные команды */
async function collectRemoteHashes(
  executor: SSHExecutor,
  config: SSHConfig,
  entries: VerifyEntry[],
  tool: Exclude<Sha256Tool, 'none'>,
  options: { profileName: string; sudo?: boolean }
): Promise<Map<string, string> | 'tool-missing'> {
  const hashes = new Map<string, string>();

  for (const chunk of splitIntoCommands(entries.map((entry) => entry.path))) {
    const result = await executor.execute(config, buildHashCommand(tool, chunk), {
      profileName: options.profileName,
      sudo: options.sudo,
      idempotent: true,
    });

    if (result.exitCode === COMMAND_NOT_FOUND) return 'tool-missing';

    // Ненулевой код здесь — норма: нечитаемый файл в пачке не отменяет
    // остальные хэши, он просто не попадёт в разбор и не сойдётся
    if (result.exitCode !== 0) {
      logger.debug(`[Verify] hashing reported exit ${result.exitCode}: ${result.stderr.trim()}`);
    }

    for (const [path, hash] of parseHashOutput(result.stdout)) hashes.set(path, hash);
  }

  return hashes;
}

/** Команда, печатающая хэши списка файлов */
function buildHashCommand(tool: Exclude<Sha256Tool, 'none'>, paths: string[]): string {
  const quoted = paths.map(shellQuote).join(' ');
  // `--` защищает от имени, начинающегося с дефиса; openssl такого разделителя не знает
  return tool === 'sha256sum' ? `sha256sum -- ${quoted}` : `openssl dgst -sha256 ${quoted}`;
}

/**
 * Разобрать вывод любого из двух инструментов.
 *
 * sha256sum печатает `<hex>␣␣<путь>`, openssl — `SHA2-256(<путь>)= <hex>`
 * (в версиях до третьей — `SHA256(...)`). Строки, не похожие ни на одну из
 * форм, игнорируются: там может быть баннер или жалоба на нечитаемый файл.
 */
function parseHashOutput(stdout: string): Map<string, string> {
  const hashes = new Map<string, string>();

  for (const line of stdout.split('\n')) {
    const plain = /^([0-9a-fA-F]{64})[ \t][ *](.*)$/.exec(line);
    if (plain) {
      hashes.set(plain[2], plain[1].toLowerCase());
      continue;
    }

    const openssl = /^[A-Za-z0-9-]+\((.*)\)= ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (openssl) hashes.set(openssl[1], openssl[2].toLowerCase());
  }

  return hashes;
}

/** Сверить ожидаемое с полученным; молчание сервера о файле — тоже несовпадение */
function compare(entries: VerifyEntry[], remote: Map<string, string>): VerifyOutcome {
  const mismatched = entries
    .filter((entry) => remote.get(entry.path) !== entry.hash.toLowerCase())
    .map((entry) => entry.path);

  return mismatched.length === 0 ? { status: 'matched' } : { status: 'mismatched', paths: mismatched };
}

/** Разбить список путей так, чтобы каждая команда влезла в лимит командной строки */
function splitIntoCommands(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;

  for (const path of paths) {
    const cost = path.length + 4; // кавычки, пробел и запас на экранирование
    if (current.length > 0 && (current.length >= MAX_PATHS_PER_COMMAND || length + cost > MAX_COMMAND_LENGTH)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
