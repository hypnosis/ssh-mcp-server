/**
 * Манифест дерева — чем сверяется результат передачи.
 *
 * Вместо «прочитали файл, сравнили» снимаем с обеих сторон один список:
 * каталоги, файлы, их права и sha256. Сравнение двух таких списков закрывает
 * сразу содержимое, структуру, права, кодировку имён и отсутствие лишнего —
 * например, лишний уровень вложенности виден как разница путей.
 *
 * Удалённую сторону считает `find` с `sha256sum`, а не наш код: проверять
 * свой код своим же кодом бессмысленно.
 */

import { createHash } from 'crypto';
import { readdir, readFile, stat, mkdir, writeFile, chmod } from 'fs/promises';
import { join } from 'path';

/** Права в восьмеричном виде: 644, 755 */
function octalMode(mode: number): string {
  return (mode & 0o777).toString(8);
}

/**
 * Строки манифеста: `d <путь>` и `f <права> <sha256> <путь>`.
 *
 * У каталогов права не сверяем: их выставляет umask принимающей стороны,
 * и расхождение здесь говорило бы о настройках машины, а не о транспорте.
 */
export type Manifest = string;

/** Манифест локального дерева */
export async function localManifest(root: string): Promise<Manifest> {
  const lines: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? join(root, relative) : root;
    const entries = await readdir(absolute, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(absolute, entry.name);

      if (entry.isDirectory()) {
        lines.push(`d ${child}`);
        await walk(child);
      } else if (entry.isFile()) {
        const info = await stat(path);
        const sha = createHash('sha256').update(await readFile(path)).digest('hex');
        lines.push(`f ${octalMode(info.mode)} ${sha} ${child}`);
      } else {
        lines.push(`? ${child}`);
      }
    }
  };

  await walk('');
  return lines.sort().join('\n');
}

/**
 * Команда, снимающая манифест на сервере.
 *
 * Работает и на BusyBox, и на coreutils: `find`, `stat -c`, `sha256sum` есть
 * в обоих наборах. Имена с пробелами и кириллицей проходят как есть.
 */
export function remoteManifestCommand(remoteDir: string): string {
  const dir = `'${remoteDir.split("'").join(`'\\''`)}'`;
  return [
    `cd ${dir} || exit 1`,
    `find . -mindepth 1 -type d | while IFS= read -r p; do printf 'd %s\\n' "\${p#./}"; done`,
    `find . -mindepth 1 -type f | while IFS= read -r p; do`,
    `  printf 'f %s %s %s\\n' "$(stat -c %a "$p")" "$(sha256sum "$p" | cut -d' ' -f1)" "\${p#./}"`,
    `done`,
    `find . -mindepth 1 ! -type d ! -type f | while IFS= read -r p; do printf '? %s\\n' "\${p#./}"; done`,
  ].join('\n');
}

/** Привести вывод команды к тому же виду, что и локальный манифест */
export function parseRemoteManifest(stdout: string): Manifest {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
}

/** Файл образцового дерева */
export interface FixtureFile {
  /** Путь относительно корня дерева */
  path: string;
  content: string;
  /** Права; по умолчанию 644 */
  mode?: number;
}

/**
 * Образцовое дерево для сетки.
 *
 * Каждая строка закрывает своё утверждение: вложенность, пустой подкаталог,
 * исполняемый бит, имена с пробелом, кириллицей, апострофом, точкой с запятой
 * и звёздочкой — те самые, на которых расходятся `scp` через shell и SFTP.
 */
export const TREE_FILES: FixtureFile[] = [
  { path: 'plain.txt', content: 'простой файл\n' },
  { path: 'run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
  { path: 'nested/deep/inner.txt', content: 'глубоко\n' },
  { path: 'sp ace.txt', content: 'имя с пробелом\n' },
  { path: 'кириллица.txt', content: 'содержимое по-русски\n' },
  { path: "it's.txt", content: 'апостроф в имени\n' },
  { path: 'semi;colon.txt', content: 'точка с запятой\n' },
  { path: 'star*name.txt', content: 'звёздочка в имени\n' },
];

/** Пустой каталог внутри дерева: файлов нет, а приехать обязан */
export const TREE_EMPTY_DIR = 'empty-dir';

/** Создать образцовое дерево локально */
export async function createTree(root: string): Promise<void> {
  await mkdir(join(root, TREE_EMPTY_DIR), { recursive: true });

  for (const file of TREE_FILES) {
    const target = join(root, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file.content);
    await chmod(target, file.mode ?? 0o644);
  }
}
