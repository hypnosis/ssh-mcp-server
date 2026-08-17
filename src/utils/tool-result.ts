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
   * Parsed response for tools that declared its schema. A failure has none:
   * the client only requires parsing for a response without the failure flag.
   */
  structuredContent?: object;
};

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
export function toolFailure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const partial = carriesPartialOutput(error)
    ? partialOutputSection(error.partialStdout, error.partialStderr)
    : '';

  return {
    content: [{ type: 'text', text: partial ? `Error: ${message}\n\n${partial}` : `Error: ${message}` }],
    isError: true,
  };
}
