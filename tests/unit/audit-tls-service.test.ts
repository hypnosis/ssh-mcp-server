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

/** Полный ответ инструмента: и содержимое, и разбор */
async function respond(
  name: string,
  args: Record<string, unknown>,
  stdout: string
): Promise<any> {
  executeMock.mockResolvedValue({ stdout, stderr: '', exitCode: 0, truncated: false });

  return new AuditTool().handleCall({
    params: { name, arguments: args },
  } as CallToolRequest);
}

/** Разбор, который инструмент кладёт рядом с текстом */
async function parsed(
  name: string,
  args: Record<string, unknown>,
  stdout: string
): Promise<any> {
  return (await respond(name, args, stdout)).structuredContent;
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
      'RestartUSec=5s',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
    ].join('\n');
    const text = await svc({ show, is_enabled: 'enabled' });

    expect(text).toContain('enabled: enabled');
    expect(text).toContain('active:  active/running');
    expect(text).toContain('restart: on-failure (after 5s)');
  });

  it('знак равенства внутри значения его не обрывает', async () => {
    const text = await svc({ show: 'Restart=a=b' });

    expect(text).toContain('restart: a=b');
  });

  it('строка без знака равенства свойством не считается', async () => {
    const text = await svc({ show: 'Failed to get properties\nActiveState=failed' });

    expect(text).toContain('active:  failed/?');
  });

  it('неизвестные свойства не выдаются за значение', async () => {
    const text = await svc({ show: 'LoadState=loaded' });

    expect(text).toContain('active:  ?/?');
    expect(text).toContain('restart: NOT CHECKED');
  });

  /**
   * Замерено на роутере с вендорской оболочкой: его CLI не понимает ни одной команды секции,
   * и все они приходят пустыми. Раньше это печаталось как `active: ?/?` —
   * то есть служба считалась найденной, а неизвестными только её свойства.
   */
  it('молчание всех секций читается как непроверенное', async () => {
    const text = await svc({});

    expect(text).toContain('NOT CHECKED: systemd did not answer on this server');
    expect(text).not.toContain('active:  ?/?');
  });

  /**
   * Три исхода не смешиваются и в разборе: измеренная служба несёт значения,
   * неизмеренная — пустоту. Остановленная служба и неспрошенная машина обязаны
   * выглядеть по-разному, иначе агент доложит о простое, которого не было.
   */
  it('измеренная служба приезжает разбором со значениями', async () => {
    const show = ['Restart=on-failure', 'RestartUSec=5s', 'ActiveState=active', 'SubState=running'].join('\n');
    const result = await parsed(
      'ssh_service_status',
      { unit: 'nginx.service' },
      serverAnswer(SVC_SEP, { show, is_enabled: 'enabled' })
    );

    expect(result.outcome).toBe('checked');
    expect(result.enabled).toBe('enabled');
    expect(result.active_state).toBe('active');
    expect(result.sub_state).toBe('running');
    expect(result.restart).toBe('on-failure');
    expect(result.restart_after).toBe('5s');
  });

  it('машина без systemd приезжает пометкой, а не состоянием', async () => {
    const result = await parsed(
      'ssh_service_status',
      { unit: 'nginx.service' },
      serverAnswer(SVC_SEP, { is_enabled: 'System has not been booted with systemd' })
    );

    expect(result.outcome).toBe('no_systemd');
    expect(result.enabled).toBeNull();
    expect(result.active_state).toBeNull();
    expect(result.sub_state).toBeNull();
    expect(result.restart).toBeNull();
    expect(result.restart_after).toBeNull();
  });

  /**
   * systemd на несуществующий юнит всё равно печатает `ActiveState=inactive`
   * и `SubState=dead`. Взять эти значения — доложить о простое службы,
   * которой на машине нет.
   */
  /**
   * Роутер отвечает своей CLI: ни одна секция не наполняется, а сообщение об
   * ошибке не похоже ни на systemd, ни на пропавшую команду. Замерено на
   * office-router: раньше такой ответ приезжал как `checked`, то есть служба
   * считалась измеренной на машине, где мерить было нечем.
   */
  it('молчание всех секций измерением не считается', async () => {
    const result = await parsed('ssh_service_status', { unit: 'ssh' }, '');

    expect(result.outcome).toBe('no_systemd');
    expect(result.enabled).toBeNull();
    expect(result.active_state).toBeNull();
    expect(result.status_head).toBe('');
  });

  /**
   * Молчанием считается только полное. Ответила хотя бы одна секция — машина
   * отвечает, и записывать её в «нечем проверить» нельзя: пара «автозапуск и
   * состояние» проверяется каждым элементом отдельно.
   */
  it('ответ одного лишь автозапуска молчанием не считается', async () => {
    const result = await parsed('ssh_service_status', { unit: 'ssh' }, serverAnswer(SVC_SEP, { is_enabled: 'enabled' }));

    expect(result.outcome).toBe('checked');
    expect(result.enabled).toBe('enabled');
  });

  it('ответ одного лишь статуса молчанием не считается', async () => {
    const result = await parsed(
      'ssh_service_status',
      { unit: 'ssh' },
      serverAnswer(SVC_SEP, { status: '● ssh.service - OpenBSD Secure Shell server' })
    );

    expect(result.outcome).toBe('checked');
    expect(result.status_head).toContain('OpenBSD Secure Shell');
  });

  it('несуществующая служба не выдаётся за остановленную', async () => {
    const result = await parsed(
      'ssh_service_status',
      { unit: 'nginx.service' },
      serverAnswer(SVC_SEP, {
        is_enabled: 'Failed to get unit file state: No such file or directory',
        show: 'LoadState=not-found\nActiveState=inactive\nSubState=dead',
      })
    );

    expect(result.outcome).toBe('no_unit');
    expect(result.enabled).toBeNull();
    expect(result.active_state).toBeNull();
    expect(result.sub_state).toBeNull();
  });

  /**
   * Разбор добавлен рядом с текстом, а не вместо него: клиент, который читает
   * содержимое, обязан получить его помеченным как текст.
   */
  it('ответ несёт и текст, и разбор', async () => {
    const response = await respond(
      'ssh_service_status',
      { unit: 'nginx.service' },
      serverAnswer(SVC_SEP, { show: 'ActiveState=active', is_enabled: 'enabled' })
    );

    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toContain('=== ssh_service_status nginx.service ===');
    expect(response.structuredContent.active_state).toBe('active');
  });

  it('многословный ответ про автозапуск значением не считается', async () => {
    const result = await parsed(
      'ssh_service_status',
      { unit: 'nginx.service' },
      serverAnswer(SVC_SEP, {
        is_enabled: 'enabled\nWarning: the unit file changed on disk',
        show: 'ActiveState=active\nSubState=running',
      })
    );

    expect(result.outcome).toBe('checked');
    expect(result.enabled).toBeNull();
    expect(result.active_state).toBe('active');
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

  /**
   * Сырой ответ systemctl стоял в графе `enabled` как значение, а соседние поля
   * при этом спокойно печатали `?`: часть отчёта заполнена, часть в вопросах,
   * общего «судить нечем» нет.
   */
  it('сервер без systemctl отвечает «нечем проверить» по всем полям', async () => {
    const text = await svc({ is_enabled: 'sh: systemctl: not found', status: 'sh: systemctl: not found' });

    expect(text).toContain('NOT CHECKED: systemd did not answer on this server');
    expect(text).toContain('enabled: NOT CHECKED');
    expect(text).toContain('active:  NOT CHECKED');
    expect(text).toContain('restart: NOT CHECKED');
    expect(text).not.toContain('enabled: sh:');
  });

  it('незапущенный systemd — тот же ответ', async () => {
    const text = await svc({
      is_enabled: 'Failed to get unit file state for nginx.service: No such file or directory',
      status: 'System has not been booted with systemd as init system (PID 1).',
    });

    expect(text).toContain('enabled: NOT CHECKED');
    expect(text).not.toContain('Failed to get unit file state');
  });

  it('живой systemd без такой службы говорит именно это', async () => {
    const text = await svc({
      is_enabled: 'Failed to get unit file state for nginx.service: No such file or directory',
      status: 'Unit nginx.service could not be found.',
      show: 'LoadState=not-found\nActiveState=inactive\nSubState=dead',
    });

    expect(text).toContain('enabled: no unit by that name');
    expect(text).toContain('active:  inactive/dead');
  });

  it('работающая служба печатается как раньше', async () => {
    const text = await svc({
      is_enabled: 'enabled',
      show: 'Restart=on-failure\nActiveState=active\nSubState=running',
    });

    expect(text).toContain('enabled: enabled');
    expect(text).toContain('active:  active/running');
    expect(text).not.toContain('NOT CHECKED');
  });

  it('паузу перезапуска спрашивают тем именем, которым её печатает systemd', async () => {
    await svc({ show: '' });

    expect(sentCommand()).toContain('RestartUSec');
    expect(sentCommand()).not.toContain('RestartSec');
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

    expect(text).toContain('--- largest entries under /var ---');
    expect(sentCommand()).not.toContain('/var ---');
  });

  it('служебный разделитель в ответ не попадает', async () => {
    const stdout = [
      '__SSH_MCP_DISK_SEP__df__SSH_MCP_DISK_SEP__',
      'Filesystem Type Size',
      '__SSH_MCP_DISK_SEP__docker__SSH_MCP_DISK_SEP__',
      'NO_DOCKER',
    ].join('\n');
    const text = await breakdown({}, stdout);

    expect(text).not.toContain('__SSH_MCP_DISK_SEP__');
    expect(text).toContain('--- filesystems ---\nFilesystem Type Size');
  });

  it('отсутствующий docker назван словами, а не меткой команды', async () => {
    const stdout = '__SSH_MCP_DISK_SEP__docker__SSH_MCP_DISK_SEP__\nNO_DOCKER';
    const text = await breakdown({}, stdout);

    expect(text).toContain('--- docker ---\nnot installed');
    expect(text).not.toContain('NO_DOCKER');
  });

  /**
   * Секция без единой записи попадает в список «проверить нечем»: `du` молчит
   * и о пустом каталоге, и о том, куда его не пустили, и выдать это молчание
   * за отсутствие проблем нельзя.
   */
  it('разбор называет секции, которые нечем было проверить', async () => {
    const stdout = [
      '__SSH_MCP_DISK_SEP__df__SSH_MCP_DISK_SEP__',
      'Filesystem Type Size Used Avail Use% Mounted on',
      '/dev/sda1 ext4 40G 12G 26G 32% /',
      '__SSH_MCP_DISK_SEP__du_0__SSH_MCP_DISK_SEP__',
      '4.0G\t/var/lib',
      '__SSH_MCP_DISK_SEP__docker__SSH_MCP_DISK_SEP__',
      'NO_DOCKER',
      '__SSH_MCP_DISK_SEP__journald__SSH_MCP_DISK_SEP__',
      'Archived and active journals take up 120.0M',
    ].join('\n');
    const result = await parsed('ssh_disk_breakdown', {}, stdout);

    expect(result.filesystems).toEqual([
      {
        filesystem: '/dev/sda1',
        type: 'ext4',
        size: '40G',
        used: '12G',
        avail: '26G',
        pct: 32,
        mount: '/',
      },
    ]);
    expect(result.largest).toEqual([{ path: '/', entries: [{ size: '4.0G', path: '/var/lib' }] }]);
    expect(result.docker).toBeNull();
    expect(result.journald).toContain('120.0M');
    expect(result.unavailable).toEqual(['/var/log', '$HOME/.cache']);
  });

  it('ответ несёт и текст, и разбор', async () => {
    const stdout = '__SSH_MCP_DISK_SEP__df__SSH_MCP_DISK_SEP__\nFilesystem Type Size Used Avail Use% Mounted on';
    const response = await respond('ssh_disk_breakdown', {}, stdout);

    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toContain('=== ssh_disk_breakdown ===');
    expect(response.structuredContent.unavailable).toContain('docker');
  });

  it('разбор раскладывает журналы и кэш по своим спискам', async () => {
    const stdout = [
      '__SSH_MCP_DISK_SEP__var_log__SSH_MCP_DISK_SEP__',
      '120M\t/var/log/journal',
      '__SSH_MCP_DISK_SEP__cache__SSH_MCP_DISK_SEP__',
      '8.0M\t/root/.cache/pip',
      '__SSH_MCP_DISK_SEP__journald__SSH_MCP_DISK_SEP__',
      'NO_JOURNALD',
    ].join('\n');
    const result = await parsed('ssh_disk_breakdown', {}, stdout);

    expect(result.var_log).toEqual([{ size: '120M', path: '/var/log/journal' }]);
    expect(result.cache).toEqual([{ size: '8.0M', path: '/root/.cache/pip' }]);
    expect(result.journald).toBeNull();
    expect(result.unavailable).not.toContain('/var/log');
    expect(result.unavailable).not.toContain('$HOME/.cache');
  });

  it('молчание про docker не выдаётся за машину без docker', async () => {
    const stdout = '__SSH_MCP_DISK_SEP__df__SSH_MCP_DISK_SEP__\nFilesystem Type Size Used Avail Use% Mounted on';
    const result = await parsed('ssh_disk_breakdown', {}, stdout);

    expect(result.docker).toBeNull();
    expect(result.unavailable).toContain('docker');
    expect(result.unavailable).toContain('journald');
  });

  it('пустая таблица томов не выдаётся за машину без дисков', async () => {
    const result = await parsed('ssh_disk_breakdown', {}, '');

    expect(result.filesystems).toEqual([]);
    expect(result.unavailable).toContain('filesystems');
    expect(result.unavailable).toContain('largest entries under /');
  });

  it('каждый запрошенный путь получает свой раздел', async () => {
    const stdout = [
      '__SSH_MCP_DISK_SEP__du_0__SSH_MCP_DISK_SEP__',
      '1G\t/var/log',
      '__SSH_MCP_DISK_SEP__du_1__SSH_MCP_DISK_SEP__',
      '2G\t/home/deploy',
    ].join('\n');
    const text = await breakdown({ paths: ['/var', '/home'] }, stdout);

    expect(text).toContain('--- largest entries under /var ---\n1G\t/var/log');
    expect(text).toContain('--- largest entries under /home ---\n2G\t/home/deploy');
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

/**
 * Права до сервера доезжают параметром, а не пожеланием.
 *
 * Разбор диска без прав не видит /root и /var/lib/docker — ровно те каталоги,
 * ради которых его и зовут, когда место кончилось. Журнал без прав приходит
 * урезанным, и «в журнале пусто» становится неотличимо от «журнал не показали».
 * Инструмент, которому нечем взять права, врёт обоими способами молча.
 */
describe('права доезжают до сервера', () => {
  const optionsOf = () => executeMock.mock.calls.at(-1)![2] ?? {};

  it.each([
    ['ssh_disk_breakdown', { profile: 'p' }],
    ['ssh_service_status', { profile: 'p', unit: 'nginx' }],
  ])('%s: без просьбы root не берётся', async (name, args) => {
    await answer(name, args, '');

    expect(optionsOf().sudo).toBe(false);
  });

  it.each([
    ['ssh_disk_breakdown', { profile: 'p', sudo: true }],
    ['ssh_service_status', { profile: 'p', unit: 'nginx', sudo: true }],
  ])('%s: просьба доезжает до исполнителя', async (name, args) => {
    await answer(name, args, '');

    expect(optionsOf().sudo).toBe(true);
  });

  it.each([['ssh_disk_breakdown'], ['ssh_service_status']])(
    '%s: параметр объявлен, иначе агенту нечего передать',
    (name) => {
      const tool = new AuditTool().getTools().find((candidate) => candidate.name === name)!;
      const sudo = (tool.inputSchema.properties as Record<string, any>).sudo;

      expect(sudo.type).toBe('boolean');
      // Правило «когда брать» — то самое место, о которое спотыкались агенты
      expect(sudo.description).toContain('Straight away for places a plain user cannot read');
    }
  );
});

/**
 * Каталог, куда `du` не пустили, — это не «там пусто».
 *
 * Разбор диска зовут, когда место кончилось, и отвечает он списком самых
 * жирных каталогов. Список, молча укоротившийся ровно на `/root` и
 * `/var/lib/docker`, выглядит полным — и виновника в нём нет. Жалобу пишут оба
 * набора утилит, но по-разному: coreutils берёт имя в кавычки, BusyBox — нет.
 */
describe('ssh_disk_breakdown: непрочитанное названо', () => {
  const complaints: Array<[string, string]> = [
    ['coreutils', "du: cannot read directory '/root': Permission denied"],
    ['BusyBox', "du: can't open '/root': Permission denied"],
  ];

  /** Какая из команд du отвечает за раздел — по ней и видно, заткнули ли её */
  const SECTION_DU: Record<string, string> = {
    paths: 'du -shx',
    var_log: 'du -sh /var/log',
    cache: 'du -sh "$HOME"/.cache',
  };

  /**
   * Ответ сервера, где часть каталогов прочитать не дали.
   *
   * Заглушённая команда жалобы не показывает — мок обязан молчать там же, где
   * молчит сервер, иначе снятое глушение нечем отличить от возвращённого.
   */
  async function withComplaint(
    stderr: string,
    { from = 'paths', ...args }: Record<string, any> = {}
  ) {
    executeMock.mockImplementation(async (_config: unknown, command: string) => {
      const part = command.split(';').find((chunk) => chunk.includes(SECTION_DU[from])) ?? '';
      return {
        stdout: `__SSH_MCP_DISK_SEP__du_0__SSH_MCP_DISK_SEP__\n4.0G\t/var\n`,
        stderr: part.includes('2>/dev/null') ? '' : stderr,
        exitCode: 0,
        truncated: false,
      };
    });

    return new AuditTool().handleCall({
      params: { name: 'ssh_disk_breakdown', arguments: { profile: 'p', ...args } },
    } as CallToolRequest);
  }

  it.each(complaints)('%s: закрытый каталог попадает в поля', async (_utils, complaint) => {
    const answer: any = await withComplaint(complaint);

    expect(answer.structuredContent.unreadable).toEqual(['/root']);
  });

  it('закрытый каталог назван и словами, с выходом из положения', async () => {
    const answer: any = await withComplaint("du: cannot read directory '/root': Permission denied");

    expect(answer.content[0].text).toContain('/root');
    expect(answer.content[0].text).toContain('Retry with sudo: true');
  });

  it('каждый каталог назван один раз, сколько бы раз du ни жаловался', async () => {
    const answer: any = await withComplaint(
      [
        "du: cannot read directory '/root': Permission denied",
        "du: cannot read directory '/root': Permission denied",
        "du: cannot read directory '/var/lib/docker': Permission denied",
      ].join('\n')
    );

    expect(answer.structuredContent.unreadable).toEqual(['/root', '/var/lib/docker']);
  });

  /**
   * Жалуется не только `du`: рядом в той же команде идут docker и journald,
   * которых на машине может не быть. Их «команда не найдена» — не закрытый
   * каталог, и в списке непрочитанного ему не место.
   */
  it('чужие жалобы в список не попадают', async () => {
    const answer: any = await withComplaint(
      ['sh: docker: not found', "du: cannot read directory '/root': Permission denied"].join('\n')
    );

    expect(answer.structuredContent.unreadable).toEqual(['/root']);
  });

  it.each([['var_log'], ['cache']])(
    'жалоба из раздела %s тоже доходит, а не только из запрошенных путей',
    async (from) => {
      const answer: any = await withComplaint(
        "du: cannot read directory '/root': Permission denied",
        { from }
      );

      expect(answer.structuredContent.unreadable).toEqual(['/root']);
    }
  );

  it('никто не жаловался — список пуст, а не отсутствует', async () => {
    const answer: any = await withComplaint('');

    expect(answer.structuredContent.unreadable).toEqual([]);
    expect(answer.content[0].text).not.toContain('not looked into');
  });

  /**
   * Имя команды кончается двоеточием, и без него в список попадёт всякий, чьё
   * имя начинается теми же буквами.
   */
  it('жалоба команды, чьё имя лишь начинается на du, каталогом не становится', async () => {
    const answer: any = await withComplaint(
      "duplicity: cannot read directory '/root': Permission denied"
    );

    expect(answer.structuredContent.unreadable).toEqual([]);
  });

  /** Хвост либо называет непрочитанное, либо пуст — третьего у него нет */
  it('без жалоб ответ — тот же разбор и ни строкой больше', async () => {
    const clean: any = await withComplaint('');
    const noisy: any = await withComplaint("du: cannot read directory '/root': Permission denied");

    expect(clean.content[0].text).toBe(
      noisy.content[0].text.split('\n\n--- not looked into ---')[0]
    );
  });

  /**
   * Разделы спрашиваются шаблоном, и шаблон, которому нечего сопоставить,
   * уезжает к `du` как есть. Тексты ниже сняты с контейнеров: закрытый каталог
   * приходит тем же нераскрытым шаблоном, что и пустой, и отличается только
   * жалобой. Отсюда и разбор — по жалобе, а не по звёздочке в имени.
   */
  describe('пустое место и закрытое различаются', () => {
    const absent: Array<[string, string]> = [
      ['coreutils', "du: cannot access '/root/.cache/*': No such file or directory"],
      ['BusyBox', 'du: /var/log/*: No such file or directory'],
    ];
    const refused: Array<[string, string]> = [
      ['coreutils', "du: cannot access '/root/*': Permission denied"],
      ['BusyBox', 'du: /root/*: Permission denied'],
    ];

    it.each(absent)('%s: «нет такого» — это не отказ и советовать sudo не о чем', async (
      _utils,
      complaint
    ) => {
      const answer: any = await withComplaint(complaint);

      expect(answer.structuredContent.unreadable).toEqual([]);
      expect(answer.content[0].text).not.toContain('not looked into');
    });

    it.each(refused)('%s: закрытый каталог назван и через шаблон', async (_utils, complaint) => {
      const answer: any = await withComplaint(complaint);

      expect(answer.structuredContent.unreadable).toEqual(['/root/*']);
    });

    it('жалобы двух родов в одном ответе не смешиваются', async () => {
      const answer: any = await withComplaint(
        [
          "du: cannot access '/root/.cache/*': No such file or directory",
          "du: cannot read directory '/root': Permission denied",
        ].join('\n')
      );

      expect(answer.structuredContent.unreadable).toEqual(['/root']);
    });
  });
});
