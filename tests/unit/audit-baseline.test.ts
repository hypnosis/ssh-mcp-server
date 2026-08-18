/**
 * Unit tests: что `ssh_audit_baseline` вычитывает из ответа сервера.
 *
 * Инструмент собирает один ответ из пятнадцати команд и сам решает, что в нём
 * тревога, что норма, а что проверить было нечем. Наружу уходит текст: сводка
 * для чтения и следом полная структура. Проверяется и то и другое — структура
 * отвечает за разбор, текст за то, что агент увидит.
 *
 * Образцы вывода настоящие: `df -hT`, `free -h`, `ss -tulpenH`, `netstat -tulpn`
 * отличаются набором колонок, и разбор обязан узнавать каждый.
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
}));

const { AuditTool } = await import('../../src/tools/audit-tool.js');

/** Тот же разделитель, которым инструмент режет общий ответ на разделы */
const SEP = '__SSH_MCP_AUDIT_SEP__';

/**
 * Сервер отвечает на то, что у него спросили: заголовок раздела печатает сама
 * команда, поэтому раздел, которого в ней нет, не появится и в ответе. Мок,
 * отвечающий заготовкой независимо от команды, прощал бы потерянный раздел.
 */
async function baseline(
  sections: Record<string, string>,
  args: Record<string, unknown> = {}
): Promise<string> {
  executeMock.mockImplementation(async (_config: unknown, command: string) => {
    const asked = [...String(command).matchAll(new RegExp(`echo "${SEP}([a-z_]*)${SEP}"`, 'g'))];
    const stdout = asked
      .map(([, key]) => `${SEP}${key}${SEP}\n${sections[key] ?? ''}`)
      .join('\n');

    return { stdout, stderr: '', exitCode: 0, truncated: false };
  });

  const response = await new AuditTool().handleCall({
    params: { name: 'ssh_audit_baseline', arguments: args },
  } as CallToolRequest);

  return response.content[0].text;
}

/** Разобранная структура из хвоста ответа */
function structure(text: string): any {
  const [, json] = text.split('--- raw JSON ---');
  return JSON.parse(json);
}

/** Команда, уехавшая на сервер */
function sentCommand(): string {
  return String(executeMock.mock.calls[0][1]);
}

/** Настоящий вывод `df -hT`: две годные строки, псевдо-ФС и точка с пробелом */
const DF_OUTPUT = [
  'Filesystem     Type      Size  Used Avail Use% Mounted on',
  '/dev/sda1      ext4       50G   45G  2.5G  95% /',
  'tmpfs          tmpfs     3.9G     0  3.9G   0% /dev/shm',
  'devtmpfs       devtmpfs  3.9G     0  3.9G   0% /dev',
  '/dev/loop0     squashfs   64M   64M     0 100% /snap/core',
  '/dev/sdb1      ext4      100G   60G   35G  64% /mnt/my data',
].join('\n');

const FREE_OUTPUT = [
  '              total        used        free      shared  buff/cache   available',
  'Mem:           7.8Gi       2.1Gi       1.2Gi       200Mi       4.5Gi       5.2Gi',
  'Swap:          2.0Gi          0B       2.0Gi',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ssh_audit_baseline: разбор диска', () => {
  it('берёт из строки df размер, занятое, остаток и долю', async () => {
    const disk = structure(await baseline({ df: DF_OUTPUT })).disk;

    expect(disk[0]).toEqual({
      filesystem: '/dev/sda1',
      size: '50G',
      used: '45G',
      avail: '2.5G',
      pct: 95,
      mount: '/',
    });
  });

  it.each([
    ['tmpfs', '/dev/shm'],
    ['devtmpfs', '/dev'],
    ['squashfs', '/snap/core'],
  ])('%s не считается диском сервера', async (_type, mount) => {
    const disk = structure(await baseline({ df: DF_OUTPUT })).disk;

    expect(disk.map((d: any) => d.mount)).not.toContain(mount);
  });

  it('точка монтирования с пробелом собирается целиком, а не обрывается', async () => {
    const disk = structure(await baseline({ df: DF_OUTPUT })).disk;

    expect(disk.map((d: any) => d.mount)).toContain('/mnt/my data');
  });

  it('строка из одних пробелов диском не считается', async () => {
    const withBlank = `Filesystem Type Size Used Avail Use% Mounted on\n    \n/dev/sda1 ext4 50G 45G 2.5G 95% /`;

    expect(structure(await baseline({ df: withBlank })).disk).toHaveLength(1);
  });

  it('строка без всех колонок пропускается, а не даёт запись с пустотами', async () => {
    const cut = `Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 50G`;

    expect(structure(await baseline({ df: cut })).disk).toEqual([]);
  });

  it('нечитаемая доля становится нулём, а не NaN в ответе', async () => {
    const odd = `Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 50G 45G 2.5G  -  /`;

    expect(structure(await baseline({ df: odd })).disk[0].pct).toBe(0);
  });
});

