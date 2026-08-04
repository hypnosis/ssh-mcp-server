/**
 * Unit tests: единая точка установки на место
 *
 * Инвариант, ради которого весь модуль:
 *
 *   Целая копия существует в каждый момент времени. Ничего не удаляется,
 *   пока замена не удалась. Обработчик ошибки никогда не трогает последнюю
 *   оставшуюся копию.
 *
 * Тесты написаны в терминах наблюдаемого состояния файловой системы: после
 * любого сбоя на любой фазе на боевом пути обязано лежать целое — старое или
 * новое, но не половина и не пустота.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PathKind, PathOps } from '../../src/managers/installer.js';
import { logger } from '../../src/utils/logger.js';

const { install, InstallError } = await import('../../src/managers/installer.js');

/**
 * Файловая система в памяти: путь → содержимое.
 * Каталог представлен записью с типом directory, файл — строкой.
 */
class FakeFs implements PathOps {
  entries = new Map<string, { kind: PathKind; content: string }>();
  removed: string[] = [];
  failRename?: (from: string, to: string) => boolean;
  failRemove?: (path: string) => boolean;
  /** Путь, который лежит на отдельной файловой системе (точка монтирования) */
  separateFilesystem?: string;

  put(path: string, kind: PathKind, content = ''): void {
    this.entries.set(path, { kind, content });
  }

  content(path: string): string | undefined {
    return this.entries.get(path)?.content;
  }

  async inspect(path: string): Promise<PathKind> {
    return this.entries.get(path)?.kind ?? 'missing';
  }

  async ensureParent(): Promise<void> {}

  async isSeparateFilesystem(path: string): Promise<boolean> {
    return this.separateFilesystem === path;
  }

  /** Ведёт себя как `mv -T`: в занятую цель ничего не вкладывает */
  async rename(from: string, to: string): Promise<void> {
    if (this.failRename?.(from, to)) throw new Error(`rename refused: ${from} -> ${to}`);
    const entry = this.entries.get(from);
    if (!entry) throw new Error(`no such path: ${from}`);
    const target = this.entries.get(to);
    if (target?.kind === 'directory') throw new Error(`cannot overwrite directory: ${to}`);
    this.entries.delete(from);
    this.entries.set(to, entry);
  }

  async removeTree(path: string): Promise<void> {
    if (this.failRemove?.(path)) throw new Error(`remove refused: ${path}`);
    this.removed.push(path);
    this.entries.delete(path);
  }

  /** Соседи цели, похожие на наши временные имена */
  listSiblings?: (directory: string) => Promise<string[]>;

  async listArtifacts(directory: string): Promise<string[]> {
    if (!this.listSiblings) return [];
    return this.listSiblings(directory);
  }
}

const FINAL = '/srv/app.conf';

let fs: FakeFs;

beforeEach(() => {
  fs = new FakeFs();
});

/** План установки файла: заполнение кладёт содержимое в staging */
function plan(overrides: Partial<Parameters<typeof install>[1]> = {}) {
  return {
    finalPath: FINAL,
    kind: 'file' as PathKind,
    stage: async (staging: string) => fs.put(staging, 'file', 'новое содержимое'),
    ...overrides,
  };
}

describe('установка проходит', () => {
  it('на пустое место: staging переименовывается в цель, ничего не удаляется', async () => {
    const outcome = await install(fs, plan());

    expect(outcome.path).toBe(FINAL);
    expect(fs.content(FINAL)).toBe('новое содержимое');
    expect(fs.removed).toEqual([]);
  });

  it('поверх файла: старое содержимое заменяется новым', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');

    await install(fs, plan());

    expect(fs.content(FINAL)).toBe('новое содержимое');
  });

  it('данные попадают на боевой путь только после проверки', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');
    const seenDuringVerify: Array<string | undefined> = [];

    await install(
      fs,
      plan({
        verify: async () => {
          seenDuringVerify.push(fs.content(FINAL));
          return null;
        },
      })
    );

    // Пока идёт проверка, на боевом пути всё ещё старая целая копия
    expect(seenDuringVerify).toEqual(['старое содержимое']);
  });
});

