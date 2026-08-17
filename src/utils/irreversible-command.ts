/**
 * Parses commands that carry data away for good
 *
 * Answers one question about a command's text: does it destroy the whole
 * container — a machine, a database, a volume, a disk, a set of jobs. The
 * contents inside a container are out of scope here: they get changed every
 * day, and a block on them would turn the marker into a habit.
 *
 * No server is needed here at all: the verdict is decided from the command's
 * name and its arguments. Paths and symlinks are the job of destructive-command.ts.
 */

import { type Invocation, parseInvocations, unquote } from './command-parse.js';
import { isConfirmed } from './destructive-command.js';

/** Commands that stop the machine */
const HALTING_COMMANDS = ['reboot', 'shutdown', 'halt', 'poweroff'];

/** DB clients: the query is only visible in their own argument or on stdin */
export const DB_CLIENTS = [
  'psql', 'mysql', 'mariadb', 'sqlite3', 'mongo', 'mongosh', 'clickhouse-client',
];

/** Destroys a database entirely; tables inside it are changed daily and are out of scope */
const DROP_DATABASE = /\bDROP\s+DATABASE\b/i;

/** Redis flush: both forms carry away everything held in memory */
const REDIS_FLUSH = /^(FLUSHALL|FLUSHDB)$/i;

/** Volume managers: a removed volume does not come back */
const VOLUME_REMOVERS = ['lvremove', 'vgremove', 'pvremove'];

/**
 * Devices that writing to does not damage anything.
 *
 * Everything else under `/dev/` is a disk or a volume: `dd of=/dev/sda`
 * destroys it whole, while `of=/swapfile` is a plain file and routine work.
 */
const HARMLESS_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdout', '/dev/stderr', '/dev/tty',
]);

/** Expanded by the server: what ends up there is not visible from the text */
const EXPANDABLE = /[$`]|\*|\?|\[/;

/** Docker flags that consume the next word: without this the value would pass for a subcommand */
const DOCKER_FLAGS_WITH_VALUE = new Set([
  '-H', '--host', '-c', '--context', '--config', '-l', '--log-level',
  '-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile',
]);

/** Subcommand and flags kept apart: the subcommand's position drifts with global flags */
interface DockerCall {
  words: string[];
  flags: string[];
}

/**
 * Split docker's arguments into words and flags.
 *
 * Position alone can't be relied on: `docker -H unix://… compose down` and
 * `docker compose -f prod.yml down` shift the subcommand to different spots.
 */
function splitDockerArgs(args: string[]): DockerCall {
  const words: string[] = [];
  const flags: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = unquote(args[index]);

    if (argument.startsWith('-')) {
      flags.push(argument);

      // Only a word can be a flag's value: for `prune` the same `-f` means
      // "don't ask", and letting it eat `-a` would take the removal check off guard
      const value = unquote(args[index + 1] ?? '');
      if (DOCKER_FLAGS_WITH_VALUE.has(argument) && !value.startsWith('-')) index += 1;

      continue;
    }

    words.push(argument);
  }

  return { words, flags };
}

/**
 * Whether a flag is present, including fused with its neighbors: `prune -af` cleans the same way.
 *
 * Not every flag has a short form, so it is optional.
 */
function hasFlag(flags: string[], long: string, short?: string): boolean {
  const compact = short ? new RegExp(`^-[a-z]*${short}`) : null;
  return flags.some((flag) => flag === long || (compact !== null && compact.test(flag)));
}

/**
 * What in docker's work carries data away for good.
 *
 * Stopping and recreating containers is out of scope: volumes outlive them,
 * and `compose down` without the flag is a plain restart.
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

/** Verdict for one command */
export interface IrreversibleVerdict {
  blocked: boolean;
  /** Human-readable explanation: what exactly was stopped, and why */
  reason?: string;
}

const PASSED: IrreversibleVerdict = { blocked: false };

/**
 * What in database work carries the whole database away.
 *
 * `mysqladmin`'s database name sits after the word `drop`, and the Redis
 * command is among the arguments rather than first: `redis-cli -h db -p 6379 FLUSHALL`.
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
 * Where `dd` writes.
 *
 * The danger isn't `dd` itself but its sink: `of=/dev/sda` destroys the disk,
 * `of=/swapfile` creates swap space, `of=/dev/null` does nothing at all.
 */
function inspectDiskWrite(args: string[]): string | null {
  const output = args.map(unquote).find((argument) => argument.startsWith('of='));
  if (output === undefined) return null;

  // Quotes wrap the value, not the whole argument: `of="/dev/sda"` is still
  // the same disk, and unquoting the argument itself doesn't strip them
  const target = unquote(output.slice('of='.length));

  if (EXPANDABLE.test(target))
    return `dd writes to "${target}", and the server expands it, so the real target cannot be checked`;

  if (target.startsWith('/dev/') && !HARMLESS_DEVICES.has(target))
    return `dd writes over the device ${target}, destroying everything on it`;

  return null;
}

/**
 * Commands after which the named object no longer exists at that address.
 *
 * Destroying a database, a volume or a filesystem is out of scope here: it
 * fails earlier, on the first threshold check, before the ordering check is reached.
 */
