/**
 * Разбор таблицы `df -hT`.
 */

/** Строка таблицы: том, его тип, размеры и точка монтирования. */
export interface DfRow {
  filesystem: string;
  type: string;
  size: string;
  used: string;
  avail: string;
  pct: number;
  mount: string;
}

/** Разобранные строки и те, что разобрать не вышло. */
export interface DfTable {
  rows: DfRow[];
  unparsed: string[];
}

/**
 * Ровно те системы, что раньше отсекались флагами `-x` у самой df.
 * Список не расширяем: overlay — это корень контейнера, и его исчезновение
 * из отчёта было бы новой потерей данных вместо исправленной.
 */
const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs']);

/**
 * Таблица `df -hT` в строки.
 *
 * Длинное имя тома (overlay-путь docker, адрес NFS) df переносит на вторую
 * строку, поэтому одинокое первое поле склеивается со следующей строкой.
 * Что не сложилось в семь колонок — уходит в `unparsed`, а не пропадает.
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
 * Один том — одна строка, с самой короткой точкой монтирования.
 *
 * Bind-монтирование показывает то же устройство ещё раз: в контейнере три
 * записи про `/etc/hosts` и `/etc/hostname` вытесняли из обзора корень.
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
