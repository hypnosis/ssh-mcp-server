/**
 * Unit tests: `ssh_tls_check`, `ssh_service_status`, `ssh_disk_breakdown`.
 *
 * Три инструмента, которыми агент судит о живом сервере, и во всех трёх ответ
 * собирается здесь, а не на сервере. Главное — не смешивать три исхода: срок
 * сошёлся, срок кончается, прочитать сертификат было нечем. Последнее раньше
 * выглядело как утверждение «SAN не содержит домен» о сертификате, которого
 * никто не видел.
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

const { AuditTool } = await import('../../src/tools/audit-tool.js');

const TLS_SEP = '__SSH_MCP_TLS_SEP__';
const SVC_SEP = '__SSH_MCP_SVC_SEP__';

function serverAnswer(separator: string, sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([key, body]) => `${separator}${key}${separator}\n${body}`)
    .join('\n');
}

/** Ответ инструмента на подготовленный вывод сервера */
async function answer(
  name: string,
  args: Record<string, unknown>,
  stdout: string
): Promise<string> {
  executeMock.mockResolvedValue({ stdout, stderr: '', exitCode: 0, truncated: false });

  const response = await new AuditTool().handleCall({
    params: { name, arguments: args },
  } as CallToolRequest);

  return response.content[0].text;
}

function structure(text: string): any {
  return JSON.parse(text.slice(text.indexOf('{')));
}

function sentCommand(): string {
  return String(executeMock.mock.calls[0][1]);
}