describe('ssh_audit_baseline: пороги заполнения диска', () => {
  const dfAt = (pct: number) =>
    `Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 50G 45G 2.5G ${pct}% /data`;

  it.each([
    [90, 'critical'],
    [95, 'critical'],
  ])('%i%% — тревога', async (pct) => {
    const flags = structure(await baseline({ df: dfAt(pct) })).red_flags;

    expect(flags.critical).toContain(`/data disk ${pct}% full`);
  });

  it.each([
    [70, 'warning'],
    [89, 'warning'],
  ])('%i%% — предупреждение, но не тревога', async (pct) => {
    const flags = structure(await baseline({ df: dfAt(pct) })).red_flags;

    expect(flags.warning).toContain(`/data disk ${pct}% full`);
    expect(flags.critical).toEqual([]);
  });

  it('69% — норма: ни тревоги, ни предупреждения', async () => {
    const flags = structure(await baseline({ df: dfAt(69) })).red_flags;

    expect(flags.ok).toContain('/data disk 69%');
    expect(flags.warning).toEqual([]);
    expect(flags.critical).toEqual([]);
  });
});

describe('ssh_audit_baseline: вывод устройства', () => {
  /** Роутер вставляет стирание строки между разделами и внутри значений */
  it('стирание строки не приезжает частью значения', async () => {
    const parsed = structure(await baseline({ hostname: `\u001B[Krouter-1\u001B[K` }));

    expect(parsed.hostname).toBe('router-1');
  });
});

describe('ssh_audit_baseline: разбор памяти', () => {
  it('доступное берётся из последней колонки, а не из третьей', async () => {
    const memory = structure(await baseline({ free: FREE_OUTPUT })).memory;

    expect(memory).toEqual({
      total: '7.8Gi',
      used: '2.1Gi',
      free: '1.2Gi',
      available: '5.2Gi',
    });
  });

  it('незнакомый формат вывода отвечает «n/a», а не выдуманными числами', async () => {
    const memory = structure(await baseline({ free: 'Pages free: 12345.' })).memory;

    expect(memory).toEqual({ total: 'n/a', used: 'n/a', free: 'n/a', available: 'n/a' });
  });
});

describe('ssh_audit_baseline: разбор слушающих сокетов', () => {
  it('узнаёт адрес в выводе ss, где он пятой колонкой', async () => {
    const ss = 'tcp   LISTEN 0      128    0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=700,fd=3))';
    const listeners = structure(await baseline({ listeners: ss })).net.listeners;

    expect(listeners).toHaveLength(1);
    expect(listeners[0].proto).toBe('tcp');
    expect(listeners[0].address).toBe('0.0.0.0:22');
  });

  it('узнаёт адрес в выводе netstat, где он четвёртой колонкой', async () => {
    const netstat = [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      700/sshd',
    ].join('\n');
    const listeners = structure(await baseline({ listeners: netstat })).net.listeners;

    expect(listeners).toHaveLength(1);
    expect(listeners[0].address).toBe('0.0.0.0:22');
  });

  it('шапка netstat не превращается в слушающий сокет', async () => {
    const header =
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name';
    const listeners = structure(await baseline({ listeners: header })).net.listeners;

    expect(listeners).toEqual([]);
  });

  /**
   * Колонки выровнены пробелами, и их там не по одному. Разбор по одиночному
   * пробелу оставил бы пустые колонки, а хвост записи собрался бы с дырами.
   */
  it('выравнивание пробелами не оставляет дыр в хвосте записи', async () => {
    const netstat = 'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      700/sshd';
    const listeners = structure(await baseline({ listeners: netstat })).net.listeners;

    expect(listeners[0].pid_program).toBe('0.0.0.0:* LISTEN 700/sshd');
  });

  it('хвост записи начинается сразу за адресом', async () => {
    const ss = 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700))';
    const listeners = structure(await baseline({ listeners: ss })).net.listeners;

    expect(listeners[0].pid_program).toBe('0.0.0.0:* users:(("sshd",pid=700))');
  });

  it('длинный хвост обрезается по восьмидесяти знакам', async () => {
    const long = 'x'.repeat(200);
    const ss = `tcp LISTEN 0 128 0.0.0.0:22 ${long}`;
    const listeners = structure(await baseline({ listeners: ss })).net.listeners;

    expect(listeners[0].pid_program).toHaveLength(80);
  });

  it('запись ровно из пяти колонок считается сокетом', async () => {
    const ss = 'tcp LISTEN 0 128 0.0.0.0:22';
    const listeners = structure(await baseline({ listeners: ss })).net.listeners;

    expect(listeners).toHaveLength(1);
  });

  it('строка из одних пробелов сокетом не считается', async () => {
    const listeners = structure(await baseline({ listeners: '     \ntcp LISTEN 0 128 0.0.0.0:22' }))
      .net.listeners;

    expect(listeners).toHaveLength(1);
  });
});

