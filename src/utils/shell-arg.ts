/**
 * Values that end up in a command string on the server.
 *
 * A path, and any other value that isn't meant to reveal anything, goes
 * through `shellQuote`: inside single quotes the shell sees no space, no
 * `$(…)`, no backslash. The remaining four cases are the ones where quoting
 * is either too little or forbidden by meaning:
 *
 * - a number (`lines`, `context`, `top_n`) — the schema type guarantees
 *   nothing: MCP validates the request envelope, and `arguments` comes
 *   through as-is;
 * - permissions and owner — go into `chmod` and `install` as separate words;
 * - a name pattern (`pattern`) — must expand on the server, so it can't be
 *   quoted; backslash escaping is what protects it instead.
 *
 * A bad value is a rejection with a message, not a silent fix: silently
 * clipped permissions or a silently altered pattern would go unnoticed.
 */

/** What survives in a pattern: letters and digits of any language, harmless punctuation, glob characters */
const GLOB_KEEP = /[^\p{L}\p{N}._/*?[\]-]/gu;

/**
 * A value as a single word for the shell on the server.
 *
 * Inside single quotes nothing is special except the quote itself: it has
 * to be closed, an escaped quote inserted, and reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function reject(name: string, value: unknown, expected: string): never {
  throw new Error(`${name} must be ${expected}, got ${JSON.stringify(String(value))}`);
}

/** A whole non-negative number: a line count, a sample size */
export function shellCount(value: unknown, name: string): number {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';

  if (!/^\d+$/.test(text)) reject(name, value, 'a whole number');

  return Number(text);
}

/**
 * Permissions: octal (`644`, `0755`) or symbolic (`u+x`, `go-w,a+r`).
 *
 * The symbolic form is accepted alongside octal: the danger isn't in its
 * letters but in what might ride along with them. Everything a permission
 * string can't legitimately contain is stripped — that's enough protection,
 * and there's no reason to take away a working form.
 */
export function shellMode(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';

  const octal = /^[0-7]{3,4}$/;
  const symbolic = /^[ugoa]*[+\-=][rwxXst]*(,[ugoa]*[+\-=][rwxXst]*)*$/;

  if (!octal.test(text) && !symbolic.test(text)) {
    reject(name, value, 'an octal permission like 644 or a symbolic one like u+x');
  }

  return text;
}

/**
 * Owner: `user` or `user:group`.
 *
 * A leading dash is rejected separately: `install -o -rf` would parse such
 * a name as its own flag, and quoting doesn't protect against that.
 */
export function shellOwner(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';

  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/.test(text)) {
    reject(name, value, 'a user name or user:group');
  }

  return text;
}

/**
 * A file name pattern: `*`, `?`, `[…]` reach the server intact, everything
 * else gets a backslash and becomes a plain character.
 *
 * Quoting is forbidden here: inside quotes the pattern would stop
 * expanding, and expansion is the whole point of the parameter. A newline
 * and other control characters are rejected — a backslash before a newline
 * means command continuation, exactly what we're guarding against.
 */
export function shellGlob(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value : '';

  if (text === '') reject(name, value, 'a file name pattern');
  if ([...text].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
    reject(name, value, 'free of control characters');
  }
  if (text.startsWith('-')) reject(name, value, 'a pattern that does not start with "-"');

  return text.replace(GLOB_KEEP, (char) => `\\${char}`);
}
