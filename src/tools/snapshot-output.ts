/**
 * Shape of the ssh_snapshot summary: the few numbers a decision is made on.
 *
 * The overview itself stays whole — this is a header above it. What could not
 * be measured is named in `unavailable` and arrives as `null`, never as zero:
 * a router that has neither ss nor netstat would otherwise report "0 listening
 * ports", and nothing listening reads as a machine that is fine.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

export interface SnapshotSummary {
  /** The fullest filesystem, in percent — the one a decision is made on */
  disk_pct: number | null;
  mem_pct: number | null;
  cpu_pct: number | null;
  load: string | null;
  /** Running containers; `null` — there is no docker on the server */
  containers: number | null;
  ports: number | null;
  /** Well-known services found running; `null` — systemd never answered */
  services_running: number | null;
  /** Fresh error lines in the journal; `null` — there was no journal to read */
  recent_errors: number | null;
  /** Sections there was nothing to measure with */
  unavailable: string[];
}

/**
 * One decimal place, the same as the overview prints.
 *
 * The raw share of the processor arrives as 4.900000000000006, and the text
 * next to it says 4.9: two different numbers for one measurement send the
 * reader looking for a difference that does not exist.
 */
function roundedPercent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** Percentage out of a df row: "43%" → 43 */
function percentOf(text: string): number | null {
  const digits = parseInt(text, 10);
  return Number.isNaN(digits) ? null : digits;
}

/** The numbers of one snapshot, pulled out of the sections it was collected from */
export function snapshotSummary(parts: {
  cpu: { usage: number | null; loadAvg: string | null };
  memory: { percent: number | null };
  disk: { items: Array<{ percent: string }> };
  docker?: { containers: unknown[] };
  network: { checked: boolean; listening: unknown[] };
  services: { checked: boolean; items: Array<{ status: string }> };
  recentErrors: { checked: boolean; items: unknown[] };
}): SnapshotSummary {
  const diskPercents = parts.disk.items
    .map((item) => percentOf(item.percent))
    .filter((value): value is number => value !== null);

  const summary: SnapshotSummary = {
    disk_pct: diskPercents.length > 0 ? Math.max(...diskPercents) : null,
    mem_pct: parts.memory.percent,
    cpu_pct: roundedPercent(parts.cpu.usage),
    load: parts.cpu.loadAvg,
    containers: parts.docker ? parts.docker.containers.length : null,
    ports: parts.network.checked ? parts.network.listening.length : null,
    services_running: parts.services.checked
      ? parts.services.items.filter((item) => item.status === 'active').length
      : null,
    recent_errors: parts.recentErrors.checked ? parts.recentErrors.items.length : null,
    unavailable: [],
  };

  // The list names the field, not the command behind it: the caller reads the
  // field and has to see its own name explaining why it is empty
  if (summary.disk_pct === null) summary.unavailable.push('disk_pct');
  if (summary.mem_pct === null) summary.unavailable.push('mem_pct');
  if (summary.cpu_pct === null) summary.unavailable.push('cpu_pct');
  if (summary.load === null) summary.unavailable.push('load');
  if (summary.ports === null) summary.unavailable.push('ports');
  if (summary.services_running === null) summary.unavailable.push('services_running');
  if (summary.recent_errors === null) summary.unavailable.push('recent_errors');

  return summary;
}

export const SNAPSHOT_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    disk_pct: { type: ['number', 'null'] },
    mem_pct: { type: ['number', 'null'] },
    cpu_pct: { type: ['number', 'null'] },
    load: { type: ['string', 'null'] },
    containers: { type: ['number', 'null'] },
    ports: { type: ['number', 'null'] },
    services_running: { type: ['number', 'null'] },
    recent_errors: { type: ['number', 'null'] },
    unavailable: { type: 'array', items: { type: 'string' } },
  },
};