const DESTROYERS = ['rm', 'mv'];

/**
 * Commands that do not read data.
 *
 * Inspection is how removal gets verified. Creating something empty is how a
 * spot gets prepared again, and it can have any number of sinks: for
 * `mkdir -p A B` both arguments come into existence rather than being read.
 */
const NON_READERS = new Set(['ls', 'test', 'stat', 'rm', 'mkdir', 'touch', 'mkfifo']);

/** Archivers: their sink sits behind the `f` key, not last */
const ARCHIVERS = new Set(['tar']);

/** An archiver's file key is written both fused and unfused: `czf` is the same as `-f` */
const ARCHIVE_KEY = /^-?[a-z]*f$/;

/** For `zip` the archive comes first, and there is no key for the file: `-f` means "refresh" */
const SINK_FIRST = new Set(['zip']);

/** The sink is named by a flag: `cp -t DEST SRC` puts it up front */
const SINK_FLAGS = new Set(['-t', '--target-directory', '--target-dir']);

/** A path without trailing slashes and a leading `./`: `A/` and `./A` are the same object */
function normalizePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The path from an argument: `dd` names its own as an assignment — `if=A`, `of=B` */
function pathOf(word: string): string {
  return normalizePath(word.replace(/^(if|of)=/, ''));
}

/** The same object, or something lying inside it: `A` was removed, `A/data` is being read */
function isWithin(candidate: string, destroyed: string): boolean {
  return candidate === destroyed || candidate.startsWith(`${destroyed}/`);
}

/**
 * Where a command writes.
 *
 * By default the sink is the last argument, and that's enough for `cp`, `mv`,
 * `rsync`, `scp`, `mkdir` and redirection. Exceptions where it isn't last are
 * named explicitly: an archiver's `f` key, `dd`'s `of=`, `cp`'s `-t`. The `f`
 * key is only read for archivers: for `cp` the same `-f` means "don't ask".
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

/** Objects this command wipes out of existence */
function destroyedBy(name: string, args: string[]): string[] {
  if (!DESTROYERS.includes(name)) return [];

  const words = args
    .map(unquote)
    .filter((argument) => !argument.startsWith('-'))
    .map(normalizePath);

  // `mv` carries the source away from its old place, while the sink, on the
  // contrary, comes into existence. The sink is found the same way as for
  // the rest: the `-t` flag puts it up front
  if (name !== 'mv') return words;

  const sink = findSink(name, args);
  return words.filter((word) => word !== sink);
}

/**
 * Wrong order within a single call: an object was destroyed, then read
 * afterward. The correct order — copy, move, delete — does not land here,
 * because the destruction in it comes last.
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

/** Whether a word abbreviates a full command name: `sub` for `subvolume` */
function abbreviates(word: string | undefined, full: string): boolean {
  return word !== undefined && word.length > 0 && full.startsWith(word);
}

/**
 * What in disk and volume work carries away the whole medium.
 *
 * Inspection and listing are out of scope: `wipefs` without `-a` only reads
 * signatures, `lvs` and `zfs list` don't change anything.
 */
function inspectStorage(name: string, args: string[]): string | null {
  const words = args.map(unquote).filter((argument) => !argument.startsWith('-'));

  if (/^mkfs(\.|$)/.test(name)) return `${name} creates a new filesystem, wiping what is there`;

  if (name === 'wipefs' && hasFlag(args.map(unquote), '--all', 'a'))
    return 'wipefs -a erases the filesystem signatures of the device';

  if (name === 'dd') return inspectDiskWrite(args);

  if (VOLUME_REMOVERS.includes(name)) return `${name} destroys the volume and the data on it`;

  if (name === 'zfs' && words[0] === 'destroy') return 'zfs destroy removes the dataset';

  // btrfs accepts its commands abbreviated: `btrfs sub del` is the same thing
  if (name === 'btrfs' && abbreviates(words[0], 'subvolume') && abbreviates(words[1], 'delete'))
    return 'btrfs subvolume delete removes the subvolume with its data';

  return null;
}

/**
 * Inspect a command from its text alone.
 *
 * A name is looked for in the command position: `reboot` as the first word
 * is an invocation, `reboot` inside a path or a quoted string is a mention,
 * and it is skipped.
 */
export function inspectIrreversible(command: string): IrreversibleVerdict {
  if (isConfirmed(command)) return PASSED;

  const invocations = parseInvocations(command);

  // The query is searched for across the whole command, but only if a DB
  // client is actually invoked in it: this catches both `-c "…"` and stdin
  // text, while an unrelated mention of the query stays silent
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
      // The standalone `docker-compose` program has the subcommand right
      // away, while the parser expects it as the second word — like `docker compose`
      if (name === 'docker-compose') call.words.unshift('compose');

      const reason = inspectDocker(call);
      if (reason) return { blocked: true, reason };
    }

    const database = inspectDatabase(name, args);
    if (database) return { blocked: true, reason: database };

    // The key next to `-e` wipes out every cron job of the user at once and
    // asks nothing: the job list is stored nowhere else
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
