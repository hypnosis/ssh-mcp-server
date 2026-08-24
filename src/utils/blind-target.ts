/**
 * Parses strikes whose target the text does not name
 *
 * Answers one question about a command: would it stop something the caller
 * cannot name? `docker stop web-1` names its target and passes; `docker stop
 * $(docker ps -q --filter …)` names a way to find one, and what the way finds
 * is unknown until the server runs it.
 *
 * The same rule already governs removal (`destructive-command.ts`) and disk
 * writes: a target the server expands cannot be judged from the text. Here it
 * governs the verbs that stop what is running.
 *
 * This module only parses the string. Turning a strike into a list of real
 * containers and processes is the job of the layer that may talk to the server.
 */

import { parseInvocations, tokenize, unquote } from './command-parse.js';
import { shellQuote } from './shell-arg.js';

/** Container engines whose subcommand decides what happens */
const CONTAINER_ENGINES = new Set(['docker', 'podman']);

/** Container subcommands after which the container is no longer running */
const CONTAINER_STOPPERS = new Set(['kill', 'stop', 'rm', 'restart']);

/** The same for a compose project, where `down` joins them */
const COMPOSE_STOPPERS = new Set(['kill', 'stop', 'rm', 'restart', 'down']);

/** Signal senders: the target is a process */
const PROCESS_KILLERS = new Set(['kill', 'pkill', 'killall']);

/** Unit managers and the verbs after which the unit stops serving */
const UNIT_MANAGERS = new Set(['systemctl', 'service']);
const UNIT_STOPPERS = new Set(['stop', 'restart', 'kill', 'disable', 'mask']);

/** Flags after which `pkill` and `pgrep` match the whole command line, not the name */
const FULL_LINE_FLAGS = new Set(['-f', '--full']);

/** `killall` matches by regular expression rather than by an exact name */
const REGEX_FLAGS = new Set(['-r', '--regexp']);

/** What is left of a target once the shell has had its way with it */
const EXPANDS_AT_RUNTIME = /[$`*?[]/;

/** A search over the whole command line, in either program that offers one */
const FULL_LINE_SEARCH = /(^|\s)(pgrep|pkill)\s+(-\w*f|--full)(\s|$)/;

/**
 * Whether the pattern matches the very command that carries it.
 *
 * A search over command lines reads the searching shell too, and signals it
 * first. Writing one character as a class — `[r]elay` — breaks the match on
 * the command while still matching the target, so this is asked of the actual
 * text rather than assumed from the flags. A pattern that does not compile
 * counts as matching: what cannot be judged is not waved through.
 */
function matchesOwnCommand(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command);
  } catch {
    return true;
  }
}

/** The pattern a search program was given: it stands after the flags */
function searchPattern(args: string[]): string | undefined {
  const words = plainArgs(args);
  return words[words.length - 1];
}

/** What the strike would stop */
export type StrikeSubject = 'container' | 'process' | 'unit';

/**
 * Why the text cannot name the target.
 *
 * `expansion` — a substitution or a variable stands in the target's place.
 * `pattern` — the target is a search: every process whose command line
 * contains a fragment, every name matching an expression.
 */
export type StrikeKind = 'expansion' | 'pattern';

/** A strike whose target the command does not name */
export interface BlindStrike {
  /** The verb as a person would say it: `docker kill`, `pkill`, `systemctl stop` */
  verb: string;
  subject: StrikeSubject;
  kind: StrikeKind;
  /** The segment as written, with substitutions put back in place */
  written: string;
  /**
   * A command that names what would be hit without hitting it, or null when
   * the text gives nothing to ask the server with — an empty variable, a glob
   * no listing understands.
   */
  probe: string | null;
  /**
   * The search matches the command that carries it.
   *
   * A pattern for the whole command line is written inside the very command
   * being run, so the shell running it matches too — and dies first, before
   * the intended target. Measured on both containers: the reply breaks off
   * mid-stream, and the target survives.
   */
  selfMatching: boolean;
  /** The search pattern, when the strike searches rather than names */
  pattern: string | null;
}

/** Placeholder for a substitution lifted out of the command before it is split */
const PLACEHOLDER_PREFIX = 'SSHMCPSUB';
const PLACEHOLDER = new RegExp(`^${PLACEHOLDER_PREFIX}(\\d+)$`);

/** A substitution glued to text around it: `"web-$(cat name)"` */
const PLACEHOLDER_INSIDE = new RegExp(`${PLACEHOLDER_PREFIX}\\d+`);

interface Masked {
  /** The command with every substitution replaced by a single word */
  text: string;
  /** The substitutions themselves, in the order the placeholders number them */
  parts: string[];
}

/**
 * Lift substitutions out of the command.
 *
 * A substitution may hold the shell separators the splitter cuts on — `kill
 * $(pgrep -f app | head -1)` is one command, not two — so it is replaced by a
 * single word before anything else looks at the string. Single quotes are
 * left alone: the shell does not expand what is inside them.
 */
function maskSubstitutions(command: string): Masked {
  const parts: string[] = [];
  let text = '';
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (char === quote) {
      quote = null;
      text += char;
      continue;
    }

    // Inside single quotes nothing expands; inside double quotes a
    // substitution still does, so only the single-quoted run is copied whole
    if (quote === "'") {
      text += char;
      continue;
    }

    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      text += char;
      continue;
    }

    const opensCommand = char === '$' && command[index + 1] === '(';
    if (opensCommand || char === '`') {
      const end = opensCommand ? findClosingParen(command, index + 1) : command.indexOf('`', index + 1);
      if (end === -1) {
        text += char;
        continue;
      }

      const inner = opensCommand
        ? command.slice(index + 2, end)
        : command.slice(index + 1, end);
      text += `${PLACEHOLDER_PREFIX}${parts.length}`;
      parts.push(inner);
      index = end;
      continue;
    }

    text += char;
  }

  return { text, parts };
}

