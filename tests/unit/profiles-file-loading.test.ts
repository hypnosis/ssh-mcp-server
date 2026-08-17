/**
 * Чтение файла профилей: путь к файлу, разбор JSON, отсев непригодных записей.
 *
 * Файл профилей мы принимаем на веру больше всего — из него берутся адрес,
 * пользователь, ключ и правила путей. Проверка формы полей живёт в
 * `profiles-transport-options.test.ts`, здесь — сам путь к файлу и то, что
 * происходит с записями, которые до полей не доходят.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProfilesFile } from '../../src/utils/profiles-file.js';
import { forgetLoggedSecrets, logger } from '../../src/utils/logger.js';
import { STRICT_HOST_KEY_CHECKING_VALUES } from '../../src/utils/ssh-config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-'));
  tempDirs.push(dir);
  return dir;
}

/** Записать файл профилей и вернуть путь к нему */
function writeProfiles(content: unknown, fileName = 'profiles.json'): string {
  const path = join(tempDir(), fileName);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

const VALID = { host: 'example.com', username: 'deploy' };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  forgetLoggedSecrets();
});

describe('путь к файлу профилей', () => {
  it('тильда раскрывается в домашний каталог', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ profiles: { prod: VALID } }), 'utf8');

    const savedHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const result = loadProfilesFile('~/profiles.json');

      expect(result.errors).toEqual([]);
      expect(Object.keys(result.config!.profiles)).toEqual(['prod']);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it('несуществующий файл назван по разрешённому пути, а не по исходному', () => {
    const missing = join(tempDir(), 'nowhere.json');

    const result = loadProfilesFile(missing);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain(missing);
  });
});

describe('разбор файла: причина отказа называется своим именем', () => {
  it('сломанный JSON назван сломанным JSON', () => {
    const path = writeProfiles('{ "profiles": { "prod": ');

    const result = loadProfilesFile(path);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain('Invalid JSON in SSH profiles file');
  });

  it('нечитаемый файл отвечает другим текстом, а не про JSON', () => {
    // Каталог вместо файла: существует, а прочитать нечего
    const dir = tempDir();

    const result = loadProfilesFile(dir);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain('Failed to load SSH profiles file');
    expect(result.errors[0]).not.toContain('Invalid JSON');
  });

  it('JSON не про объект отклоняется целиком', () => {
    const path = writeProfiles('"just a string"');

    const result = loadProfilesFile(path);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain('must contain a JSON object');
  });

  it('список верхнего уровня отклоняется по отсутствию раздела profiles', () => {
    // Массив проходит проверку на объект и до своей ветки не доходит:
    // отказ тот же, а причина в тексте названа следующая
    const path = writeProfiles('[]');

    const result = loadProfilesFile(path);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain('must have a "profiles" object');
  });

  it('объект без раздела profiles отклоняется целиком', () => {
    const path = writeProfiles({ default: 'prod' });

    const result = loadProfilesFile(path);

    expect(result.config).toBeNull();
    expect(result.errors[0]).toContain('must have a "profiles" object');
  });
});

describe('записи, непригодные для SSH, отсеиваются без ошибки', () => {
  it('профиль локального режима не становится SSH-профилем, даже если поля на месте', () => {
    // У записи есть и адрес, и пользователь: отсеивает её именно режим
    const path = writeProfiles({
      profiles: { docker: { ...VALID, mode: 'local' }, prod: VALID },
    });

    const result = loadProfilesFile(path);

    expect(Object.keys(result.config!.profiles)).toEqual(['prod']);
    expect(result.errors).toEqual([]);
  });

  it('запись без адреса пропускается', () => {
    const path = writeProfiles({ profiles: { nohost: { username: 'deploy' }, prod: VALID } });

    expect(Object.keys(loadProfilesFile(path).config!.profiles)).toEqual(['prod']);
  });

  it('запись без пользователя пропускается', () => {
    const path = writeProfiles({ profiles: { nouser: { host: 'example.com' }, prod: VALID } });

    expect(Object.keys(loadProfilesFile(path).config!.profiles)).toEqual(['prod']);
  });
});

describe('загрузчик никого не выбирает за вызывающего', () => {
  it('в конфигурации нет профиля по умолчанию', () => {
    const path = writeProfiles({ profiles: { first: VALID, second: VALID } });

    const config = loadProfilesFile(path).config! as unknown as Record<string, unknown>;

    expect(config.default).toBeUndefined();
  });

  it('поле default в файле остаётся чужим полем и загрузку не меняет', () => {
    const path = writeProfiles({ default: 'second', profiles: { first: VALID, second: VALID } });

    const result = loadProfilesFile(path);

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config!.profiles)).toEqual(['first', 'second']);
    expect((result.config! as unknown as Record<string, unknown>).default).toBeUndefined();
  });
});

describe('правила путей: пустое место в списке — не правило', () => {
  it.each([
    ['пустая строка', ''],
    ['одни пробелы', '   '],
  ])('%s в белом списке отклоняет профиль', (_name, rule) => {
    const path = writeProfiles({
      profiles: { prod: { ...VALID, pathSecurity: { allowedPaths: ['/var/log', rule] } } },
    });

    const result = loadProfilesFile(path);

    expect(result.broken[0]?.field).toBe('pathSecurity.allowedPaths');
    // Причина названа своя: пустое место отсеивается как пустое, а не как
    // относительный путь — иначе читатель пойдёт дописывать ведущий слэш
    expect(result.broken[0]?.reason).toContain('non-empty');
    expect(result.config).toBeNull();
  });

  it('пустая строка в чёрном списке отклоняет профиль', () => {
    const path = writeProfiles({
      profiles: { prod: { ...VALID, pathSecurity: { deniedPaths: [''] } } },
    });

    const result = loadProfilesFile(path);

    expect(result.broken[0]?.field).toBe('pathSecurity.deniedPaths');
    expect(result.broken[0]?.reason).toContain('non-empty');
  });
});

describe('политика проверки ключа хоста принимает все три значения', () => {
  it.each(STRICT_HOST_KEY_CHECKING_VALUES)('"%s" грузится из файла', (policy) => {
    const path = writeProfiles({
      profiles: { prod: { ...VALID, strictHostKeyChecking: policy } },
    });

    const result = loadProfilesFile(path);

    expect(result.errors).toEqual([]);
    expect(result.config!.profiles.prod.strictHostKeyChecking).toBe(policy);
  });

  it('список допустимых значений именно из трёх', () => {
    expect(STRICT_HOST_KEY_CHECKING_VALUES).toEqual(['yes', 'accept-new', 'no']);
  });
});

describe('секреты прячутся от лога до разбора полей', () => {
  let written: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    forgetLoggedSecrets();
    written = [];
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it.each([
    ['пароль', 'password', 'Kf8#mQ2vLp'],
    ['ключевая фраза', 'passphrase', 'Zx4$nR7wTq'],
  ])('%s отсеянного профиля всё равно маскируется', (_name, field, secret) => {
    // Профиль непригоден для SSH и до полей разбора не доходит, но секрет в нём
    // настоящий: в лог ему нельзя ни при каком исходе разбора
    const path = writeProfiles({
      profiles: { docker: { mode: 'local', [field]: secret }, prod: VALID },
    });

    loadProfilesFile(path);
    logger.error(`later someone logs it: ${secret}`);

    expect(written.join('\n')).not.toContain(secret);
    expect(written.join('\n')).toContain('***');
  });
});
