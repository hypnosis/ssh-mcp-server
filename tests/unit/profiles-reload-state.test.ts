/**
 * Перечитывание профилей забывает всё, что выведено из прежних.
 *
 * Три хранилища живут по ключу назначения и переживают перезапись файла:
 * секреты для маскировки, транспорты и паспорта серверов. Удалённый профиль
 * остаётся в памяти вместе с паролем, а сервер, успевший измениться, отвечает
 * по старому паспорту — поэтому каждое проверяется отдельно.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger, hideFromLogs, forgetLoggedSecrets } from '../../src/utils/logger.js';
import { reloadProfiles } from '../../src/utils/profile-resolver.js';
import { getOpenSshRunner, resetRunnerCache } from '../../src/runner/openssh-runner.js';
import { getServerPassport, resetPassportCache } from '../../src/runner/passport.js';
import type { RunnerConfig } from '../../src/runner/ssh-args.js';

const OLD_SECRET = 'Zq4#tR9wYx';
const NEW_SECRET = 'Bm2$vK7nQs';

const CONFIG: RunnerConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

const tempDirs: string[] = [];
let previousProfilesFile: string | undefined;

/** Положить файл профилей и перечитать их из него */
function loadProfiles(profile: Record<string, unknown> = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-reload-'));
  tempDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify({
    default: 'production',
    profiles: { production: { host: 'example.com', username: 'deploy', ...profile } },
  }), 'utf8');

  process.env.SSH_PROFILES_FILE = path;
  reloadProfiles();
}

beforeEach(() => {
  previousProfilesFile = process.env.SSH_PROFILES_FILE;
});

afterEach(() => {
  if (previousProfilesFile === undefined) delete process.env.SSH_PROFILES_FILE;
  else process.env.SSH_PROFILES_FILE = previousProfilesFile;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  forgetLoggedSecrets();
  resetRunnerCache();
  resetPassportCache();
});

describe('перечитывание профилей забывает производное состояние', () => {
  describe('секреты для маскировки', () => {
    let written: string[];
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      written = [];
      spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it('секрет прежнего профиля больше не маскируется', () => {
      hideFromLogs(OLD_SECRET);

      loadProfiles();
      logger.error(`profile secret was ${OLD_SECRET}`);

      expect(written.join('\n')).toContain(OLD_SECRET);
    });

    it('секрет нового файла маскируется', () => {
      loadProfiles({ password: NEW_SECRET });
      logger.error(`profile secret is ${NEW_SECRET}`);

      expect(written.join('\n')).not.toContain(NEW_SECRET);
      expect(written.join('\n')).toContain('***');
    });
  });

  it('транспорт прежних профилей не выдаётся повторно', async () => {
    const before = await getOpenSshRunner(CONFIG);
    expect(await getOpenSshRunner(CONFIG)).toBe(before);

    loadProfiles();

    expect(await getOpenSshRunner(CONFIG)).not.toBe(before);
  });

  it('паспорт сервера снимается заново', async () => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return 'os=linux\nhome=/root\n';
    };

    await getServerPassport('deploy@example.com:22', probe);
    await getServerPassport('deploy@example.com:22', probe);
    expect(probes).toBe(1);

    loadProfiles();
    await getServerPassport('deploy@example.com:22', probe);

    expect(probes).toBe(2);
  });
});
