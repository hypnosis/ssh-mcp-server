/**
 * Unit tests: установка на локальной стороне
 *
 * Проверяется на настоящей файловой системе — ради этого модуль и нужен:
 * оборванное скачивание не должно оставлять от файла пользователя огрызок.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { install } = await import('../../src/managers/installer.js');
const { localPathOps } = await import('../../src/managers/local-path-ops.js');

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-install-'));
  target = join(dir, 'report.txt');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('скачивание в занятый путь', () => {
  it('прежний файл цел, пока новый не доехал целиком', async () => {
    writeFileSync(target, 'старый отчёт', 'utf8');
    const seen: string[] = [];

    await install(localPathOps, {
      finalPath: target,
      kind: 'file',
      stage: async (staging) => {
        writeFileSync(staging, 'новый отчёт', 'utf8');
        seen.push(readFileSync(target, 'utf8'));
      },
    });

    expect(seen).toEqual(['старый отчёт']);
    expect(readFileSync(target, 'utf8')).toBe('новый отчёт');
  });

  it('обрыв посреди скачивания оставляет прежний файл нетронутым', async () => {
    writeFileSync(target, 'старый отчёт', 'utf8');

    await expect(
      install(localPathOps, {
        finalPath: target,
        kind: 'file',
        stage: async (staging) => {
          writeFileSync(staging, 'полов', 'utf8'); // доехала только часть
          throw new Error('connection reset');
        },
      })
    ).rejects.toThrow(/connection reset/);

    expect(readFileSync(target, 'utf8')).toBe('старый отчёт');
  });

  it('после сбоя рядом не остаётся мусора', async () => {
    writeFileSync(target, 'старый отчёт', 'utf8');

    await install(localPathOps, {
      finalPath: target,
      kind: 'file',
      stage: async (staging) => {
        writeFileSync(staging, 'кусок', 'utf8');
        throw new Error('connection reset');
      },
    }).catch(() => undefined);

    expect(readdirSync(dir)).toEqual(['report.txt']);
  });
});

describe('замена каталога', () => {
  it('целый каталог встаёт на место прежнего, старый убирается', async () => {
    const finalDir = join(dir, 'site');
    mkdirSync(finalDir);
    writeFileSync(join(finalDir, 'old.txt'), 'старое', 'utf8');

    await install(localPathOps, {
      finalPath: finalDir,
      kind: 'directory',
      stage: async (staging) => {
        mkdirSync(staging);
        writeFileSync(join(staging, 'new.txt'), 'новое', 'utf8');
      },
    });

    expect(readdirSync(finalDir)).toEqual(['new.txt']);
    // Никаких временных и отложенных копий рядом
    expect(readdirSync(dir)).toEqual(['site']);
  });

  it('сбой проверки оставляет прежний каталог со всем содержимым', async () => {
    const finalDir = join(dir, 'site');
    mkdirSync(finalDir);
    writeFileSync(join(finalDir, 'old.txt'), 'старое', 'utf8');

    await expect(
      install(localPathOps, {
        finalPath: finalDir,
        kind: 'directory',
        stage: async (staging) => {
          mkdirSync(staging);
          writeFileSync(join(staging, 'new.txt'), 'новое', 'utf8');
        },
        verify: async () => 'sha256 mismatch',
      })
    ).rejects.toThrow(/sha256 mismatch/);

    expect(readdirSync(finalDir)).toEqual(['old.txt']);
    expect(readFileSync(join(finalDir, 'old.txt'), 'utf8')).toBe('старое');
    expect(readdirSync(dir)).toEqual(['site']);
  });
});

describe('тип цели', () => {
  it('каталог на месте файла — отказ, а не вложение', async () => {
    const finalDir = join(dir, 'thing');
    mkdirSync(finalDir);
    writeFileSync(join(finalDir, 'inside.txt'), 'внутри', 'utf8');

    await expect(
      install(localPathOps, {
        finalPath: finalDir,
        kind: 'file',
        stage: async (staging) => writeFileSync(staging, 'файл', 'utf8'),
      })
    ).rejects.toThrow(/directory/i);

    expect(readdirSync(finalDir)).toEqual(['inside.txt']);
  });

  it('симлинк на месте цели — отказ: ни ссылка, ни файл на другом конце не тронуты', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'чужие данные', 'utf8');
    const link = join(dir, 'link.txt');
    symlinkSync(outside, link);

    await expect(
      install(localPathOps, {
        finalPath: link,
        kind: 'file',
        stage: async (staging) => writeFileSync(staging, 'наши данные', 'utf8'),
      })
    ).rejects.toThrow(/symbolic link/i);

    expect(readFileSync(outside, 'utf8')).toBe('чужие данные');
    expect(readFileSync(link, 'utf8')).toBe('чужие данные');
    expect(existsSync(link)).toBe(true);
  });

  it('битая ссылка тоже отказ, а не «путь свободен»', async () => {
    const link = join(dir, 'dangling.txt');
    symlinkSync(join(dir, 'nowhere.txt'), link);

    await expect(
      install(localPathOps, {
        finalPath: link,
        kind: 'file',
        stage: async (staging) => writeFileSync(staging, 'наши данные', 'utf8'),
      })
    ).rejects.toThrow(/symbolic link/i);
  });
});
