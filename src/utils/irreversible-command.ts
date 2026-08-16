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

import { parseInvocations, unquote } from './command-parse.js';
import { isConfirmed } from './destructive-command.js';

/** Команды, останавливающие машину */
const HALTING_COMMANDS = ['reboot', 'shutdown', 'halt', 'poweroff'];

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
 * Проверить команду по одному только тексту.
 *
 * Имя ищется в позиции команды: `reboot` первым словом — вызов, `reboot` внутри
 * пути или строки в кавычках — упоминание, и его пропускаем.
 */
export function inspectIrreversible(command: string): IrreversibleVerdict {
  if (isConfirmed(command)) return PASSED;

  for (const { name, args } of parseInvocations(command)) {
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
  }

  return PASSED;
}
