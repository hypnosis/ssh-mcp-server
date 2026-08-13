/**
 * Unit tests: аудит не выдаёт «проверить нечем» за проверенный факт
 *
 * Все три случая пойманы живым смоуком на лаборатории, и все три выглядели
 * в отчёте как нормальный результат:
 *  - `df -hT -x tmpfs …` — BusyBox не знает `-x` и обрывается, вывод уходил
 *    в /dev/null, раздел диска оставался пустым, и сторож переполнения молчал
 *    на всём классе таких машин;
 *  - сервера без `ss` и `netstat` показывали «listeners (0)» — то есть
 *    «никто не слушает» вместо «смотреть было нечем»;
 *  - `ssh_tls_check` без openssl объявлял `CRITICAL: SAN does not include`
 *    о сертификате, которого не видел, — по такому отчёту сертификат идут
 *    перевыпускать.
 *
 * Мок здесь злее сервера намеренно: секции — дословные выводы контейнеров
 * лаборатории, вместе с текстами ошибок BusyBox и dash.
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
}));

const { AuditTool } = await import('../../src/tools/audit-tool.js');

const AUDIT_SEP = '__SSH_MCP_AUDIT_SEP__';
const TLS_SEP = '__SSH_MCP_TLS_SEP__';

/** Вывод сервера: секции в том же виде, в каком их склеивает составная команда */
const sectioned = (sep: string, sections: Record<string, string>): string =>
  Object.entries(sections)
    .map(([key, body]) => `${sep}${key}${sep}\n${body}`)
    .join('\n');

/** Разделы baseline, которых тест не касается */
const BASELINE_REST = {
  hostname: 'lab-host',
  uptime: '09:03:35 up 1 day',
  date_utc: 'Wed Aug  5 09:03:35 UTC 2026',
  os: 'Alpine Linux v3.20',
  kernel: '6.12.76-linuxkit',
  load: '0.55 0.66 0.76 1/776 3607',
  free: '              total        used        free\nMem:           7.7G        2.9G        2.9G',
  interfaces: 'eth0  UP  172.17.0.2/16',
  sshd: 'port 22\npermitrootlogin prohibit-password\npasswordauthentication no\npubkeyauthentication yes',
  failed: '',
  running_count: '0',
  docker_ps: 'NO_DOCKER',
  docker_df: 'NO_DOCKER',
  ufw: 'NO_UFW',
  iptables: 'NO_IPTABLES',
  upgradable: '0',
  reboot_required: 'NO',
};

/** Дословный `df -hT` из BusyBox: колонки те же, но заголовок «Available» */
const BUSYBOX_DF = [
  'Filesystem           Type            Size      Used Available Use% Mounted on',
  'overlay              overlay       487.1G      5.7G    456.7G   1% /',
  'tmpfs                tmpfs          64.0M         0     64.0M   0% /dev',
  'devtmpfs             devtmpfs       64.0M         0     64.0M   0% /dev/pts',
  '/run/host_mark/Users fakeowner       1.8T    866.1G    992.7G  47% /tmp/authkey',
].join('\n');

/** Дословный `netstat -tulpn` из BusyBox: две строки шапки перед данными */
const BUSYBOX_NETSTAT = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1/sshd -D -e',
  'tcp        0      0 :::22                   :::*                    LISTEN      1/sshd -D -e',
].join('\n');

/** `ss -tulpenH`: шапки нет, локальный адрес стоит в другой колонке */
const SS_OUTPUT = [
  'tcp   LISTEN 0      128    0.0.0.0:22   0.0.0.0:*    users:(("sshd",pid=1,fd=3))',
  'udp   UNCONN 0      0      0.0.0.0:68   0.0.0.0:*    users:(("dhclient",pid=9,fd=6))',
].join('\n');

const baseline = (over: Partial<Record<string, string>> = {}) =>
  sectioned(AUDIT_SEP, { ...BASELINE_REST, df: BUSYBOX_DF, listeners: BUSYBOX_NETSTAT, ...over });

const tls = (cert: string, renew = '') => sectioned(TLS_SEP, { cert, renew });

const call = (name: string, args: Record<string, unknown> = {}): CallToolRequest =>
  ({ params: { name, arguments: args } }) as CallToolRequest;

const answer = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const response = await new AuditTool().handleCall(call(name, args));
  return response.content.map((c: { text: string }) => c.text).join('\n');
};