describe('ssh_audit_baseline: «проверить нечем» отделяется от «ничего нет»', () => {
  it('сервер без ss и netstat отвечает пометкой, а не пустым списком молча', async () => {
    const text = await baseline({ listeners: 'NO_NET_TOOL' });

    expect(text).toContain('NOT CHECKED:');
    expect(structure(text).unavailable).toContain(
      'listeners (neither ss nor netstat on the server)'
    );
  });

  it('df, не отдавший ничего, попадает в непроверенное', async () => {
    const text = await baseline({ df: '' });

    expect(structure(text).unavailable).toContain('disk (df gave no output)');
  });

  it('живые сокеты в непроверенное не попадают', async () => {
    const ss = 'tcp   LISTEN 0      128    0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=700))';
    const unavailable = structure(
      await baseline({
        hostname: 'web-1',
        running_count: '12',
        df: DF_OUTPUT,
        listeners: ss,
        ufw: 'NO_UFW',
        iptables: 'NO_IPTABLES',
        sshd: 'port 22\npasswordauthentication no',
      })
    ).unavailable;

    expect(unavailable).toEqual([]);
  });
});

describe('ssh_audit_baseline: настройки sshd', () => {
  /** `include_sudo_sections` меняет способ чтения конфига, а не наличие раздела */
  const sshd = (lines: string[]) =>
    baseline({ sshd: lines.join('\n') }, { include_sudo_sections: true });

  it('вход root по паролю — тревога', async () => {
    const flags = structure(await sshd(['permitrootlogin yes', 'port 22'])).red_flags;

    expect(flags.critical).toContain('PermitRootLogin yes');
  });

  it('пароль на 22 порту — тревога', async () => {
    const flags = structure(await sshd(['port 22', 'passwordauthentication yes'])).red_flags;

    expect(flags.critical).toContain('PasswordAuthentication yes');
  });

  it('тот же пароль на нестандартном порту — тоже тревога', async () => {
    const flags = structure(await sshd(['port 2222', 'passwordauthentication yes'])).red_flags;

    expect(flags.critical).toContain('PasswordAuthentication yes');
  });

  it('пароль запрещён — флага нет ни на каком порту', async () => {
    const flags = structure(await sshd(['port 22', 'passwordauthentication no'])).red_flags;

    expect(flags.critical.join(' ')).not.toContain('PasswordAuthentication');
  });

  it('порт в текст флага не попадает: настройка и порт — разные источники', async () => {
    const flags = structure(await sshd(['port 22', 'passwordauthentication yes'])).red_flags;

    expect(flags.critical.join(' ')).not.toContain('on port');
  });

  /*
   * Разрешением считается только точное `yes`. Значение, где `yes` стоит краем,
   * не разрешение: иначе тревога зависит от того, каким концом слово легло.
   */
  it('значение, оканчивающееся на yes, разрешением не считается', async () => {
    const flags = structure(
      await sshd(['port 22', 'passwordauthentication noyes', 'permitrootlogin maybe-yes'])
    ).red_flags;

    expect(flags.critical).toEqual([]);
  });

  it('значение, начинающееся с yes, разрешением тоже не считается', async () => {
    const flags = structure(
      await sshd(['port 22', 'passwordauthentication yes-please', 'permitrootlogin yes-with-key'])
    ).red_flags;

    expect(flags.critical).toEqual([]);
  });

  it('вход root по ключу тревогой не считается', async () => {
    const parsed = structure(await sshd(['permitrootlogin prohibit-password', 'port 22']));

    expect(parsed.ssh.permit_root_login).toBe('prohibit-password');
    expect(parsed.red_flags.critical).toEqual([]);
  });

  it('настройки читаются каждая по своему имени', async () => {
    const parsed = structure(
      await sshd([
        'port 2222',
        'permitrootlogin no',
        'passwordauthentication no',
        'pubkeyauthentication yes',
      ])
    );

    expect(parsed.ssh).toEqual({
      port: '2222',
      permit_root_login: 'no',
      password_auth: 'no',
      pubkey_auth: 'yes',
    });
  });

  it('настройка, которой в выводе нет, остаётся пустой', async () => {
    const parsed = structure(await sshd(['port 22']));

    expect(parsed.ssh.permit_root_login).toBe('');
    expect(parsed.ssh.pubkey_auth).toBe('');
  });

  it('без раздела sshd раздела нет и в ответе', async () => {
    expect(structure(await baseline({ df: DF_OUTPUT })).ssh).toBeUndefined();
  });
});

