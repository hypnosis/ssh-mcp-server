/**
 * Снимок: что попадает в отчёт и о чём сервер вообще спрашивают.
 *
 * Соседний `snapshot-honesty.test.ts` стережёт границу между фактом и
 * «проверить нечем». Здесь — сами разделы отчёта: список служб, докер, сеть,
 * журнал; то, что агент читает глазами.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../src/managers/ssh-executor.js', () => ({
  SSHExecutor: class {
    execute = executeMock;
  },
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
  getDefaultProfile: () => 'production',
}));

const { SnapshotTool } = await import('../../src/tools/snapshot-tool.js');

function respondWith(table: Array<[RegExp, string]>): void {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const match = table.find(([pattern]) => pattern.test(String(command)));
    return { stdout: match ? match[1] : '', stderr: '', exitCode: 0, truncated: false };
  });
}

async function snapshot(): Promise<string> {
  const response = await new SnapshotTool().handleCall({
    params: { name: 'ssh_snapshot', arguments: {} },
  } as CallToolRequest);

  return response.content[0].text;
}

/** Ушла ли на сервер команда по образцу */
function wasSent(pattern: RegExp): boolean {
  return executeMock.mock.calls.some(([, command]) => pattern.test(String(command)));
}

const HAS_DOCKER: Array<[RegExp, string]> = [[/which docker/, '/usr/bin/docker']];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('шапка снимка', () => {
  it('время работы печатается без служебной приставки команды', async () => {
    respondWith([[/uptime -p/, 'up 3 days, 4 hours']]);

    const text = await snapshot();

    expect(text).toContain('Uptime: 3 days, 4 hours');
    expect(text).not.toContain('up 3 days');
  });

  it('имя и время снимка идут из ответов сервера', async () => {
    respondWith([
      [/hostname/, 'web-01'],
      [/^date -u/, '2026-08-14T17:00:00Z'],
    ]);

    const text = await snapshot();

    expect(text).toContain('Hostname: web-01');
    expect(text).toContain('Timestamp: 2026-08-14T17:00:00Z');
  });
});

describe('службы: спрашивают про каждую из списка', () => {
  it.each(['nginx', 'apache2', 'docker', 'postgresql', 'mysql', 'redis', 'mongodb'])(
    'про %s спрашивают',
    async (service) => {
      respondWith([[/command -v systemctl/, 'yes']]);

      await snapshot();

      expect(wasSent(new RegExp(`systemctl is-active ${service}\\b`))).toBe(true);
    }
  );
});

describe('докер', () => {
  it('без докера раздела в отчёте нет', async () => {
    respondWith([[/command -v systemctl/, 'no']]);

    expect(await snapshot()).not.toContain('DOCKER');
  });

  it('с докером печатаются контейнеры и число образов', async () => {
    respondWith([
      ...HAS_DOCKER,
      [/docker ps/, 'a1|web|Up 2 hours\nb2|db|Up 5 days'],
      [/docker images/, '7'],
    ]);

    const text = await snapshot();

    expect(text).toContain('Containers: 2 running');
    expect(text).toContain('Images: 7');
    expect(text).toContain('web');
    expect(text).toContain('Up 5 days');
  });

  it('докер без единого контейнера показывает ноль, а не одну пустую строку', async () => {
    respondWith([...HAS_DOCKER, [/docker images/, '4']]);

    const text = await snapshot();

    expect(text).toContain('Containers: 0 running');
    expect(text).toContain('Images: 4');
  });

  it('нечитанное число образов печатается нулём, а не «NaN»', async () => {
    respondWith([...HAS_DOCKER, [/docker ps/, 'a1|web|Up 2 hours']]);

    const text = await snapshot();

    expect(text).toContain('Images: 0');
    expect(text).not.toContain('NaN');
  });
});

describe('сеть', () => {
  it('нечитанное число соединений печатается нулём, а не «NaN»', async () => {
    respondWith([[/ss -tlnp/, '0.0.0.0:22']]);

    const text = await snapshot();

    expect(text).toContain('Established connections: 0');
    expect(text).not.toContain('NaN');
  });

  it('число соединений печатается тем, что ответил сервер', async () => {
    respondWith([
      [/ss -tlnp/, '0.0.0.0:22'],
      [/grep ESTAB/, '17'],
    ]);

    expect(await snapshot()).toContain('Established connections: 17');
  });
});

describe('занятость процессора удерживается в разумных пределах', () => {
  it('простой больше сотни не превращается в отрицательную занятость', async () => {
    // Верхний край (>100%) недостижим: доля простоя читается регуляркой без
    // знака, поэтому проверяется тот край, до которого сервер довести может
    respondWith([
      [/nproc/, '4'],
      [/^top -bn1/, '%Cpu(s):  0.0 us,  0.0 sy, 105.0 id'],
    ]);

    const text = await snapshot();

    expect(text).toContain('0.0% used');
    expect(text).not.toContain('-5.0%');
  });
});

describe('единицы памяти', () => {
  it('терабайты приводятся к общей единице, как и остальные суффиксы', async () => {
    respondWith([[/free -h/, 'Mem:           2.0Ti       1.0Ti       1.0Ti']]);

    expect(await snapshot()).toContain('(50% used)');
  });

  it('суффиксы разных единиц делятся друг на друга правильно', async () => {
    respondWith([[/free -h/, 'Mem:           1.0Ti     512.0Gi     512.0Gi']]);

    expect(await snapshot()).toContain('(50% used)');
  });
});

describe('журнал ошибок', () => {
  it('длинная строка обрезается, а не уезжает в отчёт целиком', async () => {
    const long = `oom-killer invoked ${'x'.repeat(200)}`;
    respondWith([[/syslog/, long]]);

    const text = await snapshot();

    expect(text).toContain('oom-killer invoked');
    expect(text).not.toContain('x'.repeat(120));
  });
});
