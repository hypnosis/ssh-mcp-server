/**
 * Unit tests: сигнал аудита совпадает с опасностью
 *
 * Каждая пара проверяет и срабатывание, и молчание: флаг, который горит
 * всегда, бесполезен ровно так же, как потухший.
 *
 * Секции — дословные выводы боевой машины и контейнеров лаборатории:
 * `ss -tulpenH` и `sshd -T` с prod-host, `netstat -tulpn` с alpine.
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

const sectioned = (sections: Record<string, string>): string =>
  Object.entries(sections)
    .map(([key, body]) => `${AUDIT_SEP}${key}${AUDIT_SEP}\n${body}`)
    .join('\n');

const serverSays = (stdout: string) =>
  executeMock.mockImplementation(async () => ({ stdout, stderr: '', exitCode: 0 }));

const answer = async (args: Record<string, unknown> = {}): Promise<string> => {
  const request = { params: { name: 'ssh_audit_baseline', arguments: args } } as CallToolRequest;
  const response = await new AuditTool().handleCall(request);
  return response.content.map((c: { text: string }) => c.text).join('\n');
};

const parsed = async (args: Record<string, unknown> = {}) => {
  const text = await answer(args);
  return JSON.parse(text.slice(text.indexOf('{')));
};

/** `sshd -T` в том виде, в каком его отдаёт grep команды раздела */
const sshdConfig = (port: string, passwordAuth = 'no', rootLogin = 'without-password') =>
  [
    `port ${port}`,
    `permitrootlogin ${rootLogin}`,
    'pubkeyauthentication yes',
    `passwordauthentication ${passwordAuth}`,
  ].join('\n');

/** Дословный `ss -tulpenH` с prod-host: sshd на 2222, обе версии протокола */
const SS_SSHD_2222 = [
  'tcp LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=749,fd=3)) ino:8243 sk:2 cgroup:/system.slice/ssh.service <->',
  'tcp LISTEN 0 128 [::]:2222 [::]:* users:(("sshd",pid=749,fd=4)) ino:8245 sk:3 cgroup:/system.slice/ssh.service v6only:1 <->',
].join('\n');

/** Дословный `netstat -tulpn` с alpine: тот же факт, другие колонки */
const NETSTAT_SSHD_22 = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1/sshd -D -e [listener]',
  'tcp        0      0 :::22                   :::*                    LISTEN      1/sshd -D -e [listener]',
].join('\n');

/** Слушатели без sshd: nginx с той же машины, сверять не с чем */
const SS_NO_SSHD = [
  'tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=11519,fd=10)) ino:39609 sk:1003 cgroup:/system.slice/docker-9476b2a82ff7.scope <->',
].join('\n');

/** Дословный `ufw status verbose` с prod-host: экран включён, входящее закрыто */
const UFW_ACTIVE = [
  'Status: active',
  'Logging: on (low)',
  'Default: deny (incoming), allow (outgoing), deny (routed)',
  'New profiles: skip',
  '',
  'To                         Action      From',
  '--                         ------      ----',
  '2222/tcp                   ALLOW IN    Anywhere                   # SSH',
  '80/tcp                     ALLOW IN    Anywhere                   # HTTP',
  '443/tcp                    ALLOW IN    Anywhere                   # HTTPS',
].join('\n');

/** Дословный ответ ufw, установленного и не включённого */
const UFW_INACTIVE = 'Status: inactive';

/** Первая строка `iptables -nL INPUT` — в ней вся политика цепочки */
const INPUT_ACCEPT = 'Chain INPUT (policy ACCEPT)';
const INPUT_DROP = 'Chain INPUT (policy DROP)';

/** Дословный `iptables -t nat -S DOCKER` с prod-host: два опубликованных порта */
const DOCKER_NAT_PUBLISHED = [
  '-N DOCKER',
  '-A DOCKER ! -i docker0 -p tcp -m tcp --dport 19999 -j DNAT --to-destination 172.17.0.2:80',
  '-A DOCKER ! -i docker0 -p tcp -m tcp --dport 19998 -j DNAT --to-destination 172.17.0.2:81',
].join('\n');

/** Та же команда на машине, где контейнеры ничего не публикуют */
const DOCKER_NAT_EMPTY = '-N DOCKER';

