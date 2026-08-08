/**
 * Испорченный профиль в общем файле.
 *
 * Три требования разом: отказ называет профиль, поле и значение; ничего не
 * подставляется вместо испорченного; соседние профили продолжают работать.
 * Поэтому путь проверяется целиком — файл, загрузчик, резолвер и та
 * конфигурация, которую видит инструмент.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProfilesFile } from '../../src/utils/profiles-file.js';
import { reloadProfiles, resolveSSHConfig, getDefaultProfile } from '../../src/utils/profile-resolver.js';

const tempDirs: string[] = [];
let previousProfilesFile: string | undefined;

/** Положить файл профилей на диск и вернуть путь к нему */
function writeProfiles(content: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-broken-'));
  tempDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

/** Сделать файл действующим для резолвера */
function activate(content: Record<string, unknown>): string {
  const path = writeProfiles(content);
  process.env.SSH_PROFILES_FILE = path;
  reloadProfiles();
  return path;
}

/** Файл с испорченным `production` и исправным `staging` */
function fileWith(broken: Record<string, unknown>, defaultProfile = 'production'): Record<string, unknown> {
  return {
    default: defaultProfile,
    profiles: {
      production: { host: 'example.com', username: 'deploy', ...broken },
      staging: { host: 'staging.example.com', username: 'deploy' },
    },
  };
}

beforeEach(() => {
  previousProfilesFile = process.env.SSH_PROFILES_FILE;
});

afterEach(() => {
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;
  try {
    reloadProfiles();
  } catch {
    /* без файла профилей перезагрузка законно отказывается */
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Испорченное поле, след поля в отказе и след значения */
const BROKEN_FIELDS: Array<[string, Record<string, unknown>, RegExp, RegExp]> = [
  ['порт', { port: 70000 }, /port/, /70000/],
  ['политика проверки ключа хоста', { strictHostKeyChecking: 'Yes' }, /strictHostKeyChecking/, /Yes/],
  ['ограничения на пути', { pathSecurity: { deniedPaths: '/root' } }, /pathSecurity/, /\/root/],
];

describe('загрузчик: испорченный профиль назван полем и значением', () => {
  it.each(BROKEN_FIELDS)('ошибка называет профиль, поле и значение (%s)', (_name, broken, field, value) => {
    const { errors, broken: rejected } = loadProfilesFile(writeProfiles(fileWith(broken)));

    expect(errors.join(' ')).toMatch(/production/);
    expect(errors.join(' ')).toMatch(field);
    expect(errors.join(' ')).toMatch(value);

    expect(rejected).toHaveLength(1);
    expect(rejected[0].name).toBe('production');
    expect(rejected[0].field).toMatch(field);
    expect(rejected[0].value).toMatch(value);
    expect(rejected[0].reason).toBeTruthy();
  });

  it('запись, которая вовсе не объект, тоже названа испорченной', () => {
    const path = writeProfiles({
      default: 'staging',
      profiles: { production: 42, staging: { host: 'staging.example.com', username: 'deploy' } },
    });

    const { errors, broken } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(/production/);
    expect(broken.map((entry) => entry.name)).toEqual(['production']);
  });

  it('пропущенный не-SSH профиль ошибкой не считается', () => {
    const path = writeProfiles({
      default: 'staging',
      profiles: {
        docker: { mode: 'local' },
        noHost: { username: 'deploy' },
        noUser: { host: 'example.com' },
        staging: { host: 'staging.example.com', username: 'deploy' },
      },
    });

    const { errors, broken } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(broken).toEqual([]);
  });
});

describe('резолвер: исправный сосед переживает испорченный', () => {
  it.each(BROKEN_FIELDS)('исправный профиль работает, когда испорчен default (%s)', (_name, broken) => {
    activate(fileWith(broken, 'production'));

    expect(resolveSSHConfig({ profile: 'staging' }).host).toBe('staging.example.com');
  });

  it.each(BROKEN_FIELDS)('исправный профиль работает, когда испорчен не default (%s)', (_name, broken) => {
    activate({
      default: 'staging',
      profiles: {
        production: { host: 'example.com', username: 'deploy', ...broken },
        staging: { host: 'staging.example.com', username: 'deploy' },
      },
    });

    expect(resolveSSHConfig({ profile: 'staging' }).host).toBe('staging.example.com');
    expect(resolveSSHConfig({}).host).toBe('staging.example.com');
  });
});

describe('резолвер: обращение к испорченному профилю называет причину', () => {
  it.each(BROKEN_FIELDS)('отказ по имени называет поле и значение (%s)', (_name, broken, field, value) => {
    activate(fileWith(broken, 'staging'));

    let message = '';
    try {
      resolveSSHConfig({ profile: 'production' });
      throw new Error('обращение к испорченному профилю не должно проходить');
    } catch (error: any) {
      message = error.message;
    }

    expect(message).toMatch(/production/);
    expect(message).toMatch(field);
    expect(message).toMatch(value);
    // «не найден» — неправда: профиль в файле есть, он испорчен
    expect(message).not.toMatch(/not found/i);
  });
});

describe('резолвер: default не переезжает с испорченного профиля', () => {
  it.each(BROKEN_FIELDS)('обращение без профиля отказывает, а не уходит к соседу (%s)', (_name, broken, field) => {
    activate(fileWith(broken, 'production'));

    let message = '';
    try {
      const config = resolveSSHConfig({});
      throw new Error(`подставлен другой сервер: ${config.host}`);
    } catch (error: any) {
      message = error.message;
    }

    expect(message).toMatch(/production/);
    expect(message).toMatch(field);
    expect(message).not.toMatch(/staging\.example\.com/);
  });

  it('имя default остаётся прежним, а не подменяется соседом', () => {
    activate(fileWith({ port: 70000 }, 'production'));

    expect(getDefaultProfile()).toBe('production');
  });
});

describe('пропущенный профиль и испорченный ведут себя по-разному', () => {
  it('default на не-SSH профиле переезжает к исправному', () => {
    activate({
      default: 'docker',
      profiles: {
        docker: { mode: 'local' },
        production: { host: 'example.com', username: 'deploy' },
      },
    });

    expect(resolveSSHConfig({}).host).toBe('example.com');
  });

  it('default на испорченном профиле не переезжает', () => {
    activate({
      default: 'production',
      profiles: {
        production: { host: 'example.com', username: 'deploy', port: 70000 },
        staging: { host: 'staging.example.com', username: 'deploy' },
      },
    });

    expect(() => resolveSSHConfig({})).toThrow(/production/);
  });

  it('пропущенный профиль по имени остаётся ненайденным', () => {
    activate({
      default: 'production',
      profiles: {
        docker: { mode: 'local' },
        production: { host: 'example.com', username: 'deploy' },
      },
    });

    expect(() => resolveSSHConfig({ profile: 'docker' })).toThrow(/not found/i);
  });
});

describe('каждая испорченная запись попадает в лог отдельной строкой', () => {
  it('две порчи — две строки, каждая со своим профилем', () => {
    const written: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });

    try {
      activate({
        default: 'staging',
        profiles: {
          production: { host: 'example.com', username: 'deploy', port: 70000 },
          canary: { host: 'canary.example.com', username: 'deploy', strictHostKeyChecking: 'Yes' },
          staging: { host: 'staging.example.com', username: 'deploy' },
        },
      });
    } finally {
      spy.mockRestore();
    }

    const complaints = written.filter((line) => line.includes('Error in SSH profiles file'));
    expect(complaints).toHaveLength(2);
    expect(complaints.filter((line) => line.includes('production'))).toHaveLength(1);
    expect(complaints.filter((line) => line.includes('canary'))).toHaveLength(1);
  });
});

describe('файл без единого исправного профиля отказывает целиком', () => {
  it('загрузка падает и называет причину', () => {
    const path = writeProfiles({
      default: 'production',
      profiles: { production: { host: 'example.com', username: 'deploy', port: 70000 } },
    });
    process.env.SSH_PROFILES_FILE = path;

    expect(() => reloadProfiles()).toThrow(/port/);
  });
});