describe('ssh_audit_baseline: docker', () => {
  const psLine = (status: string, name: string) => `abc123\tnginx:latest\t${status}\t${name}`;

  it('разбирает список контейнеров по табуляции', async () => {
    const docker = structure(
      await baseline({ docker_ps: psLine('Up 3 days', 'web') })
    ).docker;

    expect(docker.containers[0]).toEqual({
      id: 'abc123',
      image: 'nginx:latest',
      status: 'Up 3 days',
      names: 'web',
    });
  });

  it('остановленные контейнеры называются поимённо в предупреждении', async () => {
    const ps = [psLine('Up 3 days', 'web'), psLine('Exited (1) 2 hours ago', 'worker')].join('\n');
    const flags = structure(await baseline({ docker_ps: ps })).red_flags;

    expect(flags.warning).toContain('1 exited container(s): worker');
  });

  it('несколько остановленных перечисляются через запятую', async () => {
    const ps = [
      psLine('Exited (1) 2 hours ago', 'worker'),
      psLine('Exited (0) 3 days ago', 'cron'),
    ].join('\n');
    const flags = structure(await baseline({ docker_ps: ps })).red_flags;

    expect(flags.warning).toContain('2 exited container(s): worker, cron');
  });

  it('когда все контейнеры на ходу, предупреждения нет', async () => {
    const ps = [psLine('Up 3 days', 'web'), psLine('Up 1 hour', 'db')].join('\n');
    const flags = structure(await baseline({ docker_ps: ps })).red_flags;

    expect(flags.warning).toEqual([]);
  });

  it('перевод строки в конце вывода не создаёт пустого контейнера', async () => {
    const docker = structure(await baseline({ docker_ps: `${psLine('Up 3 days', 'web')}\n\n` })).docker;

    expect(docker.containers).toHaveLength(1);
  });

  it('сервер без docker говорит об этом словами, а не пустым списком', async () => {
    const text = await baseline({ docker_ps: 'NO_DOCKER' });

    expect(text).toContain('docker: not installed or not accessible');
    expect(structure(text).docker).toBeNull();
  });
});

describe('ssh_audit_baseline: службы и обновления', () => {
  it('упавшие службы называются поимённо', async () => {
    const failed = 'nginx.service loaded failed failed A high performance web server';
    const parsed = structure(await baseline({ failed, running_count: '12' }));

    expect(parsed.services.failed).toEqual(['nginx.service']);
    expect(parsed.red_flags.warning).toContain('failed units: nginx.service');
  });

  it('несколько упавших служб перечисляются через запятую', async () => {
    const failed = ['nginx.service loaded failed failed Web server', 'redis.service loaded failed failed Redis'].join('\n');
    const parsed = structure(await baseline({ failed, running_count: '12' }));

    expect(parsed.services.failed).toEqual(['nginx.service', 'redis.service']);
    expect(parsed.red_flags.warning).toContain('failed units: nginx.service, redis.service');
  });

  it('счётчик работающих служб — число, а не строка', async () => {
    expect(structure(await baseline({ running_count: '42' })).services.running_count).toBe(42);
  });

  it('сорванный счёт не выдаётся за «служб ноль»', async () => {
    const parsed = structure(await baseline({ running_count: 'wc: not found' }));

    expect(parsed.services).toBeUndefined();
    expect(parsed.unavailable).toContain('services (systemd did not answer on this server)');
  });

  // Перевод строки в конце — то, как маркер приходит с сервера на самом деле
  it('нет systemctl — раздела служб нет, а причина названа', async () => {
    const parsed = structure(
      await baseline({ failed: 'NO_SYSTEMCTL\n', running_count: 'NO_SYSTEMCTL\n' })
    );

    expect(parsed.services).toBeUndefined();
    expect(parsed.unavailable).toContain('services (no systemctl on the server)');
    // Предупреждение о том, чего не проверяли, — тот же ложный факт
    expect(parsed.red_flags.warning).toEqual([]);
  });

  it('systemctl есть, но systemd не ответил — это не «служб ноль»', async () => {
    const refusal =
      'System has not been booted with systemd as init system (PID 1). Can\'t operate.\n' +
      'Failed to connect to bus: Host is down';
    const parsed = structure(await baseline({ failed: refusal, running_count: refusal }));

    expect(parsed.services).toBeUndefined();
    expect(parsed.unavailable).toContain('services (systemd did not answer on this server)');
  });

  it('рабочий systemd отвечает разделом, как раньше', async () => {
    const parsed = structure(
      await baseline({ failed: '', running_count: '17' })
    );

    expect(parsed.services).toEqual({ failed: [], running_count: 17 });
    expect(parsed.unavailable.join(' ')).not.toContain('services');
  });

  it('нет apt — раздела обновлений нет, а причина названа', async () => {
    const parsed = structure(await baseline({ upgradable: 'NO_APT\n' }));

    expect(parsed.updates).toBeUndefined();
    expect(parsed.unavailable).toContain('updates (no apt on the server)');
    expect(parsed.red_flags.warning).toEqual([]);
  });

  it('apt отвечает нулём — это факт, а не «нечем проверить»', async () => {
    const parsed = structure(await baseline({ upgradable: '0', reboot_required: 'NO' }));

    expect(parsed.updates).toEqual({ upgradable: 0, reboot_required: false });
    expect(parsed.unavailable.join(' ')).not.toContain('updates');
  });

  it('ожидающая перезагрузка — предупреждение', async () => {
    const parsed = structure(await baseline({ reboot_required: 'YES' }));

    expect(parsed.updates.reboot_required).toBe(true);
    expect(parsed.red_flags.warning).toContain('reboot-required pending');
  });

  it('без ожидающей перезагрузки предупреждения нет', async () => {
    const parsed = structure(await baseline({ reboot_required: 'NO' }));

    expect(parsed.updates.reboot_required).toBe(false);
    expect(parsed.red_flags.warning).not.toContain('reboot-required pending');
  });

  it.each([
    [51, true],
    [50, false],
  ])('%i пакетов к обновлению — предупреждение: %s', async (count, warned) => {
    const flags = structure(await baseline({ upgradable: String(count) })).red_flags;

    expect(flags.warning.includes(`${count} upgradable packages`)).toBe(warned);
  });
});