/** Ответ сервера один и тот же на любую команду — состав задаёт тест */
const serverSays = (stdout: string) =>
  executeMock.mockImplementation(async () => ({ stdout, stderr: '', exitCode: 0 }));

/** Дата в том виде, в каком её печатает `openssl x509 -dates` */
const opensslDate = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toUTCString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ssh_audit_baseline: раздел диска на BusyBox', () => {
  it('команда df идёт без -x: BusyBox обрывается на этой опции', async () => {
    serverSays(baseline());

    await answer('ssh_audit_baseline');

    const command = executeMock.mock.calls[0][1] as string;
    expect(command).toContain('df -hT');
    expect(command).not.toContain('-x tmpfs');
  });

  it('разделы из вывода BusyBox доезжают до отчёта', async () => {
    serverSays(baseline());

    const text = await answer('ssh_audit_baseline');

    expect(text).toContain('/: 5.7G/487.1G (1%)');
    expect(text).toContain('/tmp/authkey: 866.1G/1.8T (47%)');
  });

  it('псевдофайловые системы отсеиваются, а корень контейнера остаётся', async () => {
    serverSays(baseline());

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.disk.map((d: { mount: string }) => d.mount)).toEqual(['/', '/tmp/authkey']);
    // overlay — это корень контейнера: отсечь его значило бы поменять одну
    // потерю данных на другую
    expect(result.disk[0].filesystem).toBe('overlay');
  });

  it('пустой df — это «нечем проверить», а не «дисков нет»', async () => {
    serverSays(baseline({ df: '' }));

    const text = await answer('ssh_audit_baseline');

    expect(text).toContain('NOT CHECKED:');
    expect(text).toContain('disk (df gave no output)');
  });

  it('заполненный диск остаётся поводом для тревоги', async () => {
    serverSays(
      baseline({
        df: 'Filesystem Type Size Used Available Use% Mounted on\n/dev/vda1 ext4 20G 19G 1G 95% /',
      })
    );

    const text = await answer('ssh_audit_baseline');

    expect(text).toContain('CRITICAL:');
    expect(text).toContain('/ disk 95% full');
    expect(text).not.toContain('NOT CHECKED');
  });

  it('том с длинным именем df переносит на две строки — запись собирается целиком', async () => {
    serverSays(
      baseline({
        df: [
          'Filesystem     Type      Size  Used Avail Use% Mounted on',
          'nfs-storage.internal.example.com:/export/media/library',
          '               nfs4      2.0T  1.7T  300G  85% /mnt/media',
        ].join('\n'),
      })
    );

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.disk).toHaveLength(1);
    expect(result.disk[0]).toMatchObject({
      filesystem: 'nfs-storage.internal.example.com:/export/media/library',
      mount: '/mnt/media',
      pct: 85,
    });
  });

  it('строка df чужого вида попадает в «нечем проверить»', async () => {
    serverSays(
      baseline({
        df: 'Filesystem Type Size Used Available Use% Mounted on\ndf: /mnt/cold: Permission denied',
      })
    );

    const text = await answer('ssh_audit_baseline');

    expect(text).toContain('disk row df printed in an unexpected shape: df: /mnt/cold: Permission denied');
  });
});

/**
 * У `free` из procps старше 2014 года колонки `available` нет вовсе, и
 * последней идёт `cached`: взятая по позиции, она выдавала кэш за свободную
 * память.
 */
describe('ssh_audit_baseline: показатели памяти', () => {
  const OLD_FREE = [
    '             total       used       free     shared    buffers     cached',
    'Mem:          7.7G       6.9G       800M        79M       120M       3.4G',
    '-/+ buffers/cache:       3.4G       4.3G',
    'Swap:         1.0G          0       1.0G',
  ].join('\n');

  const MODERN_FREE = [
    '               total        used        free      shared  buff/cache   available',
    'Mem:           7.7Gi       3.2Gi       3.3Gi        79Mi       1.5Gi       4.6Gi',
    'Swap:          1.0Gi          0B       1.0Gi',
  ].join('\n');

  it('free без колонки available не выдаёт кэш за доступную память', async () => {
    serverSays(baseline({ free: OLD_FREE }));

    const text = await answer('ssh_audit_baseline', { include: ['mem'] });

    expect(text).toContain('memory: total=7.7G used=6.9G avail=n/a');
    expect(text).not.toContain('avail=3.4G');
  });

  it('free с колонкой available читает именно её', async () => {
    serverSays(baseline({ free: MODERN_FREE }));

    const text = await answer('ssh_audit_baseline', { include: ['mem'] });

    expect(text).toContain('memory: total=7.7Gi used=3.2Gi avail=4.6Gi');
  });

  it('вывод без заголовка разбирается по порядку колонок', async () => {
    serverSays(baseline({ free: 'Mem:  7.7G  2.9G  2.9G' }));

    const text = await answer('ssh_audit_baseline', { include: ['mem'] });

    expect(text).toContain('memory: total=7.7G used=2.9G avail=n/a');
  });
});

