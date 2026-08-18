/**
 * Strips what a terminal draws with from text meant to be read.
 */

/**
 * Escape sequences a shell sends to move the cursor, erase a line or set a
 * colour. A device CLI emits them even with no terminal attached, and they
 * arrive as a stray `[K` in the middle of an answer.
 */
const CONTROL_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** A lone escape left over from a sequence the read cut short */
const LONE_ESCAPE = /\u001B/g;

/**
 * Text without the terminal's own drawing.
 *
 * Applied where an answer is read rather than stored: a file keeps its bytes,
 * because an escape sequence inside a file is data, not decoration.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(CONTROL_SEQUENCE, '').replace(LONE_ESCAPE, '');
}
