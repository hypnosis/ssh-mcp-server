/**
 * Unit tests for the transport options in the profiles file
 *
 * Поля добавляются аддитивно: файлы прежнего формата обязаны грузиться
 * без изменений, а новые настройки — доезжать до транспорта.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProfilesFile } from '../../src/utils/profiles-file.js';
import { reloadProfiles, resolveSSHConfig } from '../../src/utils/profile-resolver.js';

const tempDirs: string[] = [];

/** Записать файл профилей и вернуть путь к нему */
function writeProfiles(profiles: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-'));
  tempDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify({ default: 'production', profiles }), 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('profiles file: transport options', () => {
  it('доносит политику проверки ключа хоста до конфигурации', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        strictHostKeyChecking: 'yes',
      },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(config?.profiles.production.strictHostKeyChecking).toBe('yes');
  });

  it('доносит отказ от пользовательского ~/.ssh/config', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', ignoreUserConfig: true },
    });

    expect(loadProfilesFile(path).config?.profiles.production.ignoreUserConfig).toBe(true);
  });

  it('профиль прежнего формата грузится без новых полей', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', privateKeyPath: '~/.ssh/id_ed25519' },
    });

    const profile = loadProfilesFile(path).config?.profiles.production;

    expect(profile?.strictHostKeyChecking).toBeUndefined();
    expect(profile?.ignoreUserConfig).toBeUndefined();
  });

  it('опечатка в политике проверки ключа хоста не проходит молча', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', strictHostKeyChecking: 'true' },
    });

    const { errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(/strictHostKeyChecking/);
  });
});

/**
 * Ограничения на пути.
 *
 * README обещает их с давних пор, но поле терялось дважды: загрузчик собирал
 * профиль по одному полю и про него не знал, а сборщик конфигурации не
 * переносил его дальше. Валидатор из-за этого не создавался ни разу — замерено
 * на живых серверах: запись в запрещённый каталог проходила успешно.
 */
describe('profiles file: ограничения на пути', () => {
  it('правила доезжают из файла до профиля', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        pathSecurity: { deniedPaths: ['/root'], allowedPaths: ['/var/www'] },
      },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(config?.profiles.production.pathSecurity).toEqual({
      deniedPaths: ['/root'],
      allowedPaths: ['/var/www'],
    });
  });

  it('профиль без ограничений остаётся без них', () => {
    const path = writeProfiles({ production: { host: 'example.com', username: 'deploy' } });

    expect(loadProfilesFile(path).config?.profiles.production.pathSecurity).toBeUndefined();
  });

  /**
   * Испорченная запись обязана быть ошибкой: молча забытое правило выглядит
   * как включённая защита, которой на самом деле нет.
   */
  it.each([
    ['список вместо объекта', ['/root']],
    ['строка вместо списка путей', { deniedPaths: '/root' }],
    ['пустая строка в списке', { deniedPaths: ['/root', '  '] }],
    ['число в списке путей', { allowedPaths: [42] }],
    ['нечисловая длина пути', { maxPathLength: 'много' }],
    ['нелогическое allowTraversal', { allowTraversal: 'no' }],
  ])('испорченные правила (%s) не проходят молча', (_name, pathSecurity) => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', pathSecurity },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(/pathSecurity/);
    expect(config?.profiles.production).toBeUndefined();
  });

  /**
   * Второе звено той же цепочки: сборка конфигурации из профиля. Здесь поле
   * терялось отдельно от загрузчика, поэтому проверяется весь путь целиком —
   * от файла до того объекта, у которого инструменты спрашивают правила.
   */
  it('правила доходят до конфигурации, с которой работают инструменты', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        pathSecurity: { deniedPaths: ['/root'] },
      },
    });

    const previous = process.env.SSH_PROFILES_FILE;
    process.env.SSH_PROFILES_FILE = path;
    try {
      reloadProfiles();
      const config = resolveSSHConfig({ profile: 'production' });

      expect(config.pathSecurity).toEqual({ deniedPaths: ['/root'] });
    } finally {
      // Возвращаем окружение как было; без файла профилей перезагрузка
      // законно отказывается — соседние тесты от этого страдать не должны
      if (previous === undefined) delete process.env.SSH_PROFILES_FILE;
      else process.env.SSH_PROFILES_FILE = previous;
      try {
        reloadProfiles();
      } catch {
        /* профилей больше нет — так и было до теста */
      }
    }
  });
});