/** Разделы фаервола: маркеры те же, что печатает команда раздела */
const firewall = (over: Record<string, string> = {}) =>
  sectioned({
    ufw: 'NO_UFW',
    iptables: 'NO_IPTABLES',
    iptables_input: 'NO_IPTABLES',
    docker_nat: 'NO_DOCKER',
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('порт из конфигурации сверяется со слушателями', () => {
  it('порты сошлись — предупреждения нет', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2222'), listeners: SS_SSHD_2222, interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.red_flags.warning.join(' ')).not.toContain('sshd config says');
  });

  it('конфигурация говорит одно, слушается другое — предупреждение', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2200'), listeners: SS_SSHD_2222, interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.red_flags.warning).toContain(
      'sshd config says port 2200, but sshd listens on 2222'
    );
  });

  it('расхождение находится и в выводе netstat, где колонки другие', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2222'), listeners: NETSTAT_SSHD_22, interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.red_flags.warning).toContain(
      'sshd config says port 2222, but sshd listens on 22'
    );
  });

  it('sshd слушает несколько портов — перечисляются все', async () => {
    const twoPorts = [
      'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=749,fd=3)) ino:8243 sk:2 cgroup:/system.slice/ssh.service <->',
      'tcp LISTEN 0 128 0.0.0.0:2200 0.0.0.0:* users:(("sshd",pid=749,fd=5)) ino:8247 sk:4 cgroup:/system.slice/ssh.service <->',
    ].join('\n');
    serverSays(sectioned({ sshd: sshdConfig('2222'), listeners: twoPorts, interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.red_flags.warning).toContain(
      'sshd config says port 2222, but sshd listens on 22, 2200'
    );
  });

  it('раздела net не просили — сверки нет, и это не пропущенный флаг', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2222') }));

    const result = await parsed({ include: ['ssh'], include_sudo_sections: true });

    expect(result.red_flags.warning.join(' ')).not.toContain('sshd config says');
    expect(result.unavailable.join(' ')).not.toContain('sshd port');
  });

  it('sshd среди слушателей не видно — порт конфигурации не выдаётся за реальный', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2222'), listeners: SS_NO_SSHD, interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.unavailable).toContain(
      'sshd port (no sshd among the listeners — the config port is unconfirmed)'
    );
    expect(result.red_flags.warning.join(' ')).not.toContain('sshd config says');
  });

  it('слушателей не отдали вовсе — второй жалобы про порт не появляется', async () => {
    serverSays(sectioned({ sshd: sshdConfig('2222'), listeners: 'NO_NET_TOOL', interfaces: '' }));

    const result = await parsed({ include: ['ssh', 'net'], include_sudo_sections: true });

    expect(result.unavailable.join(' ')).not.toContain('sshd port');
  });
});

describe('отсутствие фаервола — находка, а не тишина', () => {
  const flags = async (over: Record<string, string> = {}) => {
    serverSays(firewall(over));
    return (await parsed({ include: ['firewall'] })).red_flags;
  };

  it('экран включён — строка в ok, без предупреждения', async () => {
    const red = await flags({ ufw: UFW_ACTIVE, iptables: '199', iptables_input: INPUT_DROP });

    expect(red.ok).toContain('firewall active (ufw)');
    expect(red.warning.join(' ')).not.toContain('no firewall');
  });

  it('ufw установлен и выключен, входящее разрешено — предупреждение', async () => {
    const red = await flags({ ufw: UFW_INACTIVE, iptables: '8', iptables_input: INPUT_ACCEPT });

    expect(red.warning).toContain(
      'no firewall: ufw inactive, iptables INPUT policy ACCEPT — incoming traffic is not filtered'
    );
    expect(red.ok.join(' ')).not.toContain('firewall active');
  });

  it('ни ufw, ни iptables на машине нет — тоже предупреждение', async () => {
    const red = await flags();

    expect(red.warning).toContain(
      'no firewall: ufw not installed, iptables not installed — incoming traffic is not filtered'
    );
  });

  it('ufw выключен, но цепочка INPUT закрыта — это работающий экран', async () => {
    const red = await flags({ ufw: UFW_INACTIVE, iptables: '42', iptables_input: INPUT_DROP });

    expect(red.ok).toContain('firewall active (iptables INPUT policy DROP)');
    expect(red.warning.join(' ')).not.toContain('no firewall');
  });

  it('посмотреть не дали — ни предупреждения, ни ok', async () => {
    const red = await flags({
      ufw: 'NO_UFW_ACCESS',
      iptables: 'NO_IPTABLES_ACCESS',
      iptables_input: 'NO_IPTABLES_ACCESS',
    });

    expect(red.warning.join(' ')).not.toContain('no firewall');
    expect(red.ok.join(' ')).not.toContain('firewall active');
  });

  it('отказ виден в списке непроверенного, а не молча', async () => {
    serverSays(
      firewall({ ufw: 'NO_UFW_ACCESS', iptables: 'NO_IPTABLES_ACCESS', iptables_input: 'NO_IPTABLES_ACCESS' })
    );

    const result = await parsed({ include: ['firewall'] });

    expect(result.unavailable.join(' ')).toContain('firewall/ufw');
  });

  it('статус ufw не прочитан — политика цепочки одна за экран не отвечает', async () => {
    const red = await flags({
      ufw: 'NO_UFW_ACCESS',
      iptables: '8',
      iptables_input: INPUT_ACCEPT,
    });

    expect(red.warning.join(' ')).not.toContain('no firewall');
    expect(red.ok.join(' ')).not.toContain('firewall active');
  });

  it('политику цепочки раздел спрашивает, и оба исхода помечены маркерами', async () => {
    serverSays(firewall());

    await answer({ include: ['firewall'] });

    const command = executeMock.mock.calls[0][1] as string;
    expect(command).toContain('iptables -nL INPUT');
    // Проверка наличия iptables стоит в обеих командах раздела, поэтому
    // ищется та, что принадлежит политике цепочки
    expect(command).toContain('if ! command -v iptables');
    expect(command).toContain('NO_IPTABLES_ACCESS');
  });
});

