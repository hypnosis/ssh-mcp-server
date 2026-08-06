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
import { shellQuote } from '../utils/shell-arg.js';
import type { SSHExecutor } from './ssh-executor.js';

/** Сколько имён отдаём одной команде */
const MAX_PATHS_PER_COMMAND = 100;
/**
 * Предел длины команды в байтах — считается то, что уедет на сервер, а не
 * длина пути в знаках. Ядро Linux не принимает строку длиннее 128 KiB
 * (замерено на обоих серверах лаборатории), встраиваемые системы обрывают
 * раньше, поэтому берём вчетверо меньше потолка.
 */
const MAX_COMMAND_LENGTH = 32 * 1024;
/** Обвязка `sudo <shell> -c '…'`, в которую исполнитель заворачивает команду */
const SUDO_WRAPPER_BYTES = 15;
/** Код возврата shell, когда программы нет на месте */
const COMMAND_NOT_FOUND = 127;
/**
 * Команду убил сторож времени, и ответ неполный.
 *
 * Замерено: coreutils возвращает 124, BusyBox — 143 (это 128 + SIGTERM), и
 * работу убивают оба. Без этой проверки недосчитанные хэши читались как
 * расхождение, а по расхождению установщик сносит уже уехавшее дерево.
 */
const GUARD_KILLED_EXIT_CODES = [124, 143];
/**
 * Имена, которые разбор по строкам не восстановит.
 *
 * BusyBox печатает имя как есть, поэтому перевод строки внутри имени разрывает
 * строку вывода пополам и путь теряется (замерено на обоих серверах: дерево с
 * таким файлом объявлялось испорченным и сносилось). Такие файлы спрашиваем по
 * одному — тогда имя разбирать не нужно, оно известно нам заранее.
 */
const NAME_BREAKS_LINES = /[\n\r]/;

export interface VerifyEntry {
  path: string;
  hash: string;
}

export interface VerifyOptions {
  profileName: string;
  sudo?: boolean;
  /**
   * Потолок на хеширование, миллисекунды. Ноль — потолка нет, и это здесь
   * значение по умолчанию: время сверки задаёт объём данных, а не сеть.
   * Общие для команд 30 секунд обрывали бы дерево на несколько гигабайт —
   * причём уже после успешной передачи.
   */
  timeoutMs?: number;
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
  options: VerifyOptions
): Promise<VerifyOutcome> {
  if (entries.length === 0) {
    // Пустой список — это не «всё сошлось»: скорее всего файлы не нашлись
    return { status: 'unavailable', reason: 'there were no files to verify' };
  }

  const passport = await executor.passport(config);
  if (passport.sha256 === 'none') {
    return {
      status: 'unavailable',
      reason: passport.known
        ? 'neither sha256sum nor openssl is available on the server'
        : 'the server did not answer which hashing tool it has',
    };
  }

  const remoteHashes = await collectRemoteHashes(executor, config, entries, passport.sha256, options);

  if (remoteHashes === 'truncated' || remoteHashes === 'guard-killed') {
    return { status: 'unavailable', reason: incompleteReason(remoteHashes) };
  }

  if (remoteHashes === 'tool-missing') {
    // Паспорт обещал утилиту, а её нет: сервер изменился под нами.
    // Забываем запись и спрашиваем заново — вдруг остался openssl.
    invalidatePassport(passportKey(config));
    const refreshed = await executor.passport(config);

    if (refreshed.sha256 === 'none' || refreshed.sha256 === passport.sha256) {
      return { status: 'unavailable', reason: `${passport.sha256} is not available on the server` };
    }

    const retried = await collectRemoteHashes(executor, config, entries, refreshed.sha256, options);
    if (retried === 'tool-missing') {
      return { status: 'unavailable', reason: `${refreshed.sha256} is not available on the server` };
    }
    if (retried === 'truncated' || retried === 'guard-killed') {
      return { status: 'unavailable', reason: incompleteReason(retried) };
    }
    return compare(entries, retried);
  }

  return compare(entries, remoteHashes);
}