/** Дата в том виде, в каком её печатает openssl */
function certDate(offsetMs: number): string {
  const when = new Date(Date.now() + offsetMs);
  const month = when.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(when.getUTCDate()).padStart(2, ' ');
  const time = when.toISOString().slice(11, 19);
  return `${month} ${day} ${time} ${when.getUTCFullYear()} GMT`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Сертификат, как его отдаёт связка openssl s_client | openssl x509 */
function certificate(daysLeft: number, san = 'DNS:example.com, DNS:www.example.com'): string {
  return [
    `notBefore=${certDate(-30 * DAY_MS)}`,
    `notAfter=${certDate(daysLeft * DAY_MS + 60 * 60 * 1000)}`,
    'X509v3 Subject Alternative Name:',
    `    ${san}`,
    'issuer=C = US, O = Let\'s Encrypt, CN = R3',
  ].join('\n');
}

const RENEW_HOOK = 'renew_hook = systemctl reload nginx';

async function tls(
  sections: Record<string, string>,
  args: Record<string, unknown> = {}
): Promise<string> {
  return answer(
    'ssh_tls_check',
    { domain: 'example.com', ...args },
    serverAnswer(TLS_SEP, { renew: RENEW_HOOK, ...sections })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ssh_tls_check: срок сертификата', () => {
  it('живой сертификат тревоги не поднимает', async () => {
    const text = await tls({ cert: certificate(60) });

    expect(text).not.toContain('CRITICAL');
    expect(text).not.toContain('WARNING');
    expect(structure(text).days_until_expiry).toBe(60);
  });

  it('просроченный сертификат — тревога об истёкшем, а не о сроке', async () => {
    const text = await tls({ cert: certificate(-1) });

    expect(text).toContain('CRITICAL: certificate EXPIRED');
    expect(text).not.toContain('expires in');
  });

  it.each([
    [1, 'CRITICAL'],
    [7, 'CRITICAL'],
    [8, 'WARNING'],
    [30, 'WARNING'],
  ])('%i дней до конца — %s', async (days, level) => {
    const text = await tls({ cert: certificate(days) });

    expect(text).toContain(`${level}: expires in ${days} days`);
  });

  it('31 день до конца — молчание', async () => {
    const text = await tls({ cert: certificate(31) });

    expect(text).not.toContain('expires in');
  });
});

describe('ssh_tls_check: три исхода не смешиваются', () => {
  it('без openssl отвечает «прочитать нечем» и называет причину', async () => {
    const text = await tls({ cert: 'sh: openssl: not found' });

    expect(text).toContain('UNKNOWN: certificate not read — sh: openssl: not found');
  });

  /**
   * Здесь и был подлог: у непрочитанного сертификата SAN пуст, и «пусто»
   * выдавалось за «домена в сертификате нет».
   */
  it('о SAN непрочитанного сертификата ничего не утверждает', async () => {
    const text = await tls({ cert: 'connect: Connection refused' });

    expect(structure(text).san_includes_hostname).toBeNull();
    expect(text).not.toContain('SAN does not include');
  });

  it('пустой ответ тоже называется своей причиной', async () => {
    const text = await tls({ cert: '' });

    expect(text).toContain('no output from openssl');
  });

  it('дата, которую не разобрать, читается как «нечем», а не как «истёк»', async () => {
    const text = await tls({ cert: 'notAfter=whenever it feels like it' });

    expect(text).toContain('UNKNOWN: certificate not read');
    expect(text).not.toContain('EXPIRED');
  });
});

describe('ssh_tls_check: имя в сертификате', () => {
  it('домен, найденный среди имён, тревоги не поднимает', async () => {
    const text = await tls({ cert: certificate(60, 'DNS:example.com, DNS:www.example.com') });

    expect(structure(text).san_includes_hostname).toBe(true);
    expect(text).not.toContain('SAN does not include');
  });

  it('чужой сертификат — тревога с именем домена', async () => {
    const text = await tls({ cert: certificate(60, 'DNS:other.org') });

    expect(structure(text).san_includes_hostname).toBe(false);
    expect(text).toContain('CRITICAL: SAN does not include example.com');
  });

  it('имя узнаётся без приставки DNS', async () => {
    const text = await tls({ cert: certificate(60, 'DNS:example.com') });

    expect(structure(text).san_includes_hostname).toBe(true);
  });

  it('домен, входящий в чужое имя как часть, за совпадение не считается', async () => {
    const text = await tls({ cert: certificate(60, 'DNS:not-example.com') });

    expect(structure(text).san_includes_hostname).toBe(false);
  });
});

describe('ssh_tls_check: имя домена не становится командой', () => {
  it.each([
    ['example.com; touch /tmp/pwned'],
    ['$(hostname)'],
    ['example.com`id`'],
    ["exam'ple.com"],
  ])('%s отвергается до всякой отправки', async (domain) => {
    const text = await answer('ssh_tls_check', { domain }, '');

    expect(text).toContain('Invalid domain');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('без домена звать нечего', async () => {
    expect(await answer('ssh_tls_check', {}, '')).toContain('Invalid domain');
  });
});

describe('ssh_tls_check: сборка команды', () => {
  it('без указания порта проверяется 443', async () => {
    await tls({ cert: certificate(60) });

    expect(sentCommand()).toContain('example.com:443');
    expect(structure(await tls({ cert: certificate(60) })).port).toBe(443);
  });

  it.each([
    ['соединение с доменом', 'openssl s_client -connect'],
    ['имя для SNI', '-servername'],
    ['цепочку сертификатов', '-showcerts'],
    ['разбор сертификата', 'openssl x509 -noout -dates'],
    ['имена в сертификате', '-ext subjectAltName'],
    ['выпустившего', '-issuer'],
    ['настройки обновления', '/etc/letsencrypt/renewal/'],
    ['хуки обновления', '/etc/letsencrypt/renewal-hooks/deploy/'],
  ])('спрашивает %s', async (_what, fragment) => {
    await tls({ cert: certificate(60) });

    expect(sentCommand()).toContain(fragment);
  });

  it('указанный порт уезжает вместо умолчания', async () => {
    await tls({ cert: certificate(60) }, { port: 8443 });

    expect(sentCommand()).toContain('example.com:8443');
  });

  it('отказ от проверки обновления не ищет хуков на сервере', async () => {
    const text = await tls({ cert: certificate(60) }, { check_renew_hook: false });

    expect(sentCommand()).toContain('echo SKIPPED');
    expect(text).not.toContain('deploy_hook');
  });

  it('без настроенного обновления предупреждает', async () => {
    const text = await tls({ cert: certificate(60), renew: '' });

    expect(text).toContain("WARNING: no Let's Encrypt deploy_hook configured");
    expect(structure(text).renew_hook_configured).toBe(false);
  });

  it('настроенный хук обновления предупреждения не вызывает', async () => {
    const text = await tls({ cert: certificate(60), renew: RENEW_HOOK });

    expect(structure(text).renew_hook_configured).toBe(true);
    expect(text).not.toContain('deploy_hook');
  });
});

describe('ssh_service_status', () => {
  const svc = (sections: Record<string, string>, args: Record<string, unknown> = {}) =>
    answer('ssh_service_status', { unit: 'nginx.service', ...args }, serverAnswer(SVC_SEP, sections));

  it('свойства службы разбираются по первому знаку равенства', async () => {
    const show = [
      'Restart=on-failure',
      'RestartSec=5s',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
    ].join('\n');
    const text = await svc({ show, is_enabled: 'enabled' });

    expect(text).toContain('enabled: enabled');
    expect(text).toContain('active:  active/running');
    expect(text).toContain('restart: on-failure (5ss)');
  });

  it('знак равенства внутри значения его не обрывает', async () => {
    const text = await svc({ show: 'Restart=a=b' });

    expect(text).toContain('restart: a=b');
  });

  it('строка без знака равенства свойством не считается', async () => {
    const text = await svc({ show: 'Failed to get properties\nActiveState=failed' });

    expect(text).toContain('active:  failed/?');
  });

  it('неизвестные свойства печатаются вопросом, а не пустотой', async () => {
    const text = await svc({ show: '' });

    expect(text).toContain('active:  ?/?');
    expect(text).toContain('restart: ? (?s)');
  });

  it.each([['nginx; touch /tmp/pwned'], ['$(id)'], ['unit name']])(
    'имя службы %s отвергается до отправки',
    async (unit) => {
      const text = await answer('ssh_service_status', { unit }, '');

      expect(text).toContain('Invalid unit name');
      expect(executeMock).not.toHaveBeenCalled();
    }
  );

  it('число строк журнала уезжает в команду и в заголовок', async () => {
    const text = await svc({ log: 'nothing here' }, { log_lines: 5 });

    expect(sentCommand()).toContain('-n 5');
    expect(text).toContain('--- last 5 log lines ---');
  });

  it('нечисловое число строк отвергается', async () => {
    const text = await answer('ssh_service_status', { unit: 'nginx', log_lines: '5; id' }, '');

    expect(text).toContain('log_lines must be a whole number');
  });

  it('без указания глубины журнал не ограничивается по времени', async () => {
    await svc({ log: '' });

    expect(sentCommand()).not.toContain('--since');
  });

  it('указанный срок уезжает закавыченным', async () => {
    await svc({ log: '' }, { since: '2 hours ago' });

    expect(sentCommand()).toContain("--since '2 hours ago'");
  });
});

describe('ssh_disk_breakdown', () => {
  const breakdown = (args: Record<string, unknown> = {}, stdout = '') =>
    answer('ssh_disk_breakdown', args, stdout);

  it('без указания путей смотрит корень', async () => {
    await breakdown();

    expect(sentCommand()).toContain("du -shx '/'/*");
  });

  it('имя каталога подставляется в заголовок у нас, а не на сервере', async () => {
    const stdout = '__SSH_MCP_DISK_SEP__du_0__SSH_MCP_DISK_SEP__\n4.0G\t/var/lib';
    const text = await breakdown({ paths: ['/var'] }, stdout);

    expect(text).toContain('du_/var');
    expect(sentCommand()).not.toContain('du_/var');
  });

  it('каждый запрошенный путь получает свой раздел', async () => {
    const stdout = [
      '__SSH_MCP_DISK_SEP__du_0__SSH_MCP_DISK_SEP__',
      '1G\t/var/log',
      '__SSH_MCP_DISK_SEP__du_1__SSH_MCP_DISK_SEP__',
      '2G\t/home/deploy',
    ].join('\n');
    const text = await breakdown({ paths: ['/var', '/home'] }, stdout);

    expect(text).toContain('du_/var');
    expect(text).toContain('du_/home');
  });

  it('путь уезжает закавыченным', async () => {
    await breakdown({ paths: ["/srv/it's"] });

    expect(sentCommand()).toContain("du -shx '/srv/it'\\''s'/*");
  });

  it('глубина выборки уезжает числом', async () => {
    await breakdown({ top_n: 5 });

    expect(sentCommand()).toContain('head -5');
  });

  it('нечисловая глубина отвергается', async () => {
    expect(await breakdown({ top_n: '5; id' })).toContain('top_n must be a whole number');
  });

  it('маркеры отсутствия docker и journald уезжают вместе с командой', async () => {
    await breakdown();

    expect(sentCommand()).toContain('NO_DOCKER');
    expect(sentCommand()).toContain('NO_JOURNALD');
  });
});