describe('сбой до замены: последняя копия не тронута', () => {
  it('передача сорвалась — staging убран, цель на месте', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');

    await expect(
      install(fs, plan({ stage: async () => { throw new Error('connection reset'); } }))
    ).rejects.toThrow(/connection reset/);

    expect(fs.content(FINAL)).toBe('старое содержимое');
    expect(fs.removed.every((path) => path !== FINAL)).toBe(true);
  });

  it('проверка не сошлась — цель на месте, в ошибке причина', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');

    await expect(
      install(fs, plan({ verify: async () => 'sha256 mismatch' }))
    ).rejects.toThrow(/sha256 mismatch/);

    expect(fs.content(FINAL)).toBe('старое содержимое');
  });

  it('уборка после сбоя касается только staging', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');

    await install(fs, plan({ verify: async () => 'sha256 mismatch' })).catch(() => undefined);

    expect(fs.removed).toHaveLength(1);
    expect(fs.removed[0]).toMatch(/\.upload-/);
  });

  it('неудачная уборка оставляет след в журнале, а не исчезает', async () => {
    // Иначе путь, объявленный убранным, молча остаётся на сервере
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fs.put(FINAL, 'file', 'старое содержимое');
    fs.failRemove = (path) => path.includes('.upload-');

    await install(fs, plan({ verify: async () => 'sha256 mismatch' })).catch(() => undefined);

    expect(warn.mock.calls.map(String).join('\n')).toMatch(/\.upload-/);
    warn.mockRestore();
  });

  it('несостоявшаяся замена — цель остаётся прежней', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');
    fs.failRename = (_from, to) => to === FINAL;

    await expect(install(fs, plan())).rejects.toThrow(/rename refused/);

    expect(fs.content(FINAL)).toBe('старое содержимое');
  });
});

describe('тип цели не совпадает — отказ вместо тихой вложенности', () => {
  it('на месте файла каталог: установка отказывает и ничего не трогает', async () => {
    fs.put(FINAL, 'directory', 'каталог целиком');

    await expect(install(fs, plan())).rejects.toThrow(/directory/i);

    expect(fs.content(FINAL)).toBe('каталог целиком');
    expect(fs.removed).toEqual([]);
  });
});

describe('после замены ошибки становятся предупреждением', () => {
  it('старую копию не удалось убрать — операция состоялась, в ответе её адрес', async () => {
    fs.put(FINAL, 'directory', 'старое дерево');
    const failingRemove = new FakeFs();
    Object.assign(failingRemove, fs);
    failingRemove.removeTree = async (path: string) => {
      if (path.includes('.bak-')) throw new Error('rm: Device or resource busy');
      failingRemove.entries.delete(path);
    };

    const outcome = await install(failingRemove, plan({ kind: 'directory' }));

    expect(failingRemove.content(FINAL)).toBe('новое содержимое');
    expect(outcome.warnings.join(' ')).toMatch(/\.bak-.*resource busy/);
  });
});

describe('откат не удался — человек обязан узнать, где лежат его данные', () => {
  it('пути обеих оставшихся копий приходят вместе с ошибкой', async () => {
    fs.put(FINAL, 'directory', 'старое дерево');
    // Замена не удалась, и вернуть старое на место тоже не вышло
    fs.failRename = (from, to) => to === FINAL && from.includes('.upload-')
      || (from.includes('.bak-') && to === FINAL);

    const error = await install(fs, plan({ kind: 'directory' })).catch((e) => e);

    expect(error).toBeInstanceOf(InstallError);
    expect(error.message).toMatch(/\.bak-/);
    expect(error.warnings.join(' ')).toMatch(/must be moved back manually/);
  });

  it('последняя копия остаётся на диске, обработчик её не трогает', async () => {
    fs.put(FINAL, 'directory', 'старое дерево');
    fs.failRename = (from, to) => to === FINAL;

    await install(fs, plan({ kind: 'directory' })).catch(() => undefined);

    const backup = [...fs.entries.keys()].find((path) => path.includes('.bak-'));
    expect(backup).toBeDefined();
    expect(fs.content(backup!)).toBe('старое дерево');
    expect(fs.removed).not.toContain(backup);
  });
});

describe('права применяются до замены', () => {
  it('неудача прав не оставляет боевой путь заменённым', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');

    await expect(
      install(
        fs,
        plan({
          finalize: async () => {
            throw new Error('chmod: operation not permitted');
          },
        })
      )
    ).rejects.toThrow(/operation not permitted/);

    // Замена не состоялась вовсе — на месте прежний целый файл
    expect(fs.content(FINAL)).toBe('старое содержимое');
  });

  it('права ставятся на временный путь, а не на боевой', async () => {
    const finalized: string[] = [];

    await install(fs, plan({ finalize: async (path: string) => { finalized.push(path); } }));

    expect(finalized[0]).toMatch(/\.upload-/);
  });
});

