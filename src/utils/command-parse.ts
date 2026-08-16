/**
 * Разбор командной строки на вызовы
 *
 * Отвечает на один вопрос: какие программы команда запускает и с какими
 * аргументами. Решение по найденному принимают вызывающие — здесь только
 * разбор строки, без обращений к серверу.
 */

/** Обёртки, за которыми стоит настоящая команда */
const WRAPPERS = /^(sudo|doas|env|nohup|time|timeout|nice|ionice|setsid)$/;

/** Хвост обёртки: её флаги, присваивания переменных, длительность у timeout */
const WRAPPER_ARGS = /^(-|\w+=|\d)/;

/**
 * Флаги обёрток, забирающие следующее слово, — у каждой обёртки свои.
 *
 * Без них имя пользователя из `sudo -u postgres dropdb app` встаёт в позицию
 * команды, а сама команда остаётся невидимой. Список общим быть не может:
 * `-n` у `nice` — это величина, а у `sudo` — «не спрашивай», и съеденным словом
 * оказалась бы сама команда. Флаги с числовым значением сюда не входят: число
 * пропускается разбором хвоста и так.
 */
const WRAPPER_FLAGS_WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set(['-u', '--user', '-g', '--group']),
  doas: new Set(['-u']),
  ionice: new Set(['-c', '--class']),
  timeout: new Set(['-s', '--signal']),
  env: new Set(['-u', '--unset']),
};

const NO_VALUED_FLAGS = new Set<string>();

/** Запуск одной программы в пределах простого сегмента команды */
export interface Invocation {
  /** Имя без пути: `/sbin/reboot` и `reboot` дают одно и то же */
  name: string;
  /** Аргументы в том виде, в каком написаны, вместе с кавычками */
  args: string[];
}

/** Убрать кавычки, которыми аргумент мог быть обёрнут целиком */
export function unquote(argument: string): string {
  const paired = /^'(.*)'$/.exec(argument) ?? /^"(.*)"$/.exec(argument);
  return paired ? paired[1] : argument;
}

/**
 * Разрезать команду на простые сегменты.
 *
 * Разделители shell (`;`, `&&`, `||`, `|`, перевод строки) разделяют команды
 * только вне кавычек: `git commit -m "fix; reboot handler"` — одна команда, а
 * разрез по точке с запятой оставлял бы `reboot` в позиции команды.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }

    if (char === ';' || char === '|' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments;
}

/** Разбить сегмент на слова, не разрывая закавыченные куски */
export function tokenize(segment: string): string[] {
  return segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
}

/**
 * Найти вызовы программ во всей команде.
 *
 * Слово в позиции команды — это вызов; то же слово в аргументе, пути или
 * строке в кавычках вызовом не является.
 */
export function parseInvocations(command: string): Invocation[] {
  const invocations: Invocation[] = [];

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);

    let index = 0;
    while (index < tokens.length && WRAPPERS.test(unquote(tokens[index]))) {
      const valued = WRAPPER_FLAGS_WITH_VALUE[unquote(tokens[index])] ?? NO_VALUED_FLAGS;
      index += 1;

      while (index < tokens.length && WRAPPER_ARGS.test(tokens[index])) {
        const takesValue = valued.has(unquote(tokens[index]));
        index += 1;
        // Значением бывает только слово: следующий флаг значением не считается
        if (takesValue && index < tokens.length && !tokens[index].startsWith('-')) index += 1;
      }
    }

    const head = tokens[index];
    if (!head) continue;

    invocations.push({
      name: unquote(head).replace(/^.*\//, ''),
      args: tokens.slice(index + 1),
    });
  }

  return invocations;
}
