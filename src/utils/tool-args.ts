/**
 * The shape of tool arguments: whether a parameter is present and of the
 * right kind.
 *
 * `shell-arg.ts` lives alongside this module — it's about the **value**
 * (`lines`, `mode`, `pattern`) that goes into the command. This one is
 * about the **shape**: whether a required parameter arrived at all, and
 * whether it's a string, an array of strings, or an object.
 *
 * Without this check, a malformed argument shape doesn't produce a clean
 * rejection — it surfaces as an internal crash such as `Cannot read
 * properties of undefined (reading 'path')` when `ssh_file_write` is called
 * without `files`, or `finalCommand.substring is not a function` for
 * `command: 42`. That text doesn't say what's wrong, so an agent falls back
 * to `ssh_exec` instead.
 *
 * The schema doesn't save us from this: MCP validates the request envelope,
 * and `arguments` comes through as-is — `oneOf` in the schema stays a
 * description for the client, not a guard.
 *
 * Rejection messages are kept in the same format as `shell-arg.ts`: what was
 * expected and what arrived. An empty list is also a rejection: "write zero
 * files" isn't work done, it's a lost call the caller needs to know about.
 */

/**
 * A value in a rejection message: "nothing" is distinct from an empty
 * string and from zero.
 *
 * Long content is truncated: what matters in a rejection is **what** arrived
 * in the wrong shape, not the whole config. `JSON.stringify` returns
 * `undefined` for a function or a symbol — hence the `??`, otherwise the
 * rejection message itself would fail on `.slice`.
 */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  }
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return JSON.stringify(value)?.slice(0, 80) ?? String(value);
}

function reject(name: string, value: unknown, expected: string): never {
  throw new Error(`${name} must be ${expected}, got ${describe(value)}`);
}

/** A required string: a destination path, a directory, a file name */
export function requireText(value: unknown, name: string, example: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject(name, value, `a non-empty string like ${example}`);
  }

  return value;
}

/**
 * A required string or array of strings — the shape declared via `oneOf`
 * for `command` and `path`. Always returns an array: the caller doesn't
 * need to repeat the shape parsing itself.
 */
export function requireTextList(value: unknown, name: string, example: string): string[] {
  const expected = `a string like ${example} or an array of such strings`;

  if (typeof value === 'string') {
    if (value.trim() === '') reject(name, value, expected);
    return [value];
  }

  if (!Array.isArray(value)) reject(name, value, expected);
  if (value.length === 0) reject(name, value, `${expected} — the list is empty`);

  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      reject(`${name}[${index}]`, item, 'a non-empty string');
    }
  });

  return value as string[];
}

/**
 * A required object or array of objects — the shape of `files` for
 * `ssh_file_write`. Required fields on each entry are checked right here:
 * without this check, the code further down would hit the very
 * `undefined.path` this module exists to prevent.
 */
export function requireEntryList<F extends string>(
  value: unknown,
  name: string,
  required: readonly F[],
  example: string
): Array<Record<string, unknown> & Record<F, string>> {
  const expected = `an object like ${example} or an array of such objects`;

  const isEntry = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

  const entries = Array.isArray(value) ? value : [value];

  if (!Array.isArray(value) && !isEntry(value)) reject(name, value, expected);
  if (Array.isArray(value) && value.length === 0) {
    reject(name, value, `${expected} — the list is empty`);
  }

  entries.forEach((entry, index) => {
    const where = Array.isArray(value) ? `${name}[${index}]` : name;
    if (!isEntry(entry)) reject(where, entry, 'an object');

    for (const field of required) {
      if (typeof entry[field] !== 'string') {
        reject(`${where}.${field}`, entry[field], 'a string');
      }
    }
  });

  return entries as Array<Record<string, unknown> & Record<F, string>>;
}
