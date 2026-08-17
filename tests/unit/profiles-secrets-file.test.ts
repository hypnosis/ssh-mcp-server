/**
 * Секреты, вынесенные из файла профилей.
 *
 * Файл профилей копируют, показывают при отладке и коммитят по недосмотру, поэтому
 * пароль живёт отдельно. Здесь проверяется весь путь: файл секретов → загрузчик →
 * готовый профиль, а также то, что непрочитанный секрет роняет профиль, а не уводит его
 * молча на вход без пароля.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeBrokenProfile, loadProfilesFile } from '../../src/utils/profiles-file.js';
import { forgetLoggedSecrets, logger } from '../../src/utils/logger.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-secrets-'));
  tempDirs.push(dir);
  return dir;
}

const VALID = { host: 'example.com', username: 'deploy' };

/**
 * Разложить рядом файл профилей и файл секретов.
 * Права на секреты по умолчанию закрытые — иначе загрузчик откажется их читать.
 */
function writePair(options: {
  profiles: unknown;
  secrets?: unknown;
  secretsName?: string;
  mode?: number;
}): { profilesPath: string; secretsPath: string; dir: string } {
  const dir = tempDir();
  const profilesPath = join(dir, 'profiles.json');
  const secretsPath = join(dir, options.secretsName ?? 'secrets.json');

  writeFileSync(profilesPath, JSON.stringify(options.profiles), 'utf8');
  if (options.secrets !== undefined) {
    writeFileSync(
      secretsPath,
      typeof options.secrets === 'string' ? options.secrets : JSON.stringify(options.secrets),
      'utf8'
    );
    chmodSync(secretsPath, options.mode ?? 0o600);
  }

  return { profilesPath, secretsPath, dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  forgetLoggedSecrets();
  vi.restoreAllMocks();
});

describe('секрет доезжает из отдельного файла до профиля', () => {
  it('пароль подставляется в профиль', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: { prod: { password: 'from-secrets-file' } },
    });

    const { config } = loadProfilesFile(profilesPath);

    expect(config?.profiles.prod.password).toBe('from-secrets-file');
  });

  it('парольная фраза ключа подставляется тем же путём', () => {
    const { profilesPath } = writePair({
      profiles: {
        secretsFile: 'secrets.json',
        profiles: { prod: { ...VALID, privateKeyPath: '~/.ssh/id_ed25519' } },
      },
      secrets: { prod: { passphrase: 'key-passphrase' } },
    });

    const { config } = loadProfilesFile(profilesPath);

    expect(config?.profiles.prod.passphrase).toBe('key-passphrase');
  });

  it('секрет из файла перекрывает записанный прямо в профиле', () => {
    const { profilesPath } = writePair({
      profiles: {
        secretsFile: 'secrets.json',
        profiles: { prod: { ...VALID, password: 'inline-stale' } },
      },
      secrets: { prod: { password: 'from-secrets-file' } },
    });

    const { config } = loadProfilesFile(profilesPath);

    expect(config?.profiles.prod.password).toBe('from-secrets-file');
  });

  it('секрет не попадает в лог', () => {
    const spy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: { prod: { password: 'super-secret-value' } },
    });

    loadProfilesFile(profilesPath);

    const logged = spy.mock.calls.flat().map((entry) => JSON.stringify(entry)).join(' ');
    expect(logged).not.toContain('super-secret-value');
  });
});

describe('какой файл секретов относится к профилю', () => {
  it('профиль со своим файлом берёт его, а не общий', () => {
    const dir = tempDir();
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(join(dir, 'shared.json'), JSON.stringify({ prod: { password: 'shared' } }), 'utf8');
    chmodSync(join(dir, 'shared.json'), 0o600);
    writeFileSync(join(dir, 'own.json'), JSON.stringify({ prod: { password: 'own' } }), 'utf8');
    chmodSync(join(dir, 'own.json'), 0o600);
    writeFileSync(
      profilesPath,
      JSON.stringify({
        secretsFile: 'shared.json',
        profiles: { prod: { ...VALID, secretsFile: 'own.json' } },
      }),
      'utf8'
    );

    const { config } = loadProfilesFile(profilesPath);

    expect(config?.profiles.prod.password).toBe('own');
  });

  it('относительный путь считается от файла профилей, а не от рабочего каталога', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: './secrets.json', profiles: { prod: VALID } },
      secrets: { prod: { password: 'resolved-next-to-profiles' } },
    });

    // Рабочий каталог здесь чужой: если бы путь считался от него, файла бы не нашлось
    expect(existsSync(join(process.cwd(), 'secrets.json'))).toBe(false);

    const { config } = loadProfilesFile(profilesPath);

    expect(config?.profiles.prod.password).toBe('resolved-next-to-profiles');
  });

  it('профиль без записи в общем файле остаётся годным', () => {
    const { profilesPath } = writePair({
      profiles: {
        secretsFile: 'secrets.json',
        profiles: { withKey: { ...VALID, privateKeyPath: '~/.ssh/id_ed25519' } },
      },
      secrets: { other: { password: 'not-for-this-profile' } },
    });

    const { config, broken } = loadProfilesFile(profilesPath);

    expect(broken).toEqual([]);
    expect(config?.profiles.withKey).toBeDefined();
    expect(config?.profiles.withKey.password).toBeUndefined();
  });
});

describe('нечитаемый файл секретов роняет профиль, а не проходит молча', () => {
  it('слишком открытые права отвергаются', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: { prod: { password: 'exposed' } },
      mode: 0o644,
    });

    const { config, broken } = loadProfilesFile(profilesPath);

    expect(config).toBeNull();
    expect(broken[0].field).toBe('secretsFile');
    expect(broken[0].reason).toContain('0644');
    expect(broken[0].reason).toContain('chmod 600');
  });

  it('отсутствующий файл отвергается', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'nowhere.json', profiles: { prod: VALID } },
    });

    const { broken } = loadProfilesFile(profilesPath);

    expect(broken[0].reason).toContain('file not found');
  });

  it('испорченный JSON отвергается', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: '{ "prod": ',
    });

    const { broken } = loadProfilesFile(profilesPath);

    expect(broken[0].reason).toContain('not valid JSON');
  });

  it('запись не-объектом отвергается', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: { prod: 'just-a-string' },
    });

    const { broken } = loadProfilesFile(profilesPath);

    expect(broken[0].reason).toContain('must be an object');
  });

  it('нестроковый пароль отвергается', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'secrets.json', profiles: { prod: VALID } },
      secrets: { prod: { password: 12345 } },
    });

    const { broken } = loadProfilesFile(profilesPath);

    expect(broken[0].reason).toContain('must be a string');
  });

  it('в сообщении об отказе показан правильный формат файла', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'nowhere.json', profiles: { prod: VALID } },
    });

    const { broken } = loadProfilesFile(profilesPath);
    const message = describeBrokenProfile(broken[0]);

    expect(message).toContain('Expected format:');
    expect(message).toContain('"password"');
    expect(message).toContain('"passphrase"');
  });

  it('причина отказа читается целиком до образца формата', () => {
    const { profilesPath } = writePair({
      profiles: { secretsFile: 'nowhere.json', profiles: { prod: VALID } },
    });

    const { broken } = loadProfilesFile(profilesPath);
    const firstLine = describeBrokenProfile(broken[0]).split('\n')[0];

    expect(firstLine).toContain('file not found');
    expect(firstLine).toContain('got "nowhere.json"');
  });
});
