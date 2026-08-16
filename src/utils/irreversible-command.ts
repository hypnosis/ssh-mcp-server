/**
 * Разбор команд, уносящих данные навсегда
 *
 * Отвечает на один вопрос по тексту команды: уничтожает ли она сосуд целиком —
 * машину, базу, том, диск, набор заданий. Содержимое внутри сосуда сюда не
 * относится: его правят каждый день, и отказ на нём превратил бы маркер в
 * привычку.
 *
 * Сервер здесь не нужен вовсе: решение принимается по имени команды и её
 * аргументам. Пути и символические ссылки разбирает destructive-command.ts.
 */

import { type Invocation, parseInvocations, unquote } from './command-parse.js';
import { isConfirmed } from './destructive-command.js';

/** Команды, останавливающие машину */
const HALTING_COMMANDS = ['reboot', 'shutdown', 'halt', 'poweroff'];

/** Клиенты БД: запрос виден только у них, в аргументе или на входе */
export const DB_CLIENTS = [
  'psql', 'mysql', 'mariadb', 'sqlite3', 'mongo', 'mongosh', 'clickhouse-client',
];

/** Снос базы целиком; таблицы внутри неё правят каждый день и сюда не входят */
const DROP_DATABASE = /\bDROP\s+DATABASE\b/i;

/** Очистка Redis: обе формы уносят всё, что в памяти */
const REDIS_FLUSH = /^(FLUSHALL|FLUSHDB)$/i;

/** Менеджеры томов: снятый том не восстанавливается */
const VOLUME_REMOVERS = ['lvremove', 'vgremove', 'pvremove'];

/**
 * Устройства, запись в которые ничего не портит.
 *
 * Всё остальное в `/dev/` — диск или том: `dd of=/dev/sda` сносит его целиком,
 * а `of=/swapfile` — обычный файл и штатная работа.
 */
const HARMLESS_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdout', '/dev/stderr', '/dev/tty',
]);

/** Раскрывает сервер: что окажется за этим, из текста не видно */
const EXPANDABLE = /[$`]|\*|\?|\[/;

/** Флаги docker, забирающие следующее слово: без этого значение сойдёт за подкоманду */
const DOCKER_FLAGS_WITH_VALUE = new Set([
  '-H', '--host', '-c', '--context', '--config', '-l', '--log-level',
  '-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile',
]);

/** Подкоманда и флаги отдельно: позиция подкоманды плавает от глобальных флагов */
interface DockerCall {
  words: string[];
  flags: string[];
}

/**
 * Разложить аргументы docker на слова и флаги.
 *
 * По позициям искать нельзя: `docker -H unix://… compose down` и
 * `docker compose -f prod.yml down` сдвигают подкоманду на любое место.
 */
function splitDockerArgs(args: string[]): DockerCall {
  const words: string[] = [];
  const flags: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = unquote(args[index]);

    if (argument.startsWith('-')) {
      flags.push(argument);

      // Значением флага может быть только слово: у `prune` тот же `-f` значит
      // «не спрашивай», и съеденный им `-a` увёл бы из-под проверки снос всего
      const value = unquote(args[index + 1] ?? '');
      if (DOCKER_FLAGS_WITH_VALUE.has(argument) && !value.startsWith('-')) index += 1;

      continue;
    }

    words.push(argument);
  }

  return { words, flags };
}

/**
 * Флаг присутствует, в том числе слитно с соседями: `prune -af` чистит так же.
 *
 * Короткая форма есть не у каждого флага, поэтому она необязательна.
 */
function hasFlag(flags: string[], long: string, short?: string): boolean {
  const compact = short ? new RegExp(`^-[a-z]*${short}`) : null;
  return flags.some((flag) => flag === long || (compact !== null && compact.test(flag)));
}

/**
 * Что из работы docker уносит данные навсегда.
 *
 * Останов и пересоздание контейнеров сюда не относятся: тома их переживают,
 * а `compose down` без флага — обычный перезапуск.
 */
function inspectDocker(call: DockerCall): string | null {
  const { words, flags } = call;
  const [first, second] = words;

  if (first === 'compose' && second === 'down' && hasFlag(flags, '--volumes', 'v'))
    return 'docker compose down -v removes the project volumes with the data in them';

  if (first === 'volume' && second === 'rm') return 'docker volume rm destroys the named volume';

  if (first === 'volume' && second === 'prune')
    return 'docker volume prune destroys every unused volume';

  if (first === 'system' && second === 'prune') {
    if (hasFlag(flags, '--volumes')) return 'docker system prune --volumes destroys volumes';
    if (hasFlag(flags, '--all', 'a'))
      return 'docker system prune -a destroys images, networks and the build cache';
  }

  return null;
}

/** Итог проверки одной команды */
export interface IrreversibleVerdict {
  blocked: boolean;
  /** Человеческое объяснение: что именно и почему остановлено */
  reason?: string;
}