describe('ssh_audit_baseline: сборка команды', () => {
  it('sshd спрашивается и без sudo: под root он читается и так', async () => {
    await baseline({ df: DF_OUTPUT });

    expect(sentCommand()).toContain('sshd -T');
    expect(executeMock.mock.calls[0][2].sudo).toBe(false);
  });

  it('просьба о правах поднимает sudo, а не добавляет раздел', async () => {
    await baseline({ df: DF_OUTPUT }, { include_sudo_sections: true });

    expect(sentCommand()).toContain('sshd -T');
    expect(executeMock.mock.calls[0][2].sudo).toBe(true);
  });

  it('выбранный раздел уезжает один, без остальных', async () => {
    await baseline({ df: DF_OUTPUT }, { include: ['disk'] });

    expect(sentCommand()).toContain('df -hT');
    expect(sentCommand()).not.toContain('free -h');
  });

  /**
   * Каждый раздел — своя команда. Пропавшая незаметна: отчёт просто скажет,
   * что данных нет, и это прочтётся как «на сервере ничего такого нет».
   */
  it.each([
    ['имя машины', 'hostname'],
    ['время работы', 'uptime'],
    ['время сервера', 'date -u'],
    ['название системы', '/etc/os-release'],
    ['ядро', 'uname -r'],
    ['нагрузку', '/proc/loadavg'],
    ['диски', 'df -hT'],
    ['память', 'free -h'],
    ['сокеты', 'ss -tulpenH'],
    ['интерфейсы', 'ip -br a'],
    ['упавшие службы', 'systemctl --failed'],
    ['счёт работающих', '--state=running'],
    ['контейнеры', 'docker ps -a'],
    ['межсетевой экран', 'ufw status'],
    ['правила iptables', 'iptables -nL'],
    ['обновления', 'apt list --upgradable'],
    ['ожидание перезагрузки', 'reboot-required'],
  ])('спрашивает %s', async (_what, fragment) => {
    await baseline({});

    expect(sentCommand()).toContain(fragment);
  });

  it('запасной путь для каждой команды уезжает вместе с ней', async () => {
    await baseline({});

    expect(sentCommand()).toContain('netstat -tulpn');
    expect(sentCommand()).toContain('ifconfig');
  });

  it('маркер отсутствия сетевых утилит уезжает вместе с командой', async () => {
    await baseline({ df: DF_OUTPUT }, { include: ['net'] });

    expect(sentCommand()).toContain('NO_NET_TOOL');
  });

  /** Маркер нужен обеим командам раздела: без него молчит та, у которой его нет */
  it('маркер отсутствия systemctl уезжает с обеими командами служб', async () => {
    await baseline({}, { include: ['services'] });

    expect(sentCommand().match(/NO_SYSTEMCTL/g)).toHaveLength(2);
  });

  it('маркер отсутствия apt уезжает вместе с командой обновлений', async () => {
    await baseline({}, { include: ['updates'] });

    expect(sentCommand()).toContain('NO_APT');
  });

  /**
   * Отказ systemd приходит в поток ошибок: заглушить его значит получить тот же
   * пустой ответ, что и у сервера, где ни одна служба не запущена.
   */
  it('ответ systemd не глушится, иначе отказ неотличим от пустого списка', async () => {
    await baseline({}, { include: ['services'] });

    expect(sentCommand()).toContain('systemctl --failed --no-legend --plain 2>&1');
    expect(sentCommand()).toContain('--state=running --no-legend --plain 2>&1');
  });

  /**
   * Три исхода различает сама команда, а не разбор: утилиты нет, утилита есть и
   * ответила, утилита есть и отказала. Замерено на BusyBox, coreutils и dropbear.
   */
  it('команда служб различает три исхода прямо на сервере', async () => {
    await baseline({}, { include: ['services'] });
    const command = sentCommand();

    // Наличие проверяют обе команды раздела, а не одна из них
    expect(command.match(/command -v systemctl >\/dev\/null 2>&1/g)).toHaveLength(2);
    // Счёт идёт только по удавшемуся ответу…
    expect(command).toContain('grep -c .');
    // …а отказ уезжает своим текстом, чтобы его узнали по нему
    expect(command).toContain('else printf \'%s\\n\' "$out"; fi');
  });

  it('команда обновлений спрашивает apt только там, где он есть', async () => {
    await baseline({}, { include: ['updates'] });

    expect(sentCommand()).toContain('command -v apt >/dev/null 2>&1');
  });
});

