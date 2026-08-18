/**
 * Shape of the ssh_monitor summary: which machine was asked, and in what
 * state it answered.
 *
 * The state decides everything that follows — on `limited` the file tools,
 * the snapshot and the audit have nothing to work with — and until now it was
 * only spoken in the first line of the text, next to an emoji.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PingResult, PingState } from '../runner/types.js';
import { legendFor, LEGEND_SCHEMA, type Legend } from './legend.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

export type MonitorAction = 'stats' | 'reload' | 'test' | 'list' | 'close';

/**
 * What each state says about the machine. The advice that follows from it
 * belongs to the text: here the word is defined, not acted upon.
 */
const STATE_MEANING: Record<PingState, string> = {
  ready: 'logged in, commands run',
  limited: 'logged in and commands run, but the shell is not POSIX',
  'no-route': 'the server was never reached',
  rejected: 'the server was reached and refused the login',
};

/**
 * The answer of one ssh_monitor call.
 *
 * Only `test` reaches the server, so the other actions leave the measured
 * fields `null`: a state nobody checked must not read as a state that was
 * checked and found fine.
 */
export interface MonitorSummary {
  action: MonitorAction;
  /** The machine the action worked on; `null` where the action is about the profiles file */
  profile: string | null;
  state: PingState | null;
  latency_ms: number | null;
  /** Probe's exit code: only `limited` carries one, and `null` means the probe never got to run */
  exit_code: number | null;
  legend: Legend;
}

/** An action that did not go to a server: there is nothing to say about reachability */
export function actionSummary(action: MonitorAction, profile: string | null): MonitorSummary {
  return { action, profile, state: null, latency_ms: null, exit_code: null, legend: {} };
}

/** The outcome of a connection test, as the headline says it */
export function pingSummary(profile: string, result: PingResult): MonitorSummary {
  return {
    action: 'test',
    profile,
    state: result.state,
    latency_ms: result.latencyMs,
    exit_code: result.exitCode ?? null,
    legend: legendFor('state', STATE_MEANING, [result.state]),
  };
}

export const MONITOR_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['stats', 'reload', 'test', 'list', 'close'] },
    profile: { type: ['string', 'null'] },
    state: { type: ['string', 'null'], enum: ['ready', 'limited', 'no-route', 'rejected', null] },
    latency_ms: { type: ['number', 'null'] },
    exit_code: { type: ['number', 'null'] },
    legend: LEGEND_SCHEMA,
  },
  required: ['action', 'profile', 'state', 'latency_ms', 'exit_code', 'legend'],
};