const PASSED: IrreversibleVerdict = { blocked: false };

/**
 * Что из работы с базами уносит её целиком.
 *
 * Имя базы у `mysqladmin` стоит за словом `drop`, а команда Redis — среди
 * аргументов, а не первым: `redis-cli -h db -p 6379 FLUSHALL`.
 */
function inspectDatabase(name: string, args: string[]): string | null {
  const words = args.map(unquote);

  if (name === 'dropdb') return 'dropdb destroys the whole database';

  if (name === 'mysqladmin' && words.includes('drop'))
    return 'mysqladmin drop destroys the whole database';

  if (name === 'redis-cli' && words.some((word) => REDIS_FLUSH.test(word)))
    return 'redis-cli FLUSHALL/FLUSHDB destroys everything the server holds';

  return null;
}

/**
 * Куда `dd` пишет.
 *
 * Опасен не сам `dd`, а его приёмник: `of=/dev/sda` сносит диск, `of=/swapfile`
 * создаёт подкачку, `of=/dev/null` не делает ничего.
 */
function inspectDiskWrite(args: string[]): string | null {
  const output = args.map(unquote).find((argument) => argument.startsWith('of='));
  if (output === undefined) return null;

  // Кавычки стоят вокруг значения, а не всего аргумента: `of="/dev/sda"` —
  // тот же диск, и unquote самого аргумента их не снимает
  const target = unquote(output.slice('of='.length));

  if (EXPANDABLE.test(target))
    return `dd writes to "${target}", and the server expands it, so the real target cannot be checked`;

  if (target.startsWith('/dev/') && !HARMLESS_DEVICES.has(target))
    return `dd writes over the device ${target}, destroying everything on it`;

  return null;
}

/**
 * Команды, после которых названного объекта по этому адресу больше нет.
 *
 * Снос базы, тома и файловой системы сюда не входит: он отказывает раньше,
 * первой проверкой порога, и до разбора порядка дело не доходит.
 */
const DESTROYERS = ['rm', 'mv'];

/**
 * Команды, которые данных не читают.
 *
 * Осмотр — так проверяют, что удаление прошло. Создание пустого — так место
 * готовят заново, и приёмников у него бывает сколько угодно: у `mkdir -p A B`
 * оба аргумента появляются, а не читаются.
 */
const NON_READERS = new Set(['ls', 'test', 'stat', 'rm', 'mkdir', 'touch', 'mkfifo']);

/** Архиваторы: приёмник у них стоит за ключом `f`, а не последним */
const ARCHIVERS = new Set(['tar']);

/** Ключ файла у архиватора пишут и слитно, и без дефиса: `czf` — тот же `-f` */
const ARCHIVE_KEY = /^-?[a-z]*f$/;

/** У `zip` архив стоит первым, а ключа под файл нет: `-f` значит «освежить» */
const SINK_FIRST = new Set(['zip']);

/** Приёмник назван флагом: `cp -t DEST SRC` ставит его вперёд */
const SINK_FLAGS = new Set(['-t', '--target-directory', '--target-dir']);

/** Путь без хвостовых слэшей и ведущего `./`: `A/` и `./A` — тот же объект */
function normalizePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Путь из аргумента: `dd` называет свои присваиванием — `if=A`, `of=B` */
function pathOf(word: string): string {
  return normalizePath(word.replace(/^(if|of)=/, ''));
}

/** Тот же объект или лежащее внутри него: удалили `A`, читаем `A/data` */
function isWithin(candidate: string, destroyed: string): boolean {
  return candidate === destroyed || candidate.startsWith(`${destroyed}/`);
}

/**
 * Куда команда пишет.
 *
 * По умолчанию приёмник — последний аргумент, и этого хватает для `cp`, `mv`,
 * `rsync`, `scp`, `mkdir` и перенаправления. Исключения, где он не последний,
 * названы явно: ключ `f` у архиватора, `of=` у `dd`, `-t` у копий. Ключ `f`
 * читается только у архиваторов: у `cp` тот же `-f` значит «не спрашивай».
 */
function findSink(name: string, args: string[]): string | undefined {
  const words = args.map(unquote);

  const plain = words.filter((word) => !word.startsWith('-'));
  if (SINK_FIRST.has(name)) return plain[0] === undefined ? undefined : normalizePath(plain[0]);

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith('of=')) return pathOf(word);

    const named = SINK_FLAGS.has(word) || (ARCHIVERS.has(name) && ARCHIVE_KEY.test(word));
    const value = words[index + 1];
    if (named && value !== undefined) return normalizePath(value);
  }

  const last = plain[plain.length - 1];
  return last === undefined ? undefined : normalizePath(last);
}