describe('опасная цель — отказ до любых изменений', () => {
  it('на месте цели символическая ссылка', async () => {
    fs.put(FINAL, 'symlink', 'ссылка наружу');

    await expect(install(fs, plan())).rejects.toThrow(/symbolic link/i);

    expect(fs.content(FINAL)).toBe('ссылка наружу');
    expect(fs.removed).toEqual([]);
  });

  it('цель — точка монтирования: заменить переименованием нельзя', async () => {
    fs.put(FINAL, 'directory', 'том целиком');
    fs.separateFilesystem = FINAL;

    await expect(install(fs, plan({ kind: 'directory' }))).rejects.toThrow(/mount/i);

    expect(fs.content(FINAL)).toBe('том целиком');
    expect(fs.removed).toEqual([]);
  });
});

describe('имена временных путей', () => {
  it('staging лежит рядом с целью — переименование не уедет между дисками', async () => {
    const staged: string[] = [];

    await install(fs, plan({ stage: async (staging: string) => {
      staged.push(staging);
      fs.put(staging, 'file', 'новое содержимое');
    } }));

    expect(staged[0]).toMatch(/^\/srv\/\.upload-[0-9a-f]+\.app\.conf$/);
  });

  it('два вызова подряд берут разные временные имена', async () => {
    const staged: string[] = [];
    const capture = plan({ stage: async (staging: string) => {
      staged.push(staging);
      fs.put(staging, 'file', 'новое содержимое');
    } });

    await install(fs, capture);
    await install(fs, capture);

    expect(staged[0]).not.toBe(staged[1]);
  });
});

/**
 * Следы прерванных операций: называем, но не трогаем.
 *
 * Процесс, убитый посреди установки, оставляет рядом с целью временный путь, а
 * иногда и отведённую в сторону старую копию. Убрать их некому: своё убирает
 * тот вызов, который создал, а чужое не трогает никто — угадать, доливает ли
 * их прямо сейчас соседний вызов, нельзя ни по имени, ни по времени.
 */
describe('следы прошлых операций', () => {
  it('называются в ответе и остаются на месте', async () => {
    fs.put(FINAL, 'file', 'старое содержимое');
    fs.put('/srv/.bak-aaaaaaaaaaaa.app.conf', 'file', 'копия от прошлой аварии');
    fs.listSiblings = async () => ['/srv/.bak-aaaaaaaaaaaa.app.conf'];

    const outcome = await install(fs, plan());

    expect(outcome.warnings.join(' ')).toContain('/srv/.bak-aaaaaaaaaaaa.app.conf');
    // Ни удаления, ни переименования: это чужие данные
    expect(fs.removed).toEqual([]);
    expect(fs.content('/srv/.bak-aaaaaaaaaaaa.app.conf')).toBe('копия от прошлой аварии');
  });

  it('пустой боевой путь рядом с копией — предупреждение с командой возврата', async () => {
    fs.put('/srv/.bak-bbbbbbbbbbbb.app.conf', 'file', 'единственная целая копия');
    fs.listSiblings = async () => ['/srv/.bak-bbbbbbbbbbbb.app.conf'];

    const outcome = await install(fs, plan());

    const warning = outcome.warnings.join(' ');
    expect(warning).toContain('/srv/.bak-bbbbbbbbbbbb.app.conf');
    expect(warning).toContain('mv -T');
    expect(fs.content('/srv/.bak-bbbbbbbbbbbb.app.conf')).toBe('единственная целая копия');
  });

  it('соседи от другой цели и чужие файлы не считаются нашими следами', async () => {
    fs.listSiblings = async () => [
      '/srv/.bak-cccccccccccc.other.conf',
      '/srv/.upload-dddddddddddd.other.conf',
      '/srv/app.conf.bak',
      '/srv/.hidden',
    ];

    const outcome = await install(fs, plan());

    expect(outcome.warnings).toEqual([]);
  });

  it('неудачный листинг не мешает установке', async () => {
    fs.listSiblings = async () => { throw new Error('permission denied'); };

    const outcome = await install(fs, plan());

    expect(fs.content(FINAL)).toBe('новое содержимое');
    expect(outcome.warnings).toEqual([]);
  });

  it('отказ установки тоже несёт список следов', async () => {
    fs.put(FINAL, 'directory');
    fs.listSiblings = async () => ['/srv/.upload-eeeeeeeeeeee.app.conf'];

    const failure = await install(fs, plan()).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(InstallError);
    expect((failure as InstanceType<typeof InstallError>).warnings.join(' ')).toContain(
      '/srv/.upload-eeeeeeeeeeee.app.conf'
    );
  });
});
