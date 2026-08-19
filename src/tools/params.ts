/**
 * Wording that repeats across tools, written once.
 *
 * Every tool takes the same profile, so anything said here is said eighteen
 * times over. What the line has to carry is which machine and where the names
 * come from; that the login is already stored belongs to the server
 * instructions, which say it once for the whole session.
 */

/** Named by every tool; the answer to "which machine" */
export const PROFILE_PARAM_DESCRIPTION = 'Machine name. Names: ssh_monitor action:list.';

/**
 * When to take root, said the same way everywhere it is offered.
 *
 * Two moments need an answer, and one of them agents ask about out loud: a
 * place known to be closed beforehand, and a place that turned out to be
 * closed only from the answer. Named apart, they cost a round trip at most;
 * merged, they cost a wrong reading of an empty section.
 */
export const SUDO_PARAM_DESCRIPTION =
  'Read as root. Straight away for places a plain user cannot read (/root, /var/lib/docker); ' +
  'otherwise retry with true when the answer names what it could not read. Default: false';
