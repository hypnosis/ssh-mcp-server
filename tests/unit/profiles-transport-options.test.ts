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
