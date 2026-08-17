/**
 * Server passport
 *
 * One probe per session instead of a scatter of one-off checks like "does
 * the server have bash / timeout / what to hash with". From then on every
 * decision is made from the passport, not from separate round trips to the server.
 *
 * Two rules, without which the passport would become a source of failures itself:
 *
 * 1. The probe runs as `sh -c '…'`. The remote command executes in the
 *    user's login shell, which could be csh or fish with different syntax;
 *    running a program with an argument is valid in any shell. The remote
 *    guard is not applied to the probe — the command language is exactly
 *    what it's finding out.
 * 2. The response is read by marker: banner, motd, and any stray output are
 *    ignored. No marker — we assume we know nothing and take the cautious
 *    path. The passport speeds things up and refines them, but never grants
 *    permission on its own.
 */

import { logger } from '../utils/logger.js';

/** What to hash sha256 with on the server */
export type Sha256Tool = 'sha256sum' | 'openssl' | 'none';

/** Which flavor of base utilities the server has */
type UtilityFlavor = 'coreutils' | 'busybox' | 'unknown';

export interface ServerPassport {
  /** Whether bash is present — determines the language we send commands in */
  bash: boolean;
  sha256: Sha256Tool;
  coreutils: UtilityFlavor;
  rsync: boolean;
  /** Whether the `timeout` utility is available for the remote guard */
  remoteTimeout: boolean;
  /**
   * Whether `setsid` is available — used to detach a background task.
   *
   * Without it the task stays in the ssh session and can't be killed as a
   * group: the leader's pid matches its pgid only in its own session.
   */
  setsid: boolean;
  install: boolean;
  /** What `uname -s` reported — for diagnostics and error text */
  os: string;
  /**
   * The user's home directory — the only way to expand `~`.
   *
   * The tilde can't be expanded on the server: the path travels inside
   * single-quoted commands, where `~` stays a literal character, and without
   * quotes any name with a space or `$` would fall apart. An empty string
   * means "unknown" — a `~`-path is then rejected, not guessed at.
   */
  home: string;
  /** Whether the passport could be read at all */
  known: boolean;
}

const MARKER = 'SSH_MCP_PASSPORT';

/**
 * The most cautious state possible: assume nothing.
 *
 * No bash, no remote guard, nothing to hash with. Each of these values leads
 * to a slower but safe path — and none of them blocks the operation itself.
 */
export const UNKNOWN_PASSPORT: ServerPassport = Object.freeze({
  bash: false,
  sha256: 'none',
  coreutils: 'unknown',
  rsync: false,
  remoteTimeout: false,
  setsid: false,
  install: false,
  os: 'unknown',
  home: '',
  known: false,
});

/**
 * The probe: one line of output, nothing extra.
 *
 * The utility set is told apart by `ls --version`: coreutils has it,
 * BusyBox doesn't. The same trick can't be used for `sha256sum` — it might
 * simply be absent, and the machine would be mistakenly classified as BusyBox.
 *
 * The home directory is printed last: it can contain spaces, so it has to be
 * read to the end of the line rather than field by field like the rest.
 */
export const PASSPORT_PROBE_COMMAND =
  `sh -c 'printf "${MARKER} bash=%s sha256=%s coreutils=%s rsync=%s timeout=%s setsid=%s install=%s os=%s home=%s\\n" ` +
  `"$(command -v bash >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v sha256sum >/dev/null 2>&1 && echo sha256sum || { command -v openssl >/dev/null 2>&1 && echo openssl || echo none; })" ` +
  `"$(ls --version >/dev/null 2>&1 && echo coreutils || echo busybox)" ` +
  `"$(command -v rsync >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v timeout >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v setsid >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(command -v install >/dev/null 2>&1 && echo 1 || echo 0)" ` +
  `"$(uname -s 2>/dev/null || echo unknown)" ` +
  `"$HOME"'`;

/** Parse the probe's output. Unrecognized values are treated as "unknown". */
export function parsePassport(stdout: string): ServerPassport {
  const line = stdout.split('\n').find((candidate) => candidate.includes(MARKER));
  if (!line) return UNKNOWN_PASSPORT;

  const body = line.slice(line.indexOf(MARKER) + MARKER.length).trim();

  // The home directory is sliced off first, in one piece: it can contain
  // spaces, and splitting on whitespace would truncate the path at the
  // first one — sending a write into the wrong directory
  const homeAt = body.indexOf('home=');
  const home = homeAt >= 0 ? body.slice(homeAt + 'home='.length).trim() : '';

  const fields = new Map<string, string>();
  for (const token of (homeAt >= 0 ? body.slice(0, homeAt) : body).trim().split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator > 0) fields.set(token.slice(0, separator), token.slice(separator + 1));
  }

  const isSet = (key: string): boolean => fields.get(key) === '1';
  const sha256 = fields.get('sha256');
  const coreutils = fields.get('coreutils');

  return {
    bash: isSet('bash'),
    sha256: sha256 === 'sha256sum' || sha256 === 'openssl' ? sha256 : 'none',
    coreutils: coreutils === 'coreutils' || coreutils === 'busybox' ? coreutils : 'unknown',
    rsync: isSet('rsync'),
    remoteTimeout: isSet('timeout'),
    setsid: isSet('setsid'),
    install: isSet('install'),
    os: fields.get('os') || 'unknown',
    // Only an absolute path counts: anything else is a sign that the
    // variable isn't set on the server, and refusing is safer than guessing at a file write
    home: home.startsWith('/') ? home : '',
    known: true,
  };
}

/** A probe that takes the passport: returns the remote command's stdout */
export type PassportProbe = () => Promise<string>;

/**
 * Destination key — the same `user@host:port` used by the transport cache.
 *
 * Computed in one place: tools ask for the passport through the executor,
 * the transport asks for its own, and both must land on the same cache entry.
 */
export function passportKey(config: { username: string; host: string; port?: number }): string {
  return `${config.username}@${config.host}:${config.port ?? 22}`;
}

/**
 * The cached value is a promise, not a result: otherwise two parallel first
 * commands would race to run the probe and cause two redundant round trips
 * to the server.
 */
const passportCache = new Map<string, Promise<ServerPassport>>();

/**
 * Passport for a destination. The key is the same `user@host:port` used by
 * the transport cache: two profiles for the same server under the same user
 * see one shared passport.
 */
export async function getServerPassport(
  key: string,
  probe: PassportProbe
): Promise<ServerPassport> {
  const cached = passportCache.get(key);
  if (cached) return cached;

  const pending = probe()
    .then(parsePassport)
    .catch((error: Error) => {
      // A failed probe shouldn't block the operation itself: it may well be
      // doable anyway. No entry is kept — the next call will try again.
      passportCache.delete(key);
      logger.debug(`[Passport] ${key}: probe failed (${error.message}), assuming nothing`);
      return UNKNOWN_PASSPORT;
    });

  passportCache.set(key, pending);
  return pending;
}

/**
 * Forget the passport for a destination.
 *
 * Needed when the server changed under us: a promised utility turned out to
 * be missing, credentials changed, packages were reinstalled.
 */
export function invalidatePassport(key: string): void {
  passportCache.delete(key);
}

/** Reset the whole cache (used in tests) */
export function resetPassportCache(): void {
  passportCache.clear();
}
