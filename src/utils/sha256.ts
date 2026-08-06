/**
 * SHA256 helpers
 * Local hashing via Node crypto + remote hashing via shell with fallback
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/**
 * Compute sha256 of a local file (streaming, no full load to memory)
 */
export async function sha256OfFile(localPath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(localPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Сколько файлов дерева читаем одновременно.
 *
 * Раньше хэши считались через `Promise.all` по всему списку — открывались
 * разом все файлы дерева. На тысяче файлов это упирается в лимит дескрипторов
 * процесса (замерено: при `nofile=1024` дерево из 1100 файлов даёт EMFILE), и
 * страдает не только сверка: без свободного дескриптора процесс не может
 * открыть ни сокет, ни файл. Шестнадцать ничего не стоят по скорости: замер на
 * дереве в 2000 файлов дал 31 мс против 51 у сплошного `Promise.all`, а сверх
 * фона процесс держит ровно шестнадцать дескрипторов при любом размере дерева.
 */
const HASH_CONCURRENCY = 16;

/**
 * Посчитать sha256 списка файлов, читая не больше шестнадцати разом.
 * Порядок результатов совпадает с порядком путей.
 *
 * Первый же нечитаемый файл останавливает работу: причина уходит наверх, а
 * остальные читатели не дочитывают дерево, от которого вызывающий уже отказался
 * (при скачивании они читали бы staging, который вот-вот удалят).
 */
export async function sha256OfFiles(localPaths: string[]): Promise<string[]> {
  const hashes = new Array<string>(localPaths.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (next < localPaths.length && !failed) {
      const index = next++;
      try {
        hashes[index] = await sha256OfFile(localPaths[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const readers = Math.min(HASH_CONCURRENCY, localPaths.length);
  await Promise.all(Array.from({ length: readers }, worker));
  return hashes;
}

/**
 * Compute sha256 of a Buffer
 */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