describe('порты контейнеров мимо фаервола', () => {
  const flags = async (over: Record<string, string> = {}) => {
    serverSays(firewall({ ufw: UFW_ACTIVE, iptables: '199', iptables_input: INPUT_DROP, ...over }));
    return (await parsed({ include: ['firewall'] })).red_flags;
  };

  it('экран включён, а порты опубликованы — предупреждение с их перечислением', async () => {
    const red = await flags({ docker_nat: DOCKER_NAT_PUBLISHED });

    expect(red.warning).toContain(
      'docker publishes port(s) 19999, 19998 past the firewall (nat/DOCKER runs before the filter rules)'
    );
    // Экран при этом честно назван включённым: обе строки правдивы
    expect(red.ok).toContain('firewall active (ufw)');
  });

  it('цепочка пуста — предупреждения нет', async () => {
    const red = await flags({ docker_nat: DOCKER_NAT_EMPTY });

    expect(red.warning.join(' ')).not.toContain('docker publishes');
  });

  it('docker на машине нет — говорить не о чем', async () => {
    const red = await flags();

    expect(red.warning.join(' ')).not.toContain('docker publishes');
  });

  it('экрана нет вовсе — про обход не сообщаем, сообщать надо про экран', async () => {
    serverSays(
      firewall({
        ufw: UFW_INACTIVE,
        iptables: '8',
        iptables_input: INPUT_ACCEPT,
        docker_nat: DOCKER_NAT_PUBLISHED,
      })
    );

    const red = (await parsed({ include: ['firewall'] })).red_flags;

    expect(red.warning.join(' ')).not.toContain('docker publishes');
    expect(red.warning.join(' ')).toContain('no firewall');
  });

  it('перенаправление в цепочку публикацией не считается', async () => {
    // Дословные строки `iptables -t nat -S` с prod-host: ими трафик заводится
    // в цепочку DOCKER, портов они не открывают
    const redirects = [
      '-N DOCKER',
      '-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER',
      '-A OUTPUT ! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER',
    ].join('\n');
    const red = await flags({ docker_nat: redirects });

    expect(red.warning.join(' ')).not.toContain('docker publishes');
  });

  it('экран держится на одном iptables — обход виден и там', async () => {
    serverSays(
      firewall({
        ufw: 'NO_UFW',
        iptables: '42',
        iptables_input: INPUT_DROP,
        docker_nat: DOCKER_NAT_PUBLISHED,
      })
    );

    const red = (await parsed({ include: ['firewall'] })).red_flags;

    expect(red.warning.join(' ')).toContain('docker publishes port(s) 19999, 19998');
  });

  it('цепочку раздел спрашивает только там, где docker есть', async () => {
    serverSays(firewall());

    await answer({ include: ['firewall'] });

    const command = executeMock.mock.calls[0][1] as string;
    expect(command).toContain('iptables -t nat -S DOCKER');
    expect(command).toContain('if ! command -v docker');
    expect(command).toContain('NO_DOCKER_NAT_ACCESS');
  });
});