/**
 * Почему ответ сервера неполон.
 *
 * Неполный ответ обязан читаться как «проверить нечем»: иначе недостающие
 * хэши выглядят как испорченные файлы, и установщик сносит целые данные.
 */
function incompleteReason(outcome: 'truncated' | 'guard-killed'): string {
  return outcome === 'truncated'
    ? 'the hashing output did not fit the transport buffer'
    : 'hashing was killed by the timeout guard on the server';
}

/** Спросить у сервера хэши всех файлов, разбив список на посильные команды */
async function collectRemoteHashes(
  executor: SSHExecutor,
  config: SSHConfig,
  entries: VerifyEntry[],
  tool: Exclude<Sha256Tool, 'none'>,
  options: VerifyOptions
): Promise<Map<string, string> | 'tool-missing' | 'truncated' | 'guard-killed'> {
  const hashes = new Map<string, string>();
  const paths = entries.map((entry) => entry.path);

  const ask = (chunk: string[]) =>
    executor.execute(config, buildHashCommand(tool, chunk), {
      profileName: options.profileName,
      sudo: options.sudo,
      idempotent: true,
      timeout: options.timeoutMs ?? 0,
    });

  /** Ненулевой код — норма: нечитаемый файл не отменяет остальные хэши */
  const note = (exitCode: number, stderr: string) => {
    if (exitCode !== 0) logger.debug(`[Verify] hashing reported exit ${exitCode}: ${stderr.trim()}`);
  };

  const listed = splitIntoCommands(
    paths.filter((path) => !NAME_BREAKS_LINES.test(path)),
    tool,
    options.sudo === true
  );

  for (const chunk of listed) {
    const result = await ask(chunk);

    if (result.exitCode === COMMAND_NOT_FOUND) return 'tool-missing';
    if (GUARD_KILLED_EXIT_CODES.includes(result.exitCode)) return 'guard-killed';
    // Буфер транспорта режет хвост вывода: недостающие хэши выглядели бы как
    // расхождение, а по расхождению установщик сносит уже уехавшее дерево
    if (result.truncated) return 'truncated';
    note(result.exitCode, result.stderr);

    for (const [path, hash] of parseHashOutput(result.stdout)) hashes.set(path, hash);
  }

  for (const path of paths.filter((entry) => NAME_BREAKS_LINES.test(entry))) {
    const result = await ask([path]);

    if (result.exitCode === COMMAND_NOT_FOUND) return 'tool-missing';
    if (GUARD_KILLED_EXIT_CODES.includes(result.exitCode)) return 'guard-killed';
    if (result.truncated) return 'truncated';
    note(result.exitCode, result.stderr);

    const hash = hashOfSingleOutput(result.stdout, tool);
    if (hash) hashes.set(path, hash);
  }

  return hashes;
}

/**
 * Начало команды до первого имени.
 *
 * `--` защищает от имени, начинающегося с дефиса; openssl такого разделителя
 * не знает.
 */
function commandPrefix(tool: Exclude<Sha256Tool, 'none'>): string {
  return tool === 'sha256sum' ? 'sha256sum -- ' : 'openssl dgst -sha256 ';
}

/** Команда, печатающая хэши списка файлов */
function buildHashCommand(tool: Exclude<Sha256Tool, 'none'>, paths: string[]): string {
  return commandPrefix(tool) + paths.map(shellQuote).join(' ');
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
    const plain = /^(\\?)([0-9a-fA-F]{64})[ \t][ *](.*)$/.exec(line);
    if (plain) {
      hashes.set(plain[1] ? unescapeName(plain[3]) : plain[3], plain[2].toLowerCase());
      continue;
    }

    const openssl = /^[A-Za-z0-9-]+\((.*)\)= ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (openssl) hashes.set(openssl[1], openssl[2].toLowerCase());
  }

  return hashes;
}

