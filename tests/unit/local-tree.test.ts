/**
 * Обход локального дерева перед загрузкой
 *
 * Дерево должно считаться так же, как его видит транспорт: `scp -r`
 * разыменовывает ссылки, а на битой ссылке и на цикле останавливается.
 * Пока обход видел дерево иначе, ответ инструмента врал — `files_uploaded`
 * и `bytes` не считали разыменованные копии, а `verify` их не проверял.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listTreeFiles } from '../../src/utils/local-tree.js';

describe('listTreeFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tree-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('возвращает файлы дерева относительными путями', async () => {
    await mkdir(join(root, 'nested/deep'), { recursive: true });
    await writeFile(join(root, 'top.txt'), 'a');
    await writeFile(join(root, 'nested/deep/inner.txt'), 'b');

    expect((await listTreeFiles(root)).sort()).toEqual(['nested/deep/inner.txt', 'top.txt']);
  });

  it('ссылка на файл считается файлом — транспорт привезёт копию', async () => {
    await writeFile(join(root, 'file.txt'), 'a');
    await symlink('file.txt', join(root, 'link'));

    expect((await listTreeFiles(root)).sort()).toEqual(['file.txt', 'link']);
  });

  it('в ссылку на каталог заходим — её содержимое тоже уедет', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir/inside.txt'), 'a');
    await symlink('dir', join(root, 'link-to-dir'));

    expect((await listTreeFiles(root)).sort()).toEqual([
      'dir/inside.txt',
      'link-to-dir/inside.txt',
    ]);
  });

  it('битая ссылка — отказ с указанием пути', async () => {
    await writeFile(join(root, 'file.txt'), 'a');
    await symlink('nowhere.txt', join(root, 'broken'));

    await expect(listTreeFiles(root)).rejects.toThrow(/broken/);
  });

  it('битая ссылка в глубине дерева тоже отказ', async () => {
    await mkdir(join(root, 'nested'));
    await symlink('nowhere.txt', join(root, 'nested/broken'));

    await expect(listTreeFiles(root)).rejects.toThrow(/nested\/broken/);
  });

  it('цикл из двух ссылок — отказ', async () => {
    await symlink('loop-b', join(root, 'loop-a'));
    await symlink('loop-a', join(root, 'loop-b'));

    await expect(listTreeFiles(root)).rejects.toThrow(/loop-a|loop-b/);
  });

  it('ссылка на каталог-предок — отказ про цикл, а не бесконечный обход', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir/inside.txt'), 'a');
    await symlink('..', join(root, 'dir/up'));

    await expect(listTreeFiles(root)).rejects.toThrow(/loop/i);
  });

  it('пустой каталог даёт пустой список, а не ошибку', async () => {
    await mkdir(join(root, 'empty'));

    expect(await listTreeFiles(root)).toEqual([]);
  });
});
