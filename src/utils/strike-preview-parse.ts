/**
 * Builds the question about a blind strike, and reads the answer
 *
 * The strike names a way to find its target, not the target itself. This
 * module turns those ways into one request — what would be hit, and does it
 * look like something in use — and reads the reply back into records.
 *
 * The server is asked for raw material only: `/proc` files as they are, the
 * container listing as one line each. Deciding what a hexadecimal socket
 * state means is done here, where it can be tested without a machine.
 */

import type { BlindStrike } from './blind-target.js';

/** Section markers: the reply carries several answers in one stream */
const MARK = {
  clock: '@@CLK',
  uptime: '@@UPTIME',
  net: '@@NET',
  containers: '@@CONTAINERS',
  strike: '@@STRIKE',
  procs: '@@PROCS',
} as const;

/** Said when a program the question needs is not on the machine */
const MISSING = 'SSH_MCP_NO_TOOL';

/**
 * Marker that tells our own question apart from what it finds.
 *
 * A search by command line matches the search itself: the pattern is written
 * inside the command that carries it, so `pgrep -f app` finds the shell
 * running the question. Without this the preview reports a target that
 * exists only because someone asked about it.
 */
const OWN_WORK = 'SSH_MCP_PREVIEW';

/** Clock ticks per second where the server does not say */
const DEFAULT_CLOCK = 100;

/** Socket states in `/proc/net/tcp`: listening, and carrying a connection */
const LISTENING = '0A';
const ESTABLISHED = '01';

/** A container the strike would stop */
export interface PreviewedContainer {
  kind: 'container';
  name: string;
  image: string;
  /** As the engine says it: `Up 34 days` */
  status: string;
  /** As the engine says it: `0.0.0.0:443->443/tcp` */
  ports: string;
}

/** A process the strike would signal */
export interface PreviewedProcess {
  kind: 'process';
  pid: number;
  /** The command line it runs, whole */
  command: string;
  /** Seconds since it started, or null when the server did not say */
  age: number | null;
  /** Ports it accepts connections on */
  listening: number[];
  /** Connections it is carrying right now */
  established: number;
}

export type PreviewedTarget = PreviewedContainer | PreviewedProcess;

/** What one strike turned out to mean */
export interface StrikePreview {
  strike: BlindStrike;
  /** What would be hit; empty means the expansion named nothing */
  targets: PreviewedTarget[];
  /** Why the question could not be answered — the outcome that is neither hit nor empty */
  unavailable?: string;
}

/** Which engine the verb belongs to: the probe and the listing must agree */
function engineOf(strike: BlindStrike): string {
  const first = strike.verb.split(' ')[0];
  return first === 'docker-compose' ? 'docker' : first;
}

/**
 * Build one request that answers every strike at once.
 *
 * Strikes with nothing to expand are left out: there is no question to ask
 * about them, and their outcome is decided without the server.
 */
export function buildPreviewCommand(strikes: BlindStrike[]): string {
  const answerable = strikes.filter((strike) => strike.probe !== null);
  const parts: string[] = [];

  const wantsProcesses = answerable.some((strike) => strike.subject !== 'container');
  const engines = new Set(answerable.filter((s) => s.subject === 'container').map(engineOf));

  parts.push(`echo ${MARK.clock}; getconf CLK_TCK 2>/dev/null || echo ${DEFAULT_CLOCK}`);

  if (wantsProcesses) {
    parts.push(`echo ${MARK.uptime}; cat /proc/uptime 2>/dev/null`);
    parts.push(`echo ${MARK.net}; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null`);
  }

  for (const engine of engines) {
    parts.push(
      `echo ${MARK.containers} ${engine}; ` +
        `command -v ${engine} >/dev/null 2>&1 && ` +
        `${engine} ps --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1 || ` +
        `echo ${MISSING}`
    );
  }

  for (const [index, strike] of strikes.entries()) {
    if (strike.probe === null) continue;

    parts.push(`echo ${MARK.strike} ${index}; OUT=$(${strike.probe} 2>&1); echo "$OUT"`);

    if (strike.subject === 'container') continue;

    // The processes are only known once the probe has answered, so their
    // details are collected in the same breath rather than in a second call
    parts.push(
      `echo ${MARK.procs} ${index}; ` +
        'echo "$OUT" | awk \'{print $1}\' | while read -r pid; do ' +
        '[ -d "/proc/$pid" ] || continue; ' +
        // The command line comes from the machine rather than from the probe:
        // the probe was written by the caller and need not print it at all
        'line=$(tr \'\\0\\n\' \'  \' < "/proc/$pid/cmdline" 2>/dev/null); ' +
        `case "$line" in *${OWN_WORK}*) continue;; esac; ` +
        'echo "#$pid $(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null) $line"; ' +
        'ls -l "/proc/$pid/fd" 2>/dev/null | sed -n \'s/.*socket:\\[\\([0-9]*\\)\\].*/\\1/p\'; ' +
        'done'
    );
  }

  return parts.join('; ');
}

