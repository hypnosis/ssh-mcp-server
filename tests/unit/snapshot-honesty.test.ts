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

/**
 * Оборванное чтение приходит пустым ответом, и снимок печатал его как факт:
 * машина с нулём процессоров и пустой строкой нагрузки. Замер на стенде с
 * dropbear давал такой ответ в двух снимках из шести.
 */
describe('ssh_snapshot: оборванное чтение — не значение', () => {
  it('нечитанное число ядер не выдаётся за ноль ядер', async () => {
    respondWith([
      [/loadavg/, '0.10 0.20 0.30 1/100 42'],
      [/^top -bn1/, TOP_PROCPS],
    ]);

    const text = await snapshot();

    expect(text).toContain('cores NOT CHECKED');
    expect(text).not.toContain('0 cores');
  });

  it('нечитанная нагрузка не выдаётся за пустую', async () => {
    respondWith([
      [/nproc/, '4'],
      [/^top -bn1/, TOP_PROCPS],
    ]);

    expect(await snapshot()).toContain('load: NOT CHECKED');
  });

  it('прочитанные ядра и нагрузка печатаются как есть', async () => {
    respondWith([
      [/nproc/, '4'],
      [/loadavg/, '0.15 0.22 0.19 1/512 30412'],
      [/^top -bn1/, TOP_PROCPS],
    ]);

    const text = await snapshot();

    expect(text).toContain('4 cores');
    expect(text).toContain('load: 0.15 0.22 0.19');
  });
});

/**
 * Залп из десяти мгновенных команд dropbear обрывает, поэтому чтения снимка
 * идут очередью. Предел проверяется по числу одновременно висящих вызовов.
 */
describe('ssh_snapshot: очередь чтений', () => {
  it('одновременных чтений не больше четырёх', async () => {
    let running = 0;
    let peak = 0;

    executeMock.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    });

    await snapshot();

    expect(peak).toBeLessThanOrEqual(4);
    expect(executeMock.mock.calls.length).toBeGreaterThan(4);
  });
});

/**
 * Снимок собирается из независимых чтений, и сорванное чтение — это пустой
 * показатель, а не пустой отчёт: двойной обрыв канала на стенде с dropbear
 * заменял снимок целиком одной строкой ошибки.
 */
describe('ssh_snapshot: сорванное чтение не рушит отчёт', () => {
  it('исключение одного чтения оставляет остальные на месте', async () => {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (/nproc/.test(String(command))) {
        throw new Error('The channel to example.com:22 closed before the command produced output.');
      }
      if (/hostname/.test(String(command))) {
        return { stdout: 'router', stderr: '', exitCode: 0, truncated: false };
      }
      if (/loadavg/.test(String(command))) {
        return { stdout: '0.10 0.20 0.30 1/100 42', stderr: '', exitCode: 0, truncated: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    });

    const text = await snapshot();

    expect(text).toContain('router');
    expect(text).toContain('cores NOT CHECKED');
    expect(text).toContain('load: 0.10 0.20 0.30');
    expect(text).not.toMatch(/^Error:/);
  });
});

/**
 * Раздел «RECENT ERRORS» исчезал одинаково во всех случаях: журнала нет, читать
 * нечем, читали и не нашли. Пустой раздел читается как «в журнале чисто».
 */
describe('ssh_snapshot: журнал ошибок', () => {
  const syslog = /var\/log\/syslog/;

  it('журнала нет — так и сказано', async () => {
    respondWith([[syslog, 'NO_SYSLOG']]);

    const text = await snapshot();

    expect(text).toContain('RECENT ERRORS');
    expect(text).toContain('NOT CHECKED: no /var/log/syslog on the server');
  });

  it('журнал есть, но закрыт — это не «ошибок нет»', async () => {
    respondWith([[syslog, 'SYSLOG_UNREADABLE']]);

    expect(await snapshot()).toContain('NOT CHECKED: /var/log/syslog is not readable');
  });

  it('сорванное чтение не выдаётся за чистый журнал', async () => {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      if (syslog.test(String(command))) throw new Error('connection reset');
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    });

    expect(await snapshot()).toContain('NOT CHECKED: the read did not go through');
  });

  it('найденные строки печатаются как ошибки', async () => {
    respondWith([[syslog, 'Aug 13 20:00:00 host app[1]: ERROR первая беда']]);

    expect(await snapshot()).toContain('[syslog] Aug 13 20:00:00 host app[1]: ERROR первая беда');
  });

  it('прочитанный пустой журнал раздела не печатает', async () => {
    respondWith([[syslog, '']]);

    expect(await snapshot()).not.toContain('RECENT ERRORS');
  });

  /**
   * Под sudo журнал доступнее, но там, где sudo нет вовсе (root на BusyBox),
   * первая попытка падает целиком — и причина звучала бы «не прошло».
   */
  it('когда sudo не сработал, журнал спрашивают ещё раз без него', async () => {
    const asked: Array<boolean | undefined> = [];
    executeMock.mockImplementation(async (_config: unknown, command: string, options: any) => {
      if (!syslog.test(String(command))) {
        return { stdout: '', stderr: '', exitCode: 0, truncated: false };
      }
      asked.push(options?.sudo);
      return options?.sudo
        ? { stdout: '', stderr: 'sudo: not found', exitCode: 127, truncated: false }
        : { stdout: 'NO_SYSLOG', stderr: '', exitCode: 0, truncated: false };
    });

    const text = await snapshot();

    expect(asked).toEqual([true, undefined]);
    expect(text).toContain('NOT CHECKED: no /var/log/syslog on the server');
  });
});

/** Сорванная проверка службы — не остановленная служба */
describe('ssh_snapshot: служба, о которой не спросили', () => {
  it('пустой ответ про службу печатается как непроверенная', async () => {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      const text = String(command);
      if (/command -v systemctl/.test(text)) {
        return { stdout: 'yes', stderr: '', exitCode: 0, truncated: false };
      }
      if (/is-active nginx/.test(text)) {
        return { stdout: '', stderr: '', exitCode: 255, truncated: false };
      }
      if (/is-active/.test(text)) {
        return { stdout: 'inactive', stderr: '', exitCode: 0, truncated: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    });

    const text = await snapshot();

    expect(text).toMatch(/nginx\s+\?\s+NOT CHECKED/);
  });
});
