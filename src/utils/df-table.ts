/**
 * Parses the `df -hT` table.
 */

/** One table row: a volume, its type, sizes and mount point. */
export interface DfRow {
  filesystem: string;
  type: string;
  size: string;
  used: string;
  avail: string;
  pct: number;
  mount: string;
}

/** Parsed rows and the ones that could not be parsed. */
export interface DfTable {
  rows: DfRow[];
  unparsed: string[];
}

/**
 * Filesystem types excluded from the report entirely.
 * The list isn't extended to overlay: it's the container's root, and dropping
 * it from the report would just trade one data blind spot for another.
 */
const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs']);

/**
 * The `df -hT` table into rows.
 *
 * df wraps a long volume name (a docker overlay path, an NFS address) onto a
 * second line, so a lone first field is glued to the following line. Whatever
 * doesn't add up to seven columns goes into `unparsed` instead of vanishing.
 */
export function parseDfTable(text: string): DfTable {
  const rows: DfRow[] = [];
  const unparsed: string[] = [];
  const lines = text.split('\n').slice(1);

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i].trim();
    if (!current) continue;

    let cols = current.split(/\s+/);
    if (cols.length === 1 && i + 1 < lines.length) {
      cols = `${current} ${lines[++i].trim()}`.split(/\s+/);
    }

    if (cols.length < 7) {
      unparsed.push(current);
      continue;
    }
    if (PSEUDO_FS.has(cols[1])) continue;

    const pct = parseInt(cols[5].replace('%', ''), 10);
    rows.push({
      filesystem: cols[0],
      type: cols[1],
      size: cols[2],
      used: cols[3],
      avail: cols[4],
      pct: isNaN(pct) ? 0 : pct,
      mount: cols.slice(6).join(' '),
    });
  }

  return { rows, unparsed };
}

/**
 * One volume, one row, keeping the shortest mount point.
 *
 * A bind mount shows the same device again: in a container three entries for
 * `/etc/hosts` and `/etc/hostname` were crowding the root out of the overview.
 */
export function dedupeByDevice(rows: DfRow[]): DfRow[] {
  const kept = new Map<string, DfRow>();

  for (const row of rows) {
    const device = `${row.filesystem}\t${row.size}\t${row.used}`;
    const seen = kept.get(device);
    if (!seen || row.mount.length < seen.mount.length) kept.set(device, row);
  }

  return [...kept.values()];
}
