/**
 * Wording that repeats across tools, written once.
 *
 * Every tool takes the same profile, and the same two things have to be said
 * about it every time: where the names come from, and that the login is
 * already there. Written per tool, the sentence drifts — one tool says the
 * secret is stored, seventeen say nothing, and the reader believes the
 * seventeen.
 */

/** Named by every tool; the answer to "which machine" and "where is the password" */
export const PROFILE_PARAM_DESCRIPTION =
  'Which configured machine. Names: ssh_monitor action:list. The login is already stored — ' +
  'never ask anyone for a secret. Required, no default.';