describe('ssh_audit_baseline: краткий и полный вид', () => {
  const manyListeners = Array.from(
    { length: 20 },
    (_, index) => `tcp LISTEN 0 128 0.0.0.0:${1000 + index} 0.0.0.0:* users:(("app",pid=${index}))`
  ).join('\n');

  it('краткий вид печатает пятнадцать сокетов и считает остальные', async () => {
    const text = await baseline({ listeners: manyListeners });

    expect(text).toContain('listeners (20):');
    expect(text).toContain('... +5 more');
  });

  it('полный вид печатает все и ничего не досчитывает', async () => {
    const text = await baseline({ listeners: manyListeners }, { compact: false });

    expect(text).not.toContain('more');
  });
});

describe('ssh_audit_baseline: системные поля', () => {
  /**
   * Отступы слева команды оставляют охотно (`uptime` — всегда), а разделы
   * режутся только справа. Поэтому у каждого поля своя обрезка, и проверять
   * её надо у каждого: на вылизанном тексте она незаметна.
   */
  it('каждое поле берётся из своего раздела и приходит без отступов', async () => {
    const parsed = structure(
      await baseline({
        hostname: '  web-01  ',
        uptime: ' 10:32:11 up 42 days,  3:14,  1 user',
        date_utc: '  Fri Aug  7 19:32:11 UTC 2026',
        os: '  Debian GNU/Linux 12 (bookworm)',
        kernel: '  6.1.0-18-amd64',
        load: '  0.15 0.22 0.19 1/512 30412',
      })
    );

    expect(parsed).toMatchObject({
      hostname: 'web-01',
      uptime: '10:32:11 up 42 days,  3:14,  1 user',
      date_utc: 'Fri Aug  7 19:32:11 UTC 2026',
      os: 'Debian GNU/Linux 12 (bookworm)',
      kernel: '6.1.0-18-amd64',
      load: '0.15 0.22 0.19 1/512 30412',
    });
  });

  /**
   * Раздел, которого в ответе нет, обязан остаться пустым: выдуманное значение
   * тут неотличимо от настоящего — агент прочитает его как факт о сервере.
   */
  /**
   * Замерено на роутере с вендорской оболочкой: его CLI не выполняет ни одной команды
   * раздела, и все поля приходят пустыми. Ни одна служба и ни одного имени —
   * это утверждение о машине, поэтому раздел, ничего не приславший, обязан
   * попасть в «нечем проверить», а не разложиться нулями.
   */
  it('разделы, которых сервер не прислал, за факты не выдаются', async () => {
    const parsed = structure(await baseline({}));

    expect(parsed.services, 'счёт служб без ответа сервера').toBeUndefined();
    expect(parsed.unavailable).toContain('system (the section produced no output)');
    expect(parsed.unavailable).toContain('services (the services section produced no output)');
    expect(parsed.disk).toEqual([]);
    expect(parsed.net.listeners).toEqual([]);
  });

  it('пустой ответ целиком — это «нечем проверить», а не «всё в порядке»', async () => {
    const parsed = structure(await baseline({}));

    expect(parsed.unavailable).toEqual([
      'system (the section produced no output)',
      'disk (df gave no output)',
      'listeners (neither ss nor netstat on the server)',
      'services (the services section produced no output)',
      'firewall/ufw (installed, but its status is not readable — needs sudo?)',
      'firewall/iptables (installed, but its rules are not readable — needs sudo?)',
      'sshd config (sshd -T gave no output — run with include_sudo_sections: true)',
    ]);
    expect(parsed.red_flags).toEqual({ critical: [], warning: [], ok: [] });
  });
});

describe('ssh_audit_baseline: сетевые интерфейсы', () => {
  it('пустые строки вывода интерфейсом не считаются', async () => {
    const interfaces = 'lo   UNKNOWN  127.0.0.1/8\n\neth0 UP  10.0.0.5/24\n';
    const parsed = structure(await baseline({ interfaces }));

    expect(parsed.net.interfaces).toEqual(['lo   UNKNOWN  127.0.0.1/8', 'eth0 UP  10.0.0.5/24']);
  });

  it('краткий вид оставляет десять интерфейсов', async () => {
    const many = Array.from({ length: 15 }, (_, index) => `eth${index} UP 10.0.0.${index}/24`).join('\n');

    expect(structure(await baseline({ interfaces: many })).net.interfaces).toHaveLength(10);
  });

  it('полный вид оставляет все', async () => {
    const many = Array.from({ length: 15 }, (_, index) => `eth${index} UP 10.0.0.${index}/24`).join('\n');
    const parsed = structure(await baseline({ interfaces: many }, { compact: false }));

    expect(parsed.net.interfaces).toHaveLength(15);
  });
});

