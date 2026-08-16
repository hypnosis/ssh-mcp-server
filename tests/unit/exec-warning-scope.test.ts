/**
 * Unit tests: предупреждение говорит о команде, а не о встреченном слове
 *
 * Аудит свежего сервера печатал «DANGEROUS COMMAND: reboot detected» на чтении
 * файла `/var/run/reboot-required` — того самого, который читает наш же
 * `ssh_audit_baseline`. Предупреждение, звучащее на штатной работе, перестают
 * читать, и настоящая беда теряется в шуме.
 *
 * У каждого шаблона проверяются обе стороны: вызов обязан предупредить,
 * упоминание — промолчать.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../src/managers/ssh-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/managers/ssh-executor.js')>();
  return {
    DEFAULT_TIMEOUT_MS: actual.DEFAULT_TIMEOUT_MS,
    SSHExecutor: class {
      execute = executeMock;
      passport = vi.fn();
    },
  };
});

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');

const answer = async (command: string): Promise<string> => {
  const request = { params: { name: 'ssh_exec', arguments: { command } } } as CallToolRequest;
  const response = await new ExecTool().handleCall(request);
  return response.content[0].text;
};

const warned = async (command: string): Promise<boolean> =>
  (await answer(command)).includes('DANGEROUS COMMAND');

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });
});

describe('остановка машины: вызов против упоминания', () => {
  it.each([
    ['reboot'],
    ['shutdown -r +1'],
    ['halt'],
    ['poweroff'],
    ['sudo reboot'],
    ['/sbin/reboot'],
    ['uptime; reboot'],
  ])('%s — вызов, предупреждение обязано быть', async (command) => {
    expect(await warned(command)).toBe(true);
  });

  it.each([
    ['test -f /var/run/reboot-required && cat /var/run/reboot-required'],
    ['grep reboot /var/log/syslog'],
    ['echo halt'],
    ['ls -la /etc/init.d/halt'],
    ['cat /var/log/shutdown.log'],
    ['systemctl status poweroff.target'],
  ])('%s — упоминание, предупреждения быть не должно', async (command) => {
    expect(await warned(command)).toBe(false);
  });

  it.each([
    ['git commit -m "fix; reboot handler"'],
    ['echo "maintenance; halt scheduled"'],
    ["psql -c 'SELECT 1; -- poweroff later'"],
  ])('%s — точка с запятой внутри кавычек команду не начинает', async (command) => {
    expect(await warned(command)).toBe(false);
  });

  it('файл, который читает собственный аудит проекта, тревоги не поднимает', async () => {
    const text = await answer('(test -f /var/run/reboot-required && echo YES) || echo NO');

    expect(text).not.toContain('DANGEROUS COMMAND');
  });
});

describe('права на файл: вызов против упоминания', () => {
  it('chmod 777 — предупреждение', async () => {
    expect(await warned('chmod 777 /srv/app')).toBe(true);
  });

  it('chmod 777 в аргументе поиска — тишина', async () => {
    expect(await warned('grep -rn "chmod 777" /etc/deploy')).toBe(false);
  });

  it('другие права предупреждения не поднимают', async () => {
    expect(await warned('chmod 755 /srv/app')).toBe(false);
  });

  it('те же цифры у другой команды правами не считаются', async () => {
    expect(await warned('find /srv -perm 777 -type f')).toBe(false);
  });
});

describe('запросы к базе: только там, где база вызвана', () => {
  it.each([
    ['psql -c "TRUNCATE users;"'],
    ['mysql -u root -e "DROP TABLE sessions;"'],
    ['sqlite3 app.db "DELETE FROM users;"'],
  ])('%s — предупреждение', async (command) => {
    expect(await warned(command)).toBe(true);
  });

  it('запрос на входе клиента тоже виден', async () => {
    expect(await warned('mysql -u root app <<EOF\nTRUNCATE users;\nEOF')).toBe(true);
  });

  it.each([
    ['echo "TRUNCATE users;"'],
    ['grep -rn TRUNCATE /srv/app/migrations'],
    ['cat migrations/003_drop_table.sql'],
  ])('%s — клиента БД нет, значит и предупреждения нет', async (command) => {
    expect(await warned(command)).toBe(false);
  });
});

describe('массовая уборка docker', () => {
  it('docker system prune -a — предупреждение', async () => {
    expect(await warned('docker system prune -a')).toBe(true);
  });

  it('слитный флаг чистит так же и тоже предупреждает', async () => {
    expect(await warned('docker system prune -af')).toBe(true);
  });

  it('слитный флаг в другом порядке ловится так же', async () => {
    expect(await warned('docker system prune -fa')).toBe(true);
  });

  it('длинная форма флага — то же самое', async () => {
    expect(await warned('docker system prune --all')).toBe(true);
  });

  it('уборка без -a трогает только висящее — предупреждения нет', async () => {
    expect(await warned('docker system prune -f')).toBe(false);
  });

  it('уборка образов машину не разбирает — предупреждения нет', async () => {
    expect(await warned('docker image prune -a')).toBe(false);
  });

  it('осмотр занятого места предупреждения не поднимает', async () => {
    expect(await warned('docker system df')).toBe(false);
  });

  it('docker rm всех контейнеров — предупреждение', async () => {
    expect(await warned('docker rm -f $(docker ps -aq)')).toBe(true);
  });

  it('слежение за логами живого контейнера — тишина, хотя флаг тот же', async () => {
    expect(await warned('docker logs -f $(docker ps -q | head -1)')).toBe(false);
  });

  it('удаление одного контейнера по имени — тишина', async () => {
    expect(await warned('docker rm -f old-app')).toBe(false);
  });

  it('та же строка в тексте — тишина', async () => {
    expect(await warned('echo "docker system prune -a" >> /root/notes.txt')).toBe(false);
  });

  it('обычная работа с docker предупреждения не поднимает', async () => {
    expect(await warned('docker ps -a')).toBe(false);
  });

  it('список назван поимённо: у другого движка контейнеров свои команды', async () => {
    expect(await warned('podman system prune -a')).toBe(false);
  });
});

describe('обёртки не прячут команду', () => {
  it.each([
    ['timeout 5 reboot'],
    ['nice -n 10 halt'],
    ['env DEBUG=1 poweroff'],
    ['nohup shutdown -h now'],
  ])('%s — предупреждение обязано быть', async (command) => {
    expect(await warned(command)).toBe(true);
  });

  it('обёртка над безобидной командой тревоги не поднимает', async () => {
    expect(await warned('timeout 5 curl https://example.com/reboot')).toBe(false);
  });
});
