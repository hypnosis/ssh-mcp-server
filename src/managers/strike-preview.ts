/**
 * Asks the machine what a blind strike would actually hit.
 *
 * The command text names a way to find a target, and the way resolves only on
 * the server. Everything the answer needs — the expansion itself, the
 * container listing, the `/proc` records — is asked in one request, the way
 * removal targets are resolved before a deletion.
 *
 * Nothing here decides whether to refuse: this layer only turns a way of
 * finding into a list of what was found, and says plainly when it could not.
 */

import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import type { BlindStrike } from '../utils/blind-target.js';
import {
  buildPreviewCommand,
  readPreview,
  type StrikePreview,
} from '../utils/strike-preview-parse.js';

/** A strike nobody could ask about, with the reason in place of its targets */
function unanswered(strikes: BlindStrike[], reason: string): StrikePreview[] {
  return strikes.map((strike) => ({ strike, targets: [], unavailable: reason }));
}

/**
 * Name what each strike would hit.
 *
 * A strike whose target has nothing to expand never reaches the server: its
 * outcome is settled by the text. Everything else goes in one request, and a
 * request that fails or comes back clipped is the third outcome — not an
 * empty list of targets, which would read as "there is nothing there".
 */
export async function previewStrikes(
  executor: SSHExecutor,
  config: SSHConfig,
  strikes: BlindStrike[],
  options: { sudo?: boolean } = {}
): Promise<StrikePreview[]> {
  if (strikes.length === 0) return [];

  const command = buildPreviewCommand(strikes);
  if (!command.includes('@@STRIKE')) return readPreview(strikes, '');

  let stdout: string;

  try {
    const result = await executor.execute(config, command, {
      sudo: options.sudo,
      idempotent: true,
    });

    // A clipped answer is not a short one: the records that did not fit look
    // exactly like targets that do not exist
    if (result.truncated)
      return unanswered(strikes, 'the answer did not fit the buffer, so the list of targets is incomplete');

    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unanswered(strikes, `the machine could not be asked what would be hit: ${detail}`);
  }

  return readPreview(strikes, stdout);
}