describe('ssh_audit_baseline: слушающие сокеты', () => {
  it('шапка netstat не превращается в записи', async () => {
    serverSays(baseline());

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.net.listeners).toHaveLength(2);
    expect(result.net.listeners.map((l: { proto: string }) => l.proto)).toEqual(['tcp', 'tcp']);
  });

  it('у netstat берётся локальный адрес, а не адрес собеседника', async () => {
    serverSays(baseline());

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.net.listeners.map((l: { address: string }) => l.address)).toEqual([
      '0.0.0.0:22',
      ':::22',
    ]);
  });

  it('у ss локальный адрес стоит в своей колонке и тоже находится', async () => {
    serverSays(baseline({ listeners: SS_OUTPUT }));

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.net.listeners.map((l: { address: string }) => l.address)).toEqual([
      '0.0.0.0:22',
      '0.0.0.0:68',
    ]);
  });

  it('нет ни ss, ни netstat — раздел непроверен, а не пуст', async () => {
    serverSays(baseline({ listeners: 'NO_NET_TOOL' }));

    const text = await answer('ssh_audit_baseline');
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(text).toContain('NOT CHECKED:');
    expect(text).toContain('listeners (neither ss nor netstat on the server)');
    expect(result.net.listeners).toEqual([]);
  });

  it('маркер добавлен в саму команду: без него сервер молчит одинаково', async () => {
    serverSays(baseline());

    await answer('ssh_audit_baseline');

    expect(executeMock.mock.calls[0][1] as string).toContain('NO_NET_TOOL');
  });

  it('живые сокеты не помечаются непроверенными', async () => {
    serverSays(baseline());

    expect(await answer('ssh_audit_baseline')).not.toContain('NOT CHECKED');
  });
});