/**
 * Drop what the shell would not run: a comment and everything after it.
 *
 * The confirmation itself is written as a comment, and its words would
 * otherwise be read as arguments — a pattern search would then look for the
 * pattern together with the confirmation, and find nothing.
 */
function withoutComments(command: string): string {
  return command
    .split('\n')
    .map((line) => {
      let quote: string | null = null;

      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];

        if (char === quote) {
          quote = null;
          continue;
        }

        if (quote === null && (char === "'" || char === '"')) {
          quote = char;
          continue;
        }

        // Only a `#` starting a word opens a comment: `a#b` is one word
        if (quote === null && char === '#' && (index === 0 || /\s/.test(line[index - 1])))
          return line.slice(0, index);
      }

      return line;
    })
    .join('\n');
}

/** Position of the parenthesis that closes the one at `open`, or -1 */
function findClosingParen(command: string, open: number): number {
  let depth = 0;

  for (let index = open; index < command.length; index += 1) {
    if (command[index] === '(') depth += 1;
    if (command[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/** Put the substitutions back so the caller sees the command as it was written */
function unmask(text: string, parts: string[]): string {
  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)`, 'g'),
    (_, index: string) => `$(${parts[Number(index)]})`
  );
}

/** Whether a word stands in for a substitution, and which one */
function substitutionOf(word: string, parts: string[]): string | null {
  const match = PLACEHOLDER.exec(unquote(word));
  return match ? parts[Number(match[1])] ?? null : null;
}

/** Arguments that are not flags — the places a target can stand in */
function plainArgs(args: string[]): string[] {
  return args.map(unquote).filter((argument) => !argument.startsWith('-'));
}

/** Whether any flag from a set is present, fused forms included: `-9f` carries `-f` */
function carriesFlag(args: string[], flags: Set<string>): boolean {
  return args.map(unquote).some((argument) => {
    if (flags.has(argument)) return true;
    if (!argument.startsWith('-') || argument.startsWith('--')) return false;
    return [...flags].some((flag) => flag.length === 2 && argument.includes(flag[1]));
  });
}

/**
 * Which verb this invocation is, said the way a person would say it, or null
 * when the invocation stops nothing.
 */
function namedVerb(name: string, args: string[]): { verb: string; subject: StrikeSubject } | null {
  const words = plainArgs(args);

  if (CONTAINER_ENGINES.has(name)) {
    const [first, second] = words;
    if (first === 'compose' && COMPOSE_STOPPERS.has(second))
      return { verb: `${name} compose ${second}`, subject: 'container' };
    if (CONTAINER_STOPPERS.has(first)) return { verb: `${name} ${first}`, subject: 'container' };
    return null;
  }

  if (name === 'docker-compose' && COMPOSE_STOPPERS.has(words[0]))
    return { verb: `docker-compose ${words[0]}`, subject: 'container' };

  if (PROCESS_KILLERS.has(name)) return { verb: name, subject: 'process' };

  // `service` puts the verb last: `service nginx stop`
  if (UNIT_MANAGERS.has(name)) {
    const verb = name === 'service' ? words[words.length - 1] : words[0];
    if (UNIT_STOPPERS.has(verb)) return { verb: `${name} ${verb}`, subject: 'unit' };
  }

  return null;
}

/**
 * Where the target stands for this verb.
 *
 * For a container engine and a unit manager the subcommand comes first and is
 * not a target; for a signal sender every plain argument is one.
 */
function targetWords(name: string, args: string[]): string[] {
  const words = plainArgs(args);

  if (CONTAINER_ENGINES.has(name)) return words[0] === 'compose' ? words.slice(2) : words.slice(1);
  if (name === 'docker-compose') return words.slice(1);
  if (UNIT_MANAGERS.has(name)) return name === 'service' ? words.slice(0, -1) : words.slice(1);

  return words;
}

/**
 * The command that would name the processes a pattern search hits.
 *
 * `pkill` and `pgrep` take the same arguments, so the search is repeated
 * verbatim with the harmless name. `killall -r` matches names by expression,
 * which is what `pgrep` does with a bare pattern.
 */
function processProbe(name: string, args: string[]): string | null {
  if (name === 'pkill') {
    // The arguments keep the quoting they were written with: a pattern
    // stripped of its quotes would be expanded by the shell instead of matched.
    // Only the signal is dropped — every other flag narrows the search and
    // `pgrep` reads it the same way
    const kept: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const bare = unquote(args[index]);
      if (/^-\d/.test(bare)) continue;
      if (bare === '--signal') {
        index += 1;
        continue;
      }
      kept.push(args[index]);
    }

    return ['pgrep', '-a', ...kept].join(' ');
  }

  if (name === 'killall') {
    const pattern = plainArgs(args)[0];
    return pattern === undefined ? null : `pgrep -a ${shellQuote(pattern)}`;
  }

  return null;
}

/**
 * Find strikes whose target the command does not name.
 *
 * An empty list means every strike in the command named what it hits — not
 * that the command is harmless.
 */
export function findBlindStrikes(command: string): BlindStrike[] {
  const { text, parts } = maskSubstitutions(withoutComments(command));
  const strikes: BlindStrike[] = [];

  for (const { name, args } of parseInvocations(text)) {
    const named = namedVerb(name, args);
    if (named === null) continue;

    const written = unmask([name, ...args].join(' '), parts);
    const targets = targetWords(name, args);

    // A search by command line or by expression is a target that only exists
    // once the server has looked: the pattern is the whole of what is known
    const searchesByPattern =
      (name === 'pkill' && carriesFlag(args, FULL_LINE_FLAGS)) ||
      (name === 'killall' && carriesFlag(args, REGEX_FLAGS));

    if (searchesByPattern) {
      const probe = processProbe(name, args);
      strikes.push({
        ...named,
        kind: 'pattern',
        written,
        probe: probe === null ? null : unmask(probe, parts),
        selfMatching:
          name === 'pkill' &&
          carriesFlag(args, FULL_LINE_FLAGS) &&
          matchesOwnCommand(searchPattern(args) ?? '', command),
        pattern: searchPattern(args) ?? null,
      });
      continue;
    }

    const substituted = targets.map((word) => substitutionOf(word, parts)).find((part) => part !== null);
    if (substituted !== undefined) {
      strikes.push({
        ...named,
        kind: 'expansion',
        written,
        probe: substituted,
        selfMatching:
          FULL_LINE_SEARCH.test(substituted) &&
          matchesOwnCommand(searchPattern(tokenize(substituted)) ?? '', command),
        pattern: FULL_LINE_SEARCH.test(substituted)
          ? searchPattern(tokenize(substituted)) ?? null
          : null,
      });
      continue;
    }

    // A variable, a glob, or a substitution glued to text around it leaves
    // nothing to ask the server with: no listing answers "what would this
    // have become", and the answer to the substitution alone is not the target
    if (targets.some((word) => EXPANDS_AT_RUNTIME.test(word) || PLACEHOLDER_INSIDE.test(word))) {
      strikes.push({
        ...named,
        kind: 'expansion',
        written,
        probe: null,
        selfMatching: false,
        pattern: null,
      });
    }
  }

  return strikes;
}
