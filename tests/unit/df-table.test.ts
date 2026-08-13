/**
 * Разбор таблицы `df -hT`.
 *
 * Дефекты, ради которых написан: длинное имя тома df переносит на вторую
 * строку, и запись теряла имя файловой системы; bind-монтирование показывает
 * то же устройство ещё раз, вытесняя из обзора корень.
 */

import { describe, it, expect } from 'vitest';
import { parseDfTable, dedupeByDevice } from '../../src/utils/df-table.js';

/** Дословный `df -hT` от coreutils с переносом длинного имени тома */
const WRAPPED_DF = [
  'Filesystem     Type      Size  Used Avail Use% Mounted on',
  '/dev/vda1      ext4       40G   17G   22G  44% /',
  'nfs-storage.internal.example.com:/export/media/library',
  '               nfs4      2.0T  1.7T  300G  85% /mnt/media',
  'tmpfs          tmpfs     3.9G     0  3.9G   0% /dev/shm',
].join('\n');

/** Дословный `df -hT` от BusyBox в контейнере: корень на overlay, файлы поверх него */
const CONTAINER_DF = [
  'Filesystem           Type            Size      Used Available Use% Mounted on',
  'overlay              overlay       487.1G      5.7G    456.6G   1% /',
  'tmpfs                tmpfs          64.0M         0     64.0M   0% /dev',
  '/dev/vda1            ext4          487.1G      5.7G    456.6G   1% /etc/resolv.conf',
  '/dev/vda1            ext4          487.1G      5.7G    456.6G   1% /etc/hostname',
  '/dev/vda1            ext4          487.1G      5.7G    456.6G   1% /etc/hosts',
].join('\n');

describe('parseDfTable', () => {
  it('перенесённая запись собирается обратно вместе с именем тома', () => {
    const media = parseDfTable(WRAPPED_DF).rows.find((r) => r.mount === '/mnt/media');

    expect(media).toMatchObject({
      filesystem: 'nfs-storage.internal.example.com:/export/media/library',
      type: 'nfs4',
      size: '2.0T',
      used: '1.7T',
      avail: '300G',
      pct: 85,
    });
  });

  it('служебные системы ядра в список не попадают', () => {
    const mounts = parseDfTable(WRAPPED_DF).rows.map((r) => r.mount);

    expect(mounts).toEqual(['/', '/mnt/media']);
  });

  it('корень на overlay остаётся: отбор идёт по типу, а не по имени устройства', () => {
    const mounts = parseDfTable(CONTAINER_DF).rows.map((r) => r.mount);

    expect(mounts).toContain('/');
    expect(mounts).not.toContain('/dev');
  });

  it('строка чужого вида не исчезает, а уходит в неразобранные', () => {
    const table = parseDfTable('Filesystem Type Size\nчто-то совсем другое');

    expect(table.rows).toEqual([]);
    expect(table.unparsed).toEqual(['что-то совсем другое']);
  });

  it('пустой вывод не даёт ни строк, ни жалоб', () => {
    expect(parseDfTable('')).toEqual({ rows: [], unparsed: [] });
  });
});

describe('dedupeByDevice', () => {
  it('одно устройство показывается один раз — по самой короткой точке монтирования', () => {
    const mounts = dedupeByDevice(parseDfTable(CONTAINER_DF).rows).map((r) => r.mount);

    expect(mounts).toEqual(['/', '/etc/hosts']);
  });

  it('разные устройства одного размера остаются оба', () => {
    const rows = parseDfTable(
      [
        'Filesystem Type Size Used Avail Use% Mounted on',
        '/dev/vda1 ext4 40G 17G 22G 44% /',
        '/dev/vdb1 ext4 40G 17G 22G 44% /data',
      ].join('\n')
    ).rows;

    expect(dedupeByDevice(rows).map((r) => r.mount)).toEqual(['/', '/data']);
  });
});