/** Объекты, которых лишает существования эта команда */
function destroyedBy(name: string, args: string[]): string[] {
  if (!DESTROYERS.includes(name)) return [];

  const words = args
    .map(unquote)
    .filter((argument) => !argument.startsWith('-'))
    .map(normalizePath);

  // `mv` уносит источник со старого места, а приёмник, наоборот, появляется.
  // Приёмник ищется там же, где у остальных: флаг `-t` ставит его вперёд
  if (name !== 'mv') return words;

  const sink = findSink(name, args);
  return words.filter((word) => word !== sink);
}

/**
 * Ошибочный порядок внутри одного вызова: объект уничтожен, а дальше его
 * читают. Правильный порядок — копия, перенос, удаление — сюда не попадает,
 * потому что уничтожение в нём последнее.
 */
function inspectOrder(invocations: Invocation[]): string | null {
  const destroyed: string[] = [];

  for (const { name, args } of invocations) {
    if (destroyed.length > 0 && !NON_READERS.has(name)) {
      const sink = findSink(name, args);
      const sources = args
        .map(unquote)
        .filter((argument) => !argument.startsWith('-'))
        .map(pathOf)
        .filter((word) => word !== sink);

      for (const source of sources) {
        const gone = destroyed.find((target) => isWithin(source, target));
        if (gone !== undefined)
          return `"${source}" is read after "${gone}" was destroyed earlier in the same call`;
      }
    }

    destroyed.push(...destroyedBy(name, args));
  }

  return null;
}

/** Слово — сокращение полного имени команды: `sub` вместо `subvolume` */
function abbreviates(word: string | undefined, full: string): boolean {
  return word !== undefined && word.length > 0 && full.startsWith(word);
}

/**
 * Что из работы с дисками и томами уносит носитель целиком.
 *
 * Осмотр и перечисление сюда не входят: `wipefs` без `-a` только читает
 * подписи, `lvs` и `zfs list` не меняют ничего.
 */
function inspectStorage(name: string, args: string[]): string | null {
  const words = args.map(unquote).filter((argument) => !argument.startsWith('-'));

  if (/^mkfs(\.|$)/.test(name)) return `${name} creates a new filesystem, wiping what is there`;

  if (name === 'wipefs' && hasFlag(args.map(unquote), '--all', 'a'))
    return 'wipefs -a erases the filesystem signatures of the device';

  if (name === 'dd') return inspectDiskWrite(args);

  if (VOLUME_REMOVERS.includes(name)) return `${name} destroys the volume and the data on it`;

  if (name === 'zfs' && words[0] === 'destroy') return 'zfs destroy removes the dataset';

  // btrfs принимает свои команды сокращёнными: `btrfs sub del` — то же самое
  if (name === 'btrfs' && abbreviates(words[0], 'subvolume') && abbreviates(words[1], 'delete'))
    return 'btrfs subvolume delete removes the subvolume with its data';

  return null;
}

/**
 * Проверить команду по одному только тексту.
 *
 * Имя ищется в позиции команды: `reboot` первым словом — вызов, `reboot` внутри
 * пути или строки в кавычках — упоминание, и его пропускаем.
 */
export function inspectIrreversible(command: string): IrreversibleVerdict {
  if (isConfirmed(command)) return PASSED;

  const invocations = parseInvocations(command);

  // Запрос ищется по всей команде, но только если клиент БД в ней вызван: так
  // ловится и `-c "…"`, и текст на входе, а разговор о запросе остаётся молча
  if (invocations.some(({ name }) => DB_CLIENTS.includes(name)) && DROP_DATABASE.test(command)) {
    return { blocked: true, reason: 'DROP DATABASE destroys the whole database' };
  }

  for (const { name, args } of invocations) {
    if (HALTING_COMMANDS.includes(name)) {
      return {
        blocked: true,
        reason: `"${name}" stops the machine, and the session ends with it`,
      };
    }

    if (name === 'docker' || name === 'docker-compose') {
      const call = splitDockerArgs(args);
      // У отдельной программы `docker-compose` подкоманда идёт сразу, а разбор
      // ждёт её вторым словом — как у `docker compose`
      if (name === 'docker-compose') call.words.unshift('compose');

      const reason = inspectDocker(call);
      if (reason) return { blocked: true, reason };
    }

    const database = inspectDatabase(name, args);
    if (database) return { blocked: true, reason: database };

    // Соседняя с `-e` клавиша уносит все задания пользователя разом и ничего
    // не переспрашивает; список заданий нигде больше не хранится
    if (name === 'crontab' && args.map(unquote).includes('-r')) {
      return { blocked: true, reason: 'crontab -r removes every cron job of the user' };
    }

    const storage = inspectStorage(name, args);
    if (storage) return { blocked: true, reason: storage };
  }

  const order = inspectOrder(invocations);
  if (order) return { blocked: true, reason: order };

  return PASSED;
}