describe('ssh_tls_check: без сертификата нечего утверждать', () => {
  const CERT_OK = (days: number, san = 'DNS:example.com, DNS:www.example.com') =>
    [
      `notBefore=${opensslDate(-30)}`,
      `notAfter=${opensslDate(days)}`,
      'X509v3 Subject Alternative Name:',
      `    ${san}`,
      'issuer=C = US, O = Test CA, CN = Test',
    ].join('\n');

  it('openssl не установлен: UNKNOWN с причиной вместо CRITICAL', async () => {
    serverSays(tls('sh: openssl: not found'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('UNKNOWN: certificate not read');
    expect(text).toContain('openssl: not found');
    expect(text).not.toContain('CRITICAL');
  });

  it('соединение не встало: тоже UNKNOWN, а не приговор сертификату', async () => {
    serverSays(tls('connect: Connection refused\nunable to load certificate'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('UNKNOWN: certificate not read');
    expect(text).not.toContain('SAN does not include');
  });

  it('непрочитанный сертификат не выдаёт себя за проверенный в JSON', async () => {
    serverSays(tls(''));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });
    const result = JSON.parse(text.slice(text.indexOf('{')));

    expect(result.san_includes_hostname).toBeNull();
    expect(result.not_after).toBeNull();
  });

  it('stderr openssl доезжает до ответа, а не глохнет в /dev/null', async () => {
    serverSays(tls(''));

    await answer('ssh_tls_check', { domain: 'example.com' });

    // Только часть с openssl: у поиска renew-хука глушение stderr законно —
    // там `grep` по несуществующему каталогу это норма, а не потеря причины
    const command = executeMock.mock.calls[0][1] as string;
    const certPart = command.slice(0, command.indexOf(`${TLS_SEP}renew`));
    expect(certPart).toContain('-showcerts 2>&1');
    expect(certPart).not.toContain('2>/dev/null');
  });

  it('сертификат прочитан, а SAN чужой — это по-прежнему CRITICAL', async () => {
    serverSays(tls(CERT_OK(90, 'DNS:other.example.org')));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('CRITICAL: SAN does not include example.com');
    expect(text).not.toContain('UNKNOWN');
  });

  it('истёкший сертификат остаётся критикой', async () => {
    serverSays(tls(CERT_OK(-1)));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('CRITICAL: certificate EXPIRED');
  });

  it('срок на исходе остаётся предупреждением', async () => {
    serverSays(tls(CERT_OK(20)));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toMatch(/WARNING: expires in \d+ days/);
  });

  it('годный сертификат с нужным SAN не даёт ни одного флага о сертификате', async () => {
    serverSays(tls(CERT_OK(200), 'renew_hook = systemctl reload nginx'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).not.toContain('CRITICAL');
    expect(text).not.toContain('UNKNOWN');
  });

  it('мусор вместо даты — это не прочитанный сертификат', async () => {
    serverSays(tls('notAfter=не дата\nX509v3 Subject Alternative Name:\n    DNS:example.com'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('UNKNOWN: certificate not read');
  });
});

describe('ssh_tls_check: хук обновления', () => {
  const CERT = [
    `notBefore=${opensslDate(-30)}`,
    `notAfter=${opensslDate(200)}`,
    'X509v3 Subject Alternative Name:',
    '    DNS:example.com',
    'issuer=C = US, O = Test CA, CN = Test',
  ].join('\n');

  it('недоступный каталог не выдаётся за ненастроенный хук', async () => {
    serverSays(tls(CERT, 'LE_UNREADABLE'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('UNKNOWN: Let\'s Encrypt renewal config not readable');
    expect(text).not.toContain('WARNING: no Let\'s Encrypt deploy_hook configured');
    expect(JSON.parse(text.slice(text.indexOf('{'))).renew_hook_configured).toBeNull();
  });

  it('сервер без Let\'s Encrypt не обвиняется в потерянном хуке', async () => {
    serverSays(tls(CERT, 'NO_LETSENCRYPT'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('INFO: Let\'s Encrypt is not set up on this server');
    expect(text).not.toContain('WARNING: no Let\'s Encrypt deploy_hook configured');
  });

  it('настроенный Let\'s Encrypt без хука — по-прежнему предупреждение', async () => {
    serverSays(tls(CERT, 'total 0\ndrwxr-xr-x 2 root root 4096 Aug 13 10:00 .'));

    const text = await answer('ssh_tls_check', { domain: 'example.com' });

    expect(text).toContain('WARNING: no Let\'s Encrypt deploy_hook configured');
  });

  it('чтение хука под sudo просят у исполнителя, а не рисуют в команде', async () => {
    serverSays(tls(CERT, 'renew_hook = systemctl reload nginx'));

    await answer('ssh_tls_check', { domain: 'example.com', sudo: true });

    expect(executeMock.mock.calls[0][2]).toMatchObject({ sudo: true });
  });
});

describe('ssh_audit_baseline: разделы, которых не просили', () => {
  it('невыбранный раздел не печатается вовсе', async () => {
    serverSays(sectioned(AUDIT_SEP, { df: BUSYBOX_DF, free: 'Mem:  7.7G  2.9G  2.9G' }));

    const text = await answer('ssh_audit_baseline', { include: ['disk', 'mem'] });

    expect(text).toContain('disk:');
    expect(text).not.toContain('firewall:');
    expect(text).not.toContain('updates:');
    expect(text).not.toContain('services:');
    expect(text).not.toContain('docker:');
  });

  it('неизвестное имя раздела — отказ со списком доступных', async () => {
    serverSays(baseline());

    const text = await answer('ssh_audit_baseline', { include: ['фаервол'] });

    expect(text).toContain('Unknown audit section(s): фаервол');
    expect(text).toContain(
      'Available: system, disk, mem, net, ssh, services, docker, firewall, updates.'
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('раздел sshd без прав читать конфиг — «нечем проверить», а не «всё в порядке»', async () => {
    serverSays(sectioned(AUDIT_SEP, { sshd: '' }));

    const text = await answer('ssh_audit_baseline', { include: ['ssh'] });

    expect(text).toContain('NOT CHECKED:');
    expect(text).toContain('include_sudo_sections: true');
    expect(text).not.toContain('sshd:\n  port=');
  });

  it('прочитанный конфиг sshd по-прежнему даёт тревогу', async () => {
    serverSays(sectioned(AUDIT_SEP, { sshd: 'port 22\npasswordauthentication yes' }));

    const text = await answer('ssh_audit_baseline', {
      include: ['ssh'],
      include_sudo_sections: true,
    });

    expect(text).toContain('CRITICAL:');
    expect(text).toContain('PasswordAuthentication yes on port 22');
  });
});
