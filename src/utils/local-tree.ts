/**
 * Обход локального дерева перед загрузкой
 *
 * Дерево считается так же, как его видит транспорт: `scp -r` идёт по ссылкам
 * и привозит копии, а на битой ссылке и на цикле останавливается. Если считать
 * иначе, ответ инструмента разойдётся с тем, что уехало: счётчик файлов и
 * размер окажутся занижены, а проверка хешей накроет не всё дерево.
 *
 * Битую ссылку и цикл ловим здесь, до передачи. Транспорт заметит их сам, но
 * уже на середине — часть дерева к тому времени лежит на сервере.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';

/** Что сломано в ссылке — по коду ошибки от stat */
function describeBadLink(relative: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ENOENT') {
    return new Error(
      `broken symlink in the tree: "${relative}" points at something that does not exist. ` +
      `Remove the link or fix its target — the transfer would fail halfway through.`
    );
  }

  if (code === 'ELOOP') {
    return new Error(
      `symlink loop in the tree: "${relative}" leads back to itself. ` +
      `Remove the link — the transfer would fail halfway through.`
    );
  }

  return error as Error;
}

/**
 * Относительные пути всех файлов дерева.
 *
 * Ссылка на файл считается файлом, в ссылку на каталог заходим — ровно то,
 * что привезёт транспорт.
 */
export async function listTreeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (relative: string, ancestors: Set<string>): Promise<void> => {
    const absolute = relative ? join(root, relative) : root;

    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;

      let info;
      try {
        info = await stat(join(absolute, entry.name));
      } catch (error) {
        throw describeBadLink(child, error);
      }

      if (info.isDirectory()) {
        // Ссылка на каталог-предок увела бы обход в бесконечность, а stat
        // об этом не скажет: сам по себе такой каталог существует
        const id = `${info.dev}:${info.ino}`;
        if (ancestors.has(id)) {
          throw new Error(
            `symlink loop in the tree: "${child}" leads back to a directory above it. ` +
            `Remove the link — the transfer would fail halfway through.`
          );
        }

        await walk(child, new Set([...ancestors, id]));
      } else if (info.isFile()) {
        files.push(child);
      }
    }
  };

  const rootInfo = await stat(root);
  await walk('', new Set([`${rootInfo.dev}:${rootInfo.ino}`]));
  return files;
}
