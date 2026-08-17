/**
 * Кэш профилей: когда файл перечитывается, а когда ответ идёт из памяти.
 *
 * Срок жизни кэша и слежение за файлом читаются из окружения один раз, при
 * загрузке модуля, поэтому каждый набор переменных требует своего экземпляра.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

/** Подменный домашний каталог: пустая строка означает настоящий */
const fakeHome = vi.hoisted(() => ({ path: '' }));

/** Пути, за которыми резолвер попросил следить */
const watched = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome.path || actual.homedir() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: (path: string) => {
      watched.paths.push(path);
      return { close: () => {}, on: () => {} };
    },
  };
});

const ENV_VARS = [
  'SSH_PROFILES_FILE',
  'SSH_MCP_PROFILES_CACHE_TTL',
  'SSH_MCP_PROFILES_WATCH',
] as const;

const tempDirs: string[] = [];

function writeProfiles(host: string, fileName = 'profiles.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-cache-'));
  tempDirs.push(dir);
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify({ profiles: { prod: { host, username: 'deploy' } } }), 'utf8');
  return path;
}

/** Переписать существующий файл профилей другим адресом */
function rewrite(path: string, host: string): void {
  writeFileSync(path, JSON.stringify({ profiles: { prod: { host, username: 'deploy' } } }), 'utf8');
}

/**
 * Резолвер с заданным окружением. Слежение за файлом выключено: наблюдатель
 * держит цикл событий открытым и переживает конец теста.
 */
async function freshResolver(env: Partial<Record<(typeof ENV_VARS)[number], string>>) {
  for (const name of ENV_VARS) delete process.env[name];
  process.env.SSH_MCP_PROFILES_WATCH = 'false';
  Object.assign(process.env, env);

  vi.resetModules();
  return import('../../src/utils/profile-resolver.js');
}

describe('кэш профилей', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('в пределах срока ответ идёт из памяти, а не с диска', async () => {
    const path = writeProfiles('first.example.com');
    const { resolveSSHConfig } = await freshResolver({
      SSH_PROFILES_FILE: path,
      SSH_MCP_PROFILES_CACHE_TTL: '60000',
    });

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
    rewrite(path, 'second.example.com');

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
  });

  it('по истечении срока файл перечитывается', async () => {
    const path = writeProfiles('first.example.com');
    const { resolveSSHConfig } = await freshResolver({
      SSH_PROFILES_FILE: path,
      SSH_MCP_PROFILES_CACHE_TTL: '0',
    });

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
    rewrite(path, 'second.example.com');

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('second.example.com');
  });

  it('другой файл в окружении читается сразу, не дожидаясь срока', async () => {
    const first = writeProfiles('first.example.com');
    const second = writeProfiles('second.example.com');
    const { resolveSSHConfig } = await freshResolver({
      SSH_PROFILES_FILE: first,
      SSH_MCP_PROFILES_CACHE_TTL: '60000',
    });

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
    process.env.SSH_PROFILES_FILE = second;

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('second.example.com');
  });

  it('ручное перечитывание забывает кэш до срока', async () => {
    const path = writeProfiles('first.example.com');
    const { resolveSSHConfig, reloadProfiles } = await freshResolver({
      SSH_PROFILES_FILE: path,
      SSH_MCP_PROFILES_CACHE_TTL: '60000',
    });

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
    rewrite(path, 'second.example.com');
    reloadProfiles();

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('second.example.com');
  });

  it('без переменной окружения отказ называет её', async () => {
    const { resolveSSHConfig } = await freshResolver({});

    expect(() => resolveSSHConfig({})).toThrow(/SSH_PROFILES_FILE/);
  });
});

describe('тильда в пути к ключу раскрывается только ведущая', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Профиль с заданным путём к ключу, прошедший весь путь до конфигурации */
  async function keyPathFromProfile(privateKeyPath: string): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tilde-'));
    tempDirs.push(dir);
    const path = join(dir, 'profiles.json');
    writeFileSync(
      path,
      JSON.stringify({ profiles: { prod: { host: 'example.com', username: 'deploy', privateKeyPath } } }),
      'utf8'
    );

    const { resolveSSHConfig } = await freshResolver({ SSH_PROFILES_FILE: path });
    return resolveSSHConfig({ profile: 'prod' }).privateKeyPath;
  }

  it('ведущая тильда становится домашним каталогом', async () => {
    expect(await keyPathFromProfile('~/.ssh/id_ed25519')).toBe(join(homedir(), '.ssh/id_ed25519'));
  });

  it('тильда в середине пути остаётся именем файла', async () => {
    // `~` — обычный знак в имени; подстановка дома здесь увела бы к чужому файлу
    expect(await keyPathFromProfile('/opt/keys/~backup/id_ed25519')).toBe(
      '/opt/keys/~backup/id_ed25519'
    );
  });

  it('вторая тильда не раскрывается вслед за ведущей', async () => {
    expect(await keyPathFromProfile('~/keys/~backup/id_ed25519')).toBe(
      join(homedir(), 'keys/~backup/id_ed25519')
    );
  });

  it('абсолютный путь остаётся нетронутым', async () => {
    expect(await keyPathFromProfile('/etc/ssh/deploy_key')).toBe('/etc/ssh/deploy_key');
  });

  it('профиль без ключа оставляет поле пустым', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tilde-'));
    tempDirs.push(dir);
    const path = join(dir, 'profiles.json');
    writeFileSync(
      path,
      JSON.stringify({ profiles: { prod: { host: 'example.com', username: 'deploy' } } }),
      'utf8'
    );

    const { resolveSSHConfig } = await freshResolver({ SSH_PROFILES_FILE: path });

    expect(resolveSSHConfig({ profile: 'prod' }).privateKeyPath).toBeUndefined();
  });
});

describe('тильда в пути к самому файлу профилей', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
    watched.paths.length = 0;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fakeHome.path = '';
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Домашний каталог, в котором лежит файл профилей, доступный как `~/profiles.json` */
  function homeWithProfiles(host: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-home-'));
    tempDirs.push(dir);
    fakeHome.path = dir;
    rewrite(join(dir, 'profiles.json'), host);
    return dir;
  }

  it('наблюдатель следит за раскрытым путём, а не за строкой с тильдой', async () => {
    const home = homeWithProfiles('first.example.com');

    await freshResolver({
      SSH_PROFILES_FILE: '~/profiles.json',
      SSH_MCP_PROFILES_WATCH: 'true',
    });

    expect(watched.paths).toEqual([join(home, 'profiles.json')]);
  });

  it('профили с пути под тильдой читаются', async () => {
    homeWithProfiles('first.example.com');

    const { resolveSSHConfig } = await freshResolver({ SSH_PROFILES_FILE: '~/profiles.json' });

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
  });

  it('кэш узнаёт путь под тильдой и не перечитывает файл', async () => {
    const home = homeWithProfiles('first.example.com');

    const { resolveSSHConfig } = await freshResolver({ SSH_PROFILES_FILE: '~/profiles.json' });
    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');

    rewrite(join(home, 'profiles.json'), 'second.example.com');

    expect(resolveSSHConfig({ profile: 'prod' }).host).toBe('first.example.com');
  });
});