/** The stream cut into sections, each keeping the lines that followed its marker */
function sections(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;

  for (const line of stdout.split('\n')) {
    const marker = Object.values(MARK).find((mark) => line.trim().startsWith(mark));

    if (marker !== undefined) {
      current = [];
      found.set(line.trim(), current);
      continue;
    }

    if (current !== null) current.push(line);
  }

  return found;
}

/** Lines of a section, empty ones dropped */
function linesOf(found: Map<string, string[]>, key: string): string[] {
  return (found.get(key) ?? []).map((line) => line.trim()).filter((line) => line !== '');
}

/** Sockets by inode: what state each is in, and which port it holds */
interface Socket {
  port: number;
  state: string;
}

/** Read `/proc/net/tcp`: the local address holds the port in hexadecimal */
function readSockets(lines: string[]): Map<string, Socket> {
  const sockets = new Map<string, Socket>();

  for (const line of lines) {
    const columns = line.split(/\s+/);
    // The header names its columns; a record starts with `<n>:`
    if (columns.length < 10 || !/^\d+:$/.test(columns[0])) continue;

    const port = Number.parseInt(columns[1].split(':')[1] ?? '', 16);
    const inode = columns[9];
    if (Number.isNaN(port) || inode === undefined) continue;

    sockets.set(inode, { port, state: columns[3] });
  }

  return sockets;
}

/** Seconds a process has been running, or null when either number is missing */
function ageOf(startTicks: string | undefined, uptime: number | null, clock: number): number | null {
  if (startTicks === undefined || uptime === null) return null;

  const ticks = Number(startTicks);
  if (!Number.isFinite(ticks)) return null;

  return Math.max(0, Math.round(uptime - ticks / clock));
}

/** The processes one strike found, with what each holds open */
function readProcesses(
  procLines: string[],
  sockets: Map<string, Socket>,
  uptime: number | null,
  clock: number
): PreviewedProcess[] {
  const processes: PreviewedProcess[] = [];
  let current: PreviewedProcess | null = null;

  for (const line of procLines) {
    const header = /^#(\d+)\s+(\d*)\s*(.*)$/.exec(line);

    if (header !== null) {
      current = {
        kind: 'process',
        pid: Number(header[1]),
        command: header[3].trim(),
        age: ageOf(header[2] === '' ? undefined : header[2], uptime, clock),
        listening: [],
        established: 0,
      };
      processes.push(current);
      continue;
    }

    const socket = current === null ? undefined : sockets.get(line);
    if (current === null || socket === undefined) continue;

    if (socket.state === LISTENING && !current.listening.includes(socket.port))
      current.listening.push(socket.port);
    if (socket.state === ESTABLISHED) current.established += 1;
  }

  return processes;
}

/** The containers one strike found, matched by the identifier or the name the probe printed */
function readContainers(probeLines: string[], listing: string[]): PreviewedContainer[] {
  const known = listing
    .map((line) => line.split('|'))
    .filter((columns) => columns.length >= 5);

  const found: PreviewedContainer[] = [];

  for (const line of probeLines) {
    const columns = known.find(([id, name]) => id.startsWith(line) || name === line);
    if (columns === undefined) continue;

    const [, name, image, status, ports] = columns;
    if (!found.some((container) => container.name === name))
      found.push({ kind: 'container', name, image, status, ports });
  }

  return found;
}

/**
 * Read the reply into one record per strike.
 *
 * Three outcomes stay apart: the strike has targets, the strike found
 * nothing, or the machine could not be asked. The last one is why the reply
 * carries a marker for a missing program instead of an empty listing.
 */
export function readPreview(strikes: BlindStrike[], stdout: string): StrikePreview[] {
  const found = sections(stdout);

  const clockLine = linesOf(found, MARK.clock)[0];
  const clock = Number(clockLine) > 0 ? Number(clockLine) : DEFAULT_CLOCK;

  const uptimeLine = linesOf(found, MARK.uptime)[0];
  const uptime = uptimeLine === undefined ? null : Number(uptimeLine.split(/\s+/)[0]);

  const sockets = readSockets(linesOf(found, MARK.net));

  return strikes.map((strike, index) => {
    if (strike.probe === null)
      return {
        strike,
        targets: [],
        unavailable: 'the command gives nothing to expand: the target only exists once the server has run it',
      };

    const probeLines = linesOf(found, `${MARK.strike} ${index}`);

    if (strike.subject === 'container') {
      const engine = engineOf(strike);
      const listing = linesOf(found, `${MARK.containers} ${engine}`);

      if (listing.includes(MISSING))
        return { strike, targets: [], unavailable: `${engine} is not on the machine, so its containers cannot be named` };

      return { strike, targets: readContainers(probeLines, listing) };
    }

    return {
      strike,
      targets: readProcesses(
        linesOf(found, `${MARK.procs} ${index}`),
        sockets,
        Number.isFinite(uptime) ? uptime : null,
        clock
      ),
    };
  });
}
