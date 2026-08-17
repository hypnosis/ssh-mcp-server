/**
 * Parses a command line into invocations
 *
 * Answers one question: which programs the command runs and with what
 * arguments. Callers decide what to do with the finding — this module only
 * parses the string, with no calls to the server.
 */

/** Wrappers behind which the real command stands */
const WRAPPERS = /^(sudo|doas|env|nohup|time|timeout|nice|ionice|setsid)$/;

/** Wrapper tail: its flags, variable assignments, the duration for timeout */
const WRAPPER_ARGS = /^(-|\w+=|\d)/;

/**
 * Wrapper flags that consume the next word — each wrapper has its own set.
 *
 * Without them the username from `sudo -u postgres dropdb app` lands in the
 * command position, leaving the real command invisible. The list can't be
 * shared across wrappers: `-n` is a value for `nice` but means "don't ask"
 * for `sudo`, and the word it would eat is the command itself. Flags with a
 * numeric value are not listed here: the number is already skipped by the
 * tail parsing.
 */
const WRAPPER_FLAGS_WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set(['-u', '--user', '-g', '--group']),
  doas: new Set(['-u']),
  ionice: new Set(['-c', '--class']),
  timeout: new Set(['-s', '--signal']),
  env: new Set(['-u', '--unset']),
};

const NO_VALUED_FLAGS = new Set<string>();

/** One program invocation within a simple command segment */
export interface Invocation {
  /** Name without the path: `/sbin/reboot` and `reboot` are the same */
  name: string;
  /** Arguments as written, quotes included */
  args: string[];
}

/** Strip the quotes an argument may be wrapped in entirely */
export function unquote(argument: string): string {
  const paired = /^'(.*)'$/.exec(argument) ?? /^"(.*)"$/.exec(argument);
  return paired ? paired[1] : argument;
}

/**
 * Split the command into simple segments.
 *
 * Shell separators (`;`, `&&`, `||`, `|`, newline) split commands only
 * outside quotes: `git commit -m "fix; reboot handler"` is one command, and
 * splitting on the semicolon would leave `reboot` in the command position.
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

/** Split a segment into words without breaking quoted chunks */
export function tokenize(segment: string): string[] {
  return segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
}

/**
 * Find program invocations across the whole command.
 *
 * A word in the command position is an invocation; the same word in an
 * argument, a path, or a quoted string is not.
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
        // Only a word can be a value: the next flag is never treated as one
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
