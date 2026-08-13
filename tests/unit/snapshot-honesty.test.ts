/**
 * Unit tests: снимок не выдаёт «проверить нечем» за факт о сервере
 *
 * Все три случая пойманы живой приёмкой на BusyBox-стендах, и все три
 * выглядели в отчёте нормальным результатом:
 *  - «No active services detected» там, где просто нет systemctl;
 *  - «Listening ports:» пустым списком на машине с работающим sshd;
 *  - «233.0% used» на простаивающем процессоре, потому что колонка вырезалась
 *    из строки, которой у BusyBox нет.
 *
 * Плюс единицы `free -h`: `506Mi` из `3.8Gi` давали 13316% занятой памяти.
 *
 * Вывод команд здесь дословный: procps и BusyBox печатают сводку по-разному,
 * и разбор обязан узнавать оба формата.
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

/** Дословная сводка procps: доля простоя стоит перед `id` */
const TOP_PROCPS = [
  'top - 17:32:50 up 20:00,  0 users,  load average: 1.18, 0.89, 0.85',
  'Tasks: 792 total,   1 running, 791 sleeping',
  '%Cpu(s):  3.4 us,  1.5 sy,  0.0 ni, 95.1 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st',
  'MiB Mem :   7900.0 total,   3300.0 free,   2900.0 used',
].join('\n');

/** Дословная сводка BusyBox: другая строка и другой порядок колонок */
const TOP_BUSYBOX = [
  'Mem: 4597000K used, 3527232K free, 81132K shrd, 330644K buff, 1048512K cached',
  'CPU:  0% usr  0% sys  0% nic 99% idle  0% io  0% irq  0% sirq',
  'Load average: 0.70 0.86 0.88 1/792 322',
  '  PID  PPID USER     STAT   VSZ %VSZ %CPU COMMAND',
  '  200     1 root     S     1748   0%   0% /usr/sbin/sshd -D -e',
].join('\n');

/**
 * Ответы транспорта по образцу команды. Сервер отвечает только на то, что
 * знает: команда, которой на нём нет, приходит с ненулевым кодом или маркером.
 */
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

/** Команда, ушедшая на сервер по образцу */
function sentCommand(pattern: RegExp): string | undefined {
  const call = executeMock.mock.calls.find(([, command]) => pattern.test(String(command)));
  return call ? String(call[1]) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ssh_snapshot: загрузка процессора', () => {
  it('сводка procps читается как занятость, а не как первая колонка', async () => {
    respondWith([
      [/nproc/, '4'],
      [/loadavg/, '0.15 0.22 0.19 1/512 30412'],
      [/^top -bn1/, TOP_PROCPS],
    ]);

    expect(await snapshot()).toContain('4 cores, 4.9% used');
  });

  it('сводка BusyBox читается тем же разбором', async () => {
    respondWith([
      [/nproc/, '18'],
      [/loadavg/, '0.70 0.86 0.88 1/792 322'],
      [/^top -bn1/, TOP_BUSYBOX],
    ]);

    const text = await snapshot();

    expect(text).toContain('18 cores, 1.0% used');
    expect(text).not.toContain('200.0%');
  });

  it('сервер без top отвечает «нечем проверить», а не числом', async () => {
    respondWith([
      [/nproc/, '2'],
      [/loadavg/, '0.00 0.01 0.05 1/100 42'],
    ]);

    expect(await snapshot()).toContain('2 cores, usage NOT CHECKED');
  });

  it('мусор вместо сводки не превращается в ноль процентов', async () => {
    respondWith([
      [/nproc/, '2'],
      [/^top -bn1/, 'top: unrecognized option'],
    ]);

    expect(await snapshot()).toContain('usage NOT CHECKED');
  });
});

describe('ssh_snapshot: занятость памяти', () => {
  it('единицы приводятся друг к другу перед делением', async () => {
    respondWith([[/free -h/, 'Mem:           3.8Gi       506Mi       2.9Gi        79Mi']]);

    const text = await snapshot();

    expect(text).toContain('Memory: 506Mi / 3.8Gi (13% used)');
  });

  it('одинаковые единицы считаются как раньше', async () => {
    respondWith([[/free -h/, 'Mem:           7.7G        2.9G        3.3G']]);

    expect(await snapshot()).toContain('Memory: 2.9G / 7.7G (38% used)');
  });

  it('размер без суффикса — это байты, а не отдельная единица', async () => {
    respondWith([[/free -h/, 'Mem:           2048        1024        1024']]);

    expect(await snapshot()).toContain('(50% used)');
  });

  it('нечитаемый вывод free — «нечем проверить», а не ноль процентов', async () => {
    respondWith([[/free -h/, 'Mem:           n/a         n/a         n/a']]);

    expect(await snapshot()).toContain('usage NOT CHECKED');
  });
});

describe('ssh_snapshot: службы и порты', () => {
  it('сервер без systemctl не объявляется сервером без служб', async () => {
    respondWith([[/command -v systemctl/, 'no']]);

    const text = await snapshot();

    expect(text).toContain('NOT CHECKED: no systemctl on the server');
    expect(text).not.toContain('No active services detected');
  });

  it('сервер с systemctl, где ничего не работает, говорит именно это', async () => {
    respondWith([
      [/command -v systemctl/, 'yes'],
      [/is-active/, 'inactive'],
    ]);

    const text = await snapshot();

    expect(text).toContain('No active services detected');
    expect(text).not.toContain('NOT CHECKED: no systemctl');
  });

  it('работающая служба по-прежнему видна', async () => {
    respondWith([
      [/command -v systemctl/, 'yes'],
      [/is-active nginx/, 'active'],
      [/is-active/, 'inactive'],
    ]);

    expect(await snapshot()).toMatch(/nginx\s+✓ active/);
  });

  it('сервер без ss и netstat не объявляется сервером без слушателей', async () => {
    respondWith([[/LISTEN/, 'NO_NET_TOOL']]);

    const text = await snapshot();

    expect(text).toContain('NOT CHECKED: neither ss nor netstat on the server');
    expect(text).not.toContain('Established connections: 0');
  });

  it('запасной netstat уезжает вместе с командой', async () => {
    respondWith([[/LISTEN/, '22\n80']]);
    await snapshot();

    expect(sentCommand(/LISTEN/)).toContain('netstat -tlnp');
    expect(sentCommand(/LISTEN/)).toContain('NO_NET_TOOL');
  });

  it('найденные порты печатаются со службами', async () => {
    respondWith([
      [/LISTEN/, '22\n443'],
      [/ESTAB/, '5'],
    ]);

    const text = await snapshot();

    expect(text).toContain('Established connections: 5');
    expect(text).toMatch(/22\s+ssh/);
    expect(text).toMatch(/443\s+https/);
  });
});
