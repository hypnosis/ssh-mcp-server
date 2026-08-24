/**
 * Turns what the machine found into a refusal the caller can act on
 *
 * A refusal that only says "no" gets worked around; a refusal that asks "are
 * you sure" gets answered without reading. This one says what stands behind
 * the target — name, age, what it is carrying — because that is the thing the
 * caller did not know when writing the command.
 *
 * Going ahead means naming the targets, and the names are checked against
 * what the command actually reaches. A confirmation that names something else
 * is refused too: it says the caller and the machine disagree about the target.
 */

import type { PreviewedTarget, StrikePreview } from './strike-preview-parse.js';

/** Confirmation that carries the names, not just the intent */
export const KILL_MARKER = '# CONFIRMED-KILL:';

/** How long a thing has been running, in words rather than seconds */
function saidAsDuration(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/** The name the caller would write in the confirmation */
export function nameOf(target: PreviewedTarget): string {
  return target.kind === 'container' ? target.name : String(target.pid);
}

/** One target as a line: what it is, and every sign that it is in use */
function describe(target: PreviewedTarget): string {
  if (target.kind === 'container') {
    const ports = target.ports === '' ? 'no published ports' : target.ports;
    return `${target.name} — ${target.image}, ${target.status}, ${ports}`;
  }

  const signs = [
    target.age === null ? null : `running ${saidAsDuration(target.age)}`,
    target.listening.length === 0 ? null : `listening on ${target.listening.join(', ')}`,
    target.established === 0 ? null : `${target.established} connection(s) open`,
  ].filter((sign) => sign !== null);

  const command = target.command === '' ? '(command line unavailable)' : target.command;
  return `${target.pid} — ${command}${signs.length === 0 ? '' : `, ${signs.join(', ')}`}`;
}

/**
 * The same pattern, rewritten so it no longer matches the command carrying it.
 *
 * One character becomes a class of itself: `relay` reads as `[r]elay`, which
 * still matches `relay` in the target but not the literal `[r]elay` written
 * here. Null when the first character cannot stand inside a class.
 */
export function shieldPattern(pattern: string | null): string | null {
  if (pattern === null || pattern === '') return null;
  if (!/[\w/.-]/.test(pattern[0])) return null;

  return `[${pattern[0]}]${pattern.slice(1)}`;
}

/** The names a confirmation carries, or null when there is no confirmation */
export function readConfirmedNames(command: string): string[] | null {
  const marker = command.indexOf(KILL_MARKER);
  if (marker === -1) return null;

  const names = command
    .slice(marker + KILL_MARKER.length)
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== '');

  return names.length === 0 ? null : names;
}

/** What the caller is told to do instead */
function wayThrough(names: string[]): string {
  return (
    'Nothing was executed.\n' +
    'To go ahead, name what is being stopped — the names are checked against what the ' +
    'command reaches:\n' +
    `  <the same command> ${KILL_MARKER} ${names.join(', ')}`
  );
}

/** Everything one strike would reach, as lines under its command */
function listing(preview: StrikePreview): string {
  const verb = preview.strike.subject === 'process' ? 'would signal' : 'would stop';
  const lines = preview.targets.map((target) => `  • ${describe(target)}`);
  return `${preview.strike.written}\n${verb}:\n${lines.join('\n')}`;
}

/**
 * Judge what came back from the machine.
 *
 * Returns the refusal, or null when every strike named its targets and the
 * names match. Three ways to fail are kept apart on purpose: nothing could be
 * asked, the expansion reached nothing, and the expansion reached something
 * the caller did not name.
 */
export function judgeStrikes(previews: StrikePreview[], confirmed: string[] | null): string | null {
  for (const preview of previews) {
    if (preview.unavailable !== undefined)
      return (
        `⛔ BLOCKED: ${preview.strike.written}\n` +
        `What it would reach cannot be established: ${preview.unavailable}.\n` +
        'Nothing was executed. Name the target itself instead of a way of finding it.'
      );

    if (preview.targets.length === 0)
      return (
        `⛔ BLOCKED: ${preview.strike.written}\n` +
        'The expansion reaches nothing on this machine right now, so the command would ' +
        'hit either nothing or whatever appears there in the meantime.\n' +
        'Nothing was executed. Name the target itself instead of a way of finding it.'
      );
  }

  const reached = previews.flatMap((preview) => preview.targets.map(nameOf));

  // A search over the command line matches the command carrying it, so the
  // shell dies before the target does. Naming the targets does not help here:
  // the strike has to be rewritten to reach them by number
  const selfMatching = previews.filter((preview) => preview.strike.selfMatching);

  if (selfMatching.length > 0) {
    const shielded = selfMatching
      .map((preview) => shieldPattern(preview.strike.pattern))
      .find((pattern) => pattern !== null);

    const keepSearching =
      shielded === null || shielded === undefined
        ? ''
        : '\n  • keep the search, but write one character as a class so the pattern stops ' +
          'matching this command, and name what it reaches:\n' +
          `      pkill -f '${shielded}' ${KILL_MARKER} ${reached.join(', ')}`;

    return (
      '⛔ BLOCKED: the pattern matches the command that carries it — the shell running it ' +
      'would be signalled before the intended target, and the reply would break off.\n\n' +
      `${previews.map(listing).join('\n\n')}\n\n` +
      'Nothing was executed. Two ways through:\n' +
      `  • by number: kill ${reached.join(' ')}${keepSearching}`
    );
  }

  if (confirmed === null)
    return (
      '⛔ BLOCKED: the command does not name what it stops — the server would have found ' +
      'it, and what it finds is unknown until then.\n\n' +
      `${previews.map(listing).join('\n\n')}\n\n` +
      wayThrough(reached)
    );

  const unnamed = reached.filter((name) => !confirmed.includes(name));
  const missing = confirmed.filter((name) => !reached.includes(name));

  if (unnamed.length > 0 || missing.length > 0)
    return (
      '⛔ BLOCKED: the confirmation and the machine disagree about the target.\n' +
      (unnamed.length > 0 ? `Would be hit but not named: ${unnamed.join(', ')}\n` : '') +
      (missing.length > 0 ? `Named but not reached: ${missing.join(', ')}\n` : '') +
      '\n' +
      `${previews.map(listing).join('\n\n')}\n\n` +
      wayThrough(reached)
    );

  return null;
}
