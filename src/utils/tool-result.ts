/**
 * Tool response: failure is marked by a flag, not inferred from the text.
 *
 * "No way to tell" doesn't count as a failure — it's a success with a note
 * inside the content, and it gets no flag.
 */

import { partialOutputSection } from './output-notes.js';

/**
 * A tool response in the shape the protocol expects.
 *
 * A type alias, not an interface: the SDK's request handler accepts an
 * object with arbitrary fields, and an interface doesn't fit such a
 * parameter.
 */
export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  /**
   * Parsed response for tools that declared its schema. A failure carries one
   * only where the failure is itself a measurement the caller acts on — a
   * refused login, a copy that differed from its source. Everything else
   * fails with text alone.
   */
  structuredContent?: object;
};

/**
 * The way out of anything a tool could not do.
 *
 * The cases are not worth enumerating — a driver nobody supports, a utility
 * missing from the machine, an engine this server does not speak. They share
 * one exit, and the exit belongs in the refusal itself: a caller told only
 * that the door is shut goes looking for the next door blind, and the first
 * thing it tries is the shell anyway. Which command to run there is the
 * caller's business — this names the tool, not the line.
 */
export const EXEC_FALLBACK = 'What this tool cannot do, ssh_exec can — it runs commands on the machine directly.';

/**
 * A refusal the shell would not get past either.
 *
 * A rule of the profile is not a limitation of the tool: pointing at ssh_exec
 * there teaches the caller to walk around the rule instead of respecting it.
 * Such errors carry this flag and get no way out added.
 */
type GuardedError = { noExecHint: true };

/**
 * The call itself was wrong: a parameter missing, of the wrong kind, out of
 * range. The fix is in the call and nowhere else, so no way out is offered —
 * there is nothing here to work around, and pointing at the shell would send
 * the caller to redo by hand what it only had to ask for correctly.
 */
export class CallerError extends Error {
  readonly noExecHint = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'CallerError';
  }
}

function isGuarded(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as GuardedError).noExecHint === true
  );
}

/** An error that carries the output the command accumulated before it was stopped */
type PartialOutputCarrier = { partialStdout: string; partialStderr: string };

function carriesPartialOutput(error: unknown): error is PartialOutputCarrier {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as PartialOutputCarrier).partialStdout === 'string' &&
    typeof (error as PartialOutputCarrier).partialStderr === 'string'
  );
}

/**
 * Response for a call that processed a list of paths.
 *
 * The header names the number that succeeded, not the number processed:
 * "Read 2 files" over two failures describes work that never happened. Zero
 * successes is a failure of the whole call, flagged the same as the
 * single-path form; a partial outcome isn't a failure — it's honestly shown
 * with markers inside the text.
 */
export function batchOutcome(
  action: string,
  succeeded: number,
  total: number,
  body: string
): ToolResult {
  const result: ToolResult = {
    content: [{ type: 'text', text: `${action} ${succeeded}/${total} files:\n\n${body}` }],
  };
  if (succeeded === 0) result.isError = true;
  return result;
}

/**
 * The tool didn't do what it was asked.
 *
 * A command killed by the timeout manages to print something first, and
 * that's the only trace of its work: it can't be retried — it already
 * started on the server.
 */
export function toolFailure(
  error: unknown,
  structuredContent?: object,
  options: { hint?: boolean } = {}
): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const partial = carriesPartialOutput(error)
    ? partialOutputSection(error.partialStdout, error.partialStderr)
    : '';

  // The shell is not a way round a rule, and it is no answer to a tool that
  // is the shell; everywhere else it is the answer, said once
  const hint =
    options.hint !== false && !isGuarded(error) && !message.includes('ssh_exec')
      ? ` ${EXEC_FALLBACK}`
      : '';
  const text = `Error: ${message}${hint}`;

  const result: ToolResult = {
    content: [{ type: 'text', text: partial ? `${text}\n\n${partial}` : text }],
    isError: true,
  };
  if (structuredContent) result.structuredContent = structuredContent;
  return result;
}