describe('ssh_audit_baseline: межсетевой экран', () => {
  it('состояние ufw читается из его же вывода', async () => {
    const text = await baseline({ ufw: 'Status: active\nLogging: on (low)' });

    expect(text).toContain('ufw=active');
  });

  it('выключенный ufw не выдаётся за включённый', async () => {
    expect(await baseline({ ufw: 'Status: inactive' })).toContain('ufw=inactive');
  });

  /**
   * Три исхода у каждого экрана, и смешивать их нельзя: сервера без ufw и
   * сервера с выключенным ufw защищают разные вещи, а «посмотреть не дали» —
   * вообще не утверждение о сервере.
   */
  it('отсутствие ufw не выдаётся за выключенный', async () => {
    const text = await baseline({ ufw: 'NO_UFW' });

    expect(text).toContain('ufw=not installed');
    expect(structure(text).firewall.ufw.status).toBe('not_installed');
  });

  it('отказ по правам не выдаётся за выключенный', async () => {
    const text = await baseline({ ufw: 'NO_UFW_ACCESS' });

    expect(text).toContain('ufw=NOT CHECKED');
    expect(structure(text).unavailable).toContain(
      'firewall/ufw (installed, but its status is not readable — needs sudo?)'
    );
  });

  it('отсутствие iptables не выдаётся за пустой набор правил', async () => {
    const text = await baseline({ iptables: 'NO_IPTABLES' });

    expect(text).toContain('iptables=not installed');
    expect(structure(text).firewall.iptables.status).toBe('not_installed');
  });

  /**
   * Хвост, оставшийся от сервера, виден только здесь: остальные поля проходят
   * через собственную обрезку и прощают её пропажу в разборе разделов.
   */
  it('перевод строки от сервера не прилипает к значению', async () => {
    expect(structure(await baseline({ ufw: 'Status: active\n' })).firewall.ufw.text).toBe(
      'Status: active'
    );
  });

  it('краткий вид оставляет от вывода ufw двенадцать строк', async () => {
    const long = Array.from({ length: 20 }, (_, index) => `rule ${index}`).join('\n');

    expect(structure(await baseline({ ufw: long })).firewall.ufw.text.split('\n')).toHaveLength(12);
  });

  it('полный вид ufw не режет', async () => {
    const long = Array.from({ length: 20 }, (_, index) => `rule ${index}`).join('\n');
    const parsed = structure(await baseline({ ufw: long }, { compact: false }));

    expect(parsed.firewall.ufw.text.split('\n')).toHaveLength(20);
  });

  it('счётчик правил iptables — число', async () => {
    expect(structure(await baseline({ iptables: '37' })).firewall.iptables.rules).toBe(37);
  });

  it('нечитаемый счётчик правил — это «нечем проверить», а не ноль правил', async () => {
    const parsed = structure(await baseline({ iptables: 'permission denied' }));

    expect(parsed.firewall.iptables).toEqual({ status: 'no_access' });
  });
});

