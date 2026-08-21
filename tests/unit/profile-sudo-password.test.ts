/**
 * Пароль для `sudo` на всём пути: файл профилей → загрузчик → конфигурация вызова.
 *
 * Загрузчик собирает профиль вручную, поле за полем, и новое поле теряется там
 * молча: так `pathSecurity` месяцами числился работающим, не доехав ни разу.
 * Поэтому проверяется не отдельное звено, а вся цепочка — до того объекта,
 * который получает инструмент.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProfilesFile } from '../../src/utils/profiles-file.js';
import { resolveSSHConfig } from '../../src/utils/profile-resolver.js';
import { forgetLoggedSecrets, logger } from '../../src/utils/logger.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-sudo-pw-'));
  tempDirs.push(dir);
  return dir;
}

/** Профиль третьей группы: вход по ключу, а `sudo` на сервере спрашивает пароль */
const KEY_PROFILE = {
  host: 'example.com',
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

function writeProfiles(content: unknown): string {
  const path = join(tempDir(), 'profiles.json');
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.SSH_PROFILES_FILE;
  forgetLoggedSecrets();
  vi.restoreAllMocks();
});

describe('sudoPassword доезжает от файла до вызова', () => {
  it('загрузчик кладёт его в профиль', () => {
    const path = writeProfiles({
      profiles: { prod: { ...KEY_PROFILE, sudoPassword: 'root-secret' } },
    });

    const result = loadProfilesFile(path);

    expect(result.errors).toEqual([]);
    expect(result.config!.profiles.prod.sudoPassword).toBe('root-secret');
  });

  it('и он оказывается в конфигурации, которую получает инструмент', () => {
    process.env.SSH_PROFILES_FILE = writeProfiles({
      profiles: { prod: { ...KEY_PROFILE, sudoPassword: 'root-secret' } },
    });

    const config = resolveSSHConfig({ profile: 'prod' });

    expect(config.sudoPassword).toBe('root-secret');
    // Пароля входа у профиля по ключу нет, и подставлять его вместо нечего
    expect(config.password).toBeUndefined();
  });

  it('без поля в конфигурации его нет — падать назад загрузчику не на что', () => {
    process.env.SSH_PROFILES_FILE = writeProfiles({ profiles: { prod: KEY_PROFILE } });

    expect(resolveSSHConfig({ profile: 'prod' }).sudoPassword).toBeUndefined();
  });

  it('не строка — в профиль не попадает', () => {
    const path = writeProfiles({ profiles: { prod: { ...KEY_PROFILE, sudoPassword: 42 } } });

    expect(loadProfilesFile(path).config!.profiles.prod.sudoPassword).toBeUndefined();
  });

  /** Тот же секрет, только записанный прямо здесь: маскировка не различает, откуда он взялся */
  it('прячется из журнала и записанный прямо в файле профилей', () => {
    const written: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map((entry) => String(entry)).join(' '));
    });

    const path = writeProfiles({
      profiles: { prod: { ...KEY_PROFILE, sudoPassword: 'inline-secret' } },
    });
    loadProfilesFile(path);
    logger.error('sudo answered with inline-secret');

    expect(written.join(' ')).toContain('sudo answered with');
    expect(written.join(' ')).not.toContain('inline-secret');
  });

  /** Файл профилей копируют и показывают — секрету в нём не место, и об этом говорится */
  it('записанный прямо в файле профилей — повод предупредить', () => {
    const warned: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      warned.push(message);
    });

    loadProfilesFile(
      writeProfiles({ profiles: { prod: { ...KEY_PROFILE, sudoPassword: 'inline-secret' } } })
    );

    expect(warned.join(' ')).toContain('keeps a secret inline');
  });
});

describe('sudoPassword из файла секретов', () => {
  /** Файл профилей копируют и показывают; секрет живёт отдельно, под своими правами */
  function writePair(secrets: unknown): string {
    const dir = tempDir();
    const profilesPath = join(dir, 'profiles.json');
    const secretsPath = join(dir, 'secrets.json');

    writeFileSync(
      profilesPath,
      JSON.stringify({ profiles: { prod: { ...KEY_PROFILE, secretsFile: 'secrets.json' } } }),
      'utf8'
    );
    writeFileSync(secretsPath, JSON.stringify(secrets), 'utf8');
    chmodSync(secretsPath, 0o600);

    return profilesPath;
  }

  it('читается вместе с остальными секретами', () => {
    const path = writePair({ prod: { sudoPassword: 'root-secret' } });

    const result = loadProfilesFile(path);

    expect(result.errors).toEqual([]);
    expect(result.config!.profiles.prod.sudoPassword).toBe('root-secret');
  });

  it('не того вида — профиль отклоняется, а не уходит без пароля', () => {
    const path = writePair({ prod: { sudoPassword: 42 } });

    const result = loadProfilesFile(path);

    expect(result.config?.profiles.prod).toBeUndefined();
    expect(result.errors.join(' ')).toContain('sudoPassword');
  });

  /**
   * Проверяется сама маскировка, а не молчание загрузчика: строка с секретом
   * пишется в журнал нарочно, и наружу она обязана выйти уже закрытой.
   */
  it('прячется из журнала, даже когда его туда пишут', () => {
    const written: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map((entry) => String(entry)).join(' '));
    });

    const path = writePair({ prod: { sudoPassword: 'root-secret' } });
    loadProfilesFile(path);
    logger.error('sudo answered with root-secret');

    expect(written.join(' ')).toContain('sudo answered with');
    expect(written.join(' ')).not.toContain('root-secret');
  });
});