/**
 * Вернуть имени исходный вид.
 *
 * coreutils, встретив в имени обратный слэш, перевод строки или возврат
 * каретки, ставит перед хэшем `\` и экранирует внутри ровно эти три символа
 * (замерено: остальные — кавычка, апостроф, табуляция, звёздочка — идут как
 * есть). Без обратного разбора файл `a\b.txt` не находился в ответе сервера,
 * сверка объявляла расхождение и установщик сносил уже уехавшее дерево.
 *
 * Здесь встречается только обратный слэш: имена с переводом строки и возвратом
 * каретки до общего разбора не доходят — их спрашивают по одному.
 */
function unescapeName(name: string): string {
  return name.replace(/\\\\/g, '\\');
}

/**
 * Хэш из ответа на команду про один-единственный файл.
 *
 * Имя здесь не разбирается вовсе — оно известно вызывающему, а в выводе может
 * быть разорвано переводом строки. Зато важно, чем считали: имя файла способно
 * повторять форму чужой утилиты. Проверено — при разборе «сначала sha256sum,
 * потом openssl» файл с именем `x⏎<64 знака>␣␣y.txt` на сервере с одним openssl
 * объявлялся сошедшимся по хэшу, взятому из собственного имени.
 *
 * У sha256sum хэш открывает вывод, у openssl — закрывает строку, поэтому берём
 * первое и последнее вхождение соответственно.
 */
function hashOfSingleOutput(stdout: string, tool: Exclude<Sha256Tool, 'none'>): string | null {
  if (tool === 'openssl') {
    const openssl = /\)= ([0-9a-fA-F]{64})\s*$/.exec(stdout);
    return openssl ? openssl[1].toLowerCase() : null;
  }

  // Файл ровно один, значит хэш открывает вывод. Без якоря ответом сошла бы
  // любая похожая строка ниже — например, кусок имени самого файла
  const sum = /^\\?([0-9a-fA-F]{64})[ \t][ *]/.exec(stdout);
  return sum ? sum[1].toLowerCase() : null;
}

/** Сверить ожидаемое с полученным; молчание сервера о файле — тоже несовпадение */
function compare(entries: VerifyEntry[], remote: Map<string, string>): VerifyOutcome {
  const mismatched = entries
    .filter((entry) => remote.get(entry.path) !== entry.hash.toLowerCase())
    .map((entry) => entry.path);

  return mismatched.length === 0 ? { status: 'matched' } : { status: 'mismatched', paths: mismatched };
}

/**
 * Во что имя обходится в строке команды: кавычки, экранирование внутри них и
 * пробел до соседа. Под sudo вся команда уезжает внутрь `sudo sh -c '…'`, то
 * есть каждое имя закавычивается второй раз, и апострофы в нём растут вчетверо.
 */
function pathCost(path: string, sudo: boolean): number {
  const quoted = shellQuote(path);
  return Buffer.byteLength(sudo ? shellQuote(quoted) : quoted) + 1;
}

/**
 * Разбить список путей так, чтобы каждая команда влезла в предел.
 *
 * Считаются байты отправляемой строки: русское имя в UTF-8 весит вдвое больше
 * своей длины в знаках, имя из апострофов — вчетверо, а под sudo к этому
 * добавляется второй круг кавычек.
 */
function splitIntoCommands(
  paths: string[],
  tool: Exclude<Sha256Tool, 'none'>,
  sudo: boolean
): string[][] {
  const overhead = Buffer.byteLength(commandPrefix(tool)) + (sudo ? SUDO_WRAPPER_BYTES : 0);
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = overhead;

  for (const path of paths) {
    const cost = pathCost(path, sudo);
    if (current.length > 0 && (current.length >= MAX_PATHS_PER_COMMAND || length + cost > MAX_COMMAND_LENGTH)) {
      chunks.push(current);
      current = [];
      length = overhead;
    }
    current.push(path);
    length += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