describe('ssh_audit_baseline: сводка для чтения', () => {
  /**
   * Сводка сверяется целиком. По кускам её не проверяет никто: отступы,
   * пустые строки между разделами и ширина колонок держатся на честном слове,
   * а читает эту сводку агент — и решает по ней, что с сервером не так.
   */
  it('печатается заголовками, отступами и колонками, а не как придётся', async () => {
    const text = await baseline({
      hostname: 'web-01',
      os: 'Debian GNU/Linux 12',
      kernel: '6.1.0-18-amd64',
      uptime: 'up 1 day',
      date_utc: 'Fri Aug  7 19:32:11 UTC 2026',
      load: '0.15 0.22 0.19',
      df: 'Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 50G 45G 2.5G 95% /',
      free: FREE_OUTPUT,
      listeners: 'tcp LISTEN 0 128 0.0.0.0:22 sshd',
      sshd: 'port 22\npermitrootlogin prohibit-password\npasswordauthentication no\npubkeyauthentication yes',
      running_count: '42',
      docker_ps: 'NO_DOCKER',
      ufw: 'Status: active',
      iptables: '37',
      upgradable: '3',
      reboot_required: 'NO',
    });

    expect(text.split('--- raw JSON ---')[0]).toBe(
      [
        '=== ssh_audit_baseline ===',
        'host:    web-01',
        'os:      Debian GNU/Linux 12',
        'kernel:  6.1.0-18-amd64',
        'uptime:  up 1 day',
        'date:    Fri Aug  7 19:32:11 UTC 2026',
        'load:    0.15 0.22 0.19',
        '',
        'CRITICAL:',
        '  - / disk 95% full',
        '',
        'disk:',
        '  /: 45G/50G (95%)',
        '',
        'memory: total=7.8Gi used=2.1Gi avail=5.2Gi',
        '',
        'listeners (1):',
        '  tcp   0.0.0.0:22                   sshd',
        '',
        'sshd:',
        '  port=22 root=prohibit-password pwauth=no pubkey=yes',
        '',
        'services: running=42, failed=0',
        '',
        'docker: not installed or not accessible',
        '',
        'firewall: ufw=active, iptables=37 rule line(s)',
        'updates:  upgradable=3, reboot_required=false',
        '',
        '',
      ].join('\n')
    );
  });

  /**
   * Второй вид той же сводки: тревожный. Блоки предупреждений, непроверенного
   * и живого docker печатаются только здесь, и спокойный сервер их не проверяет.
   */
  it('на тревожном сервере печатает все блоки, каждый на своём месте', async () => {
    const text = await baseline(
      {
        hostname: 'db-02',
        os: 'Alpine Linux v3.19',
        kernel: '6.6.0',
        uptime: 'up 3 days',
        date_utc: 'Fri Aug  7 19:32:11 UTC 2026',
        load: '2.5 2.1 1.8',
        df: 'Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 50G 38G 12G 75% /data',
        listeners: 'NO_NET_TOOL',
        sshd: 'port 22\npermitrootlogin yes',
        failed: 'redis.service loaded failed failed Redis',
        running_count: '7',
        docker_ps: 'a1\tnginx\tUp 3 days\tweb\nb2\tworker\tExited (1) 2 hours ago\tjob',
        ufw: 'Status: inactive',
        iptables: '0',
        upgradable: '60',
        reboot_required: 'YES',
      },
      { include_sudo_sections: true }
    );

    expect(text.split('--- raw JSON ---')[0]).toBe(
      [
        '=== ssh_audit_baseline ===',
        'host:    db-02',
        'os:      Alpine Linux v3.19',
        'kernel:  6.6.0',
        'uptime:  up 3 days',
        'date:    Fri Aug  7 19:32:11 UTC 2026',
        'load:    2.5 2.1 1.8',
        '',
        'CRITICAL:',
        '  - PermitRootLogin yes',
        '',
        'WARNING:',
        '  - /data disk 75% full',
        '  - 1 exited container(s): job',
        '  - failed units: redis.service',
        '  - reboot-required pending',
        '  - 60 upgradable packages',
        '',
        'NOT CHECKED:',
        '  - listeners (neither ss nor netstat on the server)',
        '  - firewall/iptables (installed, but its rules are not readable — needs sudo?)',
        '',
        'disk:',
        '  /data: 38G/50G (75%)',
        '',
        'memory: total=n/a used=n/a avail=n/a',
        '',
        'listeners (0):',
        '',
        'sshd:',
        '  port=22 root=yes pwauth= pubkey=',
        '',
        'services: running=7, failed=1',
        '  failed: redis.service',
        '',
        'docker: containers=2',
        `  ${'web'.padEnd(30)} ${'Up 3 days'.padEnd(20)} nginx`,
        `  ${'job'.padEnd(30)} ${'Exited (1) 2 hours ago'.padEnd(20)} worker`,
        '',
        'firewall: ufw=inactive, iptables=NOT CHECKED',
        'updates:  upgradable=60, reboot_required=true',
        '',
        '',
      ].join('\n')
    );
  });

  it('раздел sshd печатается только когда его спрашивали', async () => {
    const asked = await baseline(
      { sshd: 'port 2222\npermitrootlogin no\npasswordauthentication no\npubkeyauthentication yes' },
      { include_sudo_sections: true }
    );

    expect(asked).toContain('sshd:\n  port=2222 root=no pwauth=no pubkey=yes');
    expect(await baseline({})).not.toContain('sshd:');
  });

  it('упавшие службы печатаются отдельной строкой под счётчиком', async () => {
    const text = await baseline({
      failed: 'nginx.service loaded failed failed Web',
      running_count: '10',
    });

    expect(text).toContain('services: running=10, failed=1\n  failed: nginx.service');
  });

  it('живой docker печатается списком контейнеров', async () => {
    const text = await baseline({ docker_ps: 'abc\tnginx\tUp 3 days\tweb' });

    expect(text).toContain('docker: containers=1');
    expect(text).toContain('  web                            Up 3 days            nginx');
  });
});

describe('ssh_audit_baseline: разделы ответа', () => {
  it('раздел кончается там, где начинается следующий', async () => {
    const parsed = structure(
      await baseline({ hostname: 'web-01', os: 'Debian GNU/Linux 12', kernel: '6.1.0' })
    );

    expect(parsed.hostname).toBe('web-01');
    expect(parsed.os).toBe('Debian GNU/Linux 12');
  });

  it('последний раздел не теряется', async () => {
    expect(structure(await baseline({ hostname: 'web-01', load: '0.10 0.20 0.30' })).load).toBe(
      '0.10 0.20 0.30'
    );
  });

  it('ответ, в котором разделителей нет вовсе, не роняет инструмент', async () => {
    executeMock.mockResolvedValue({
      stdout: 'command not found',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const response = await new AuditTool().handleCall({
      params: { name: 'ssh_audit_baseline', arguments: {} },
    } as CallToolRequest);

    expect(response.content[0].text).toContain('=== ssh_audit_baseline ===');
  });
});
