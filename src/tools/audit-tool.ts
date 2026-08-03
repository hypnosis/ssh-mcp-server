/**
 * Audit Tool
 *
 * Specialized read-only audit primitives that collect evidence for
 * server-auditor / server-deployer agents in one round-trip each.
 *
 * - ssh_audit_baseline   system/disk/mem/net/ssh/services/docker/firewall/updates
 * - ssh_tls_check        TLS expiry + SAN match + chain + renew_hook for a domain
 * - ssh_disk_breakdown   top consumers (du, docker, journald, caches)
 * - ssh_service_status   systemctl + journalctl tail in one call
 *
 * Output is structured (single text block with section headers + JSON), so
 * agents can consume it without N follow-up ssh_exec calls.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { shellQuote } from '../utils/tmp-name.js';
import { shellCount } from '../utils/shell-arg.js';

interface BaselineResult {
  hostname: string;
  uptime: string;
  date_utc: string;
  os: string;
  kernel: string;
  disk: Array<{ filesystem: string; size: string; used: string; avail: string; pct: number; mount: string }>;
  memory: { total: string; used: string; free: string; available: string };
  load: string;
  net: {
    listeners: Array<{ proto: string; address: string; pid_program: string }>;
    interfaces: string[];
  };
  ssh?: {
    port: string;
    permit_root_login: string;
    password_auth: string;
    pubkey_auth: string;
  };
  services: {
    failed: string[];
    running_count: number;
  };
  docker?: {
    containers: Array<{ id: string; image: string; status: string; names: string }>;
    df: string;
  };
  firewall: {
    ufw: string;
    iptables_rules: number;
  };
  updates: {
    upgradable: number;
    reboot_required: boolean;
  };
  red_flags: { critical: string[]; warning: string[]; ok: string[] };
}

export class AuditTool {
  private executor: SSHExecutor;

  constructor() {
    this.executor = new SSHExecutor();
  }

  getTools(): Tool[] {
    return [
      {
        name: 'ssh_audit_baseline',
        description:
          'Read-only baseline server audit in a single batched call: system, disk, memory, network listeners, sshd config, systemd services, docker, firewall, available updates. Returns structured JSON plus a CRITICAL/WARNING/OK red-flags shortlist.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            include: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Sections to include. Default: all. Available: system, disk, mem, net, ssh, services, docker, firewall, updates.',
            },
            include_sudo_sections: {
              type: 'boolean',
              description: 'Run sections that require sudo (e.g. sshd -T). Default: false.',
              default: false,
            },
            compact: {
              type: 'boolean',
              description: 'Trim long sections to keep response small. Default: true.',
              default: true,
            },
          },
        },
      },
      {
        name: 'ssh_tls_check',
        description:
          'Check TLS certificate for a domain: expiry date, SAN includes hostname, issuer chain, and whether a deploy renew hook is configured (Let\'s Encrypt).',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            domain: { type: 'string', description: 'FQDN to check' },
            port: { type: 'number', description: 'TLS port. Default: 443.', default: 443 },
            check_chain: { type: 'boolean', default: true },
            check_renew_hook: { type: 'boolean', default: true },
          },
          required: ['domain'],
        },
      },
      {
        name: 'ssh_disk_breakdown',
        description:
          'Disk usage breakdown: df by mount, top-N largest dirs under given paths, docker disk, journald disk, common cache dirs.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            top_n: { type: 'number', default: 20 },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Root paths to scan. Default: ["/"].',
              default: ['/'],
            },
          },
        },
      },
      {
        name: 'ssh_service_status',
        description:
          'Combined systemctl status + journalctl tail for a unit, in one batched call.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: 'SSH profile name' },
            unit: { type: 'string', description: 'systemd unit name' },
            log_lines: { type: 'number', default: 50 },
            since: { type: 'string', description: 'journalctl --since value, e.g. "1h ago"' },
          },
          required: ['unit'],
        },
      },
    ];
  }

  async handleCall(request: CallToolRequest) {
    const toolName = request.params.name;
    try {
      switch (toolName) {
        case 'ssh_audit_baseline':
          return await this.handleBaseline(request);
        case 'ssh_tls_check':
          return await this.handleTlsCheck(request);
        case 'ssh_disk_breakdown':
          return await this.handleDiskBreakdown(request);
        case 'ssh_service_status':
          return await this.handleServiceStatus(request);
        default:
          throw new Error(`Unknown audit tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_audit_baseline
  // ---------------------------------------------------------------------------

  private async handleBaseline(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const include: string[] = args.include || [
      'system', 'disk', 'mem', 'net', 'services', 'docker', 'firewall', 'updates',
      ...(args.include_sudo_sections ? ['ssh'] : []),
    ];
    const compact = args.compact !== false;

    // Build a single batched script. Use a sentinel between sections so we
    // can split the output deterministically without a heavy shell wrapper.
    const SEP = '__SSH_MCP_AUDIT_SEP__';
    const parts: Array<{ key: string; cmd: string }> = [];

    if (include.includes('system')) {
      parts.push({ key: 'hostname', cmd: 'hostname' });
      parts.push({ key: 'uptime', cmd: 'uptime' });
      parts.push({ key: 'date_utc', cmd: 'date -u' });
      parts.push({ key: 'os', cmd: '(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s' });
      parts.push({ key: 'kernel', cmd: 'uname -r' });
      parts.push({ key: 'load', cmd: "cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null || echo unavailable" });
    }
    if (include.includes('disk')) {
      parts.push({ key: 'df', cmd: 'df -hT -x tmpfs -x devtmpfs -x squashfs 2>/dev/null' });
    }
    if (include.includes('mem')) {
      parts.push({ key: 'free', cmd: 'free -h 2>/dev/null || vm_stat 2>/dev/null' });
    }
    if (include.includes('net')) {
      parts.push({ key: 'listeners', cmd: 'ss -tulpenH 2>/dev/null || netstat -tulpn 2>/dev/null' });
      parts.push({ key: 'interfaces', cmd: 'ip -br a 2>/dev/null || ifconfig 2>/dev/null | head -40' });
    }
    if (include.includes('ssh')) {
      // Requires sudo
      parts.push({ key: 'sshd', cmd: 'sshd -T 2>/dev/null | grep -E "^(port|permitrootlogin|passwordauth|pubkeyauth|usedns)"' });
    }
    if (include.includes('services')) {
      parts.push({ key: 'failed', cmd: 'systemctl --failed --no-legend --plain 2>/dev/null || true' });
      parts.push({ key: 'running_count', cmd: 'systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | wc -l' });
    }
    if (include.includes('docker')) {
      parts.push({ key: 'docker_ps', cmd: 'docker ps -a --format "{{.ID}}\\t{{.Image}}\\t{{.Status}}\\t{{.Names}}" 2>/dev/null || echo NO_DOCKER' });
      parts.push({ key: 'docker_df', cmd: 'docker system df 2>/dev/null || echo NO_DOCKER' });
    }
    if (include.includes('firewall')) {
      parts.push({ key: 'ufw', cmd: '(ufw status verbose 2>/dev/null) || echo NO_UFW' });
      parts.push({ key: 'iptables', cmd: '(iptables -nL 2>/dev/null | wc -l) || echo 0' });
    }
    if (include.includes('updates')) {
      parts.push({ key: 'upgradable', cmd: '(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l) || echo 0' });
      parts.push({ key: 'reboot_required', cmd: '(test -f /var/run/reboot-required && echo YES) || echo NO' });
    }

    const compound = parts
      .map((p) => `echo "${SEP}${p.key}${SEP}"; ${p.cmd}`)
      .join('; ');

    const useSudo = include.includes('ssh') && !!args.include_sudo_sections;
    const r = await this.executor.execute(sshConfig, compound, {
      profileName,
      sudo: useSudo,
      timeout: 60000,
      idempotent: true,
    });

    const sections = this.splitSections(r.stdout, SEP);
    const result = this.buildBaselineResult(sections, compact);
    return {
      content: [
        { type: 'text', text: this.formatBaseline(result, compact) },
      ],
    };
  }

  private splitSections(stdout: string, sep: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = new RegExp(`${sep}([a-z_]+)${sep}\\n?`, 'g');
    let lastKey: string | null = null;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stdout)) !== null) {
      if (lastKey) {
        out.set(lastKey, stdout.slice(lastIdx, m.index).trimEnd());
      }
      lastKey = m[1];
      lastIdx = m.index + m[0].length;
    }
    if (lastKey) {
      out.set(lastKey, stdout.slice(lastIdx).trimEnd());
    }
    return out;
  }

  private buildBaselineResult(s: Map<string, string>, compact: boolean): BaselineResult {
    const trimLines = (txt: string, n: number) =>
      compact ? txt.split('\n').slice(0, n).join('\n') : txt;

    const result: BaselineResult = {
      hostname: (s.get('hostname') || '').trim(),
      uptime: (s.get('uptime') || '').trim(),
      date_utc: (s.get('date_utc') || '').trim(),
      os: (s.get('os') || '').trim(),
      kernel: (s.get('kernel') || '').trim(),
      load: (s.get('load') || '').trim(),
      disk: this.parseDf(s.get('df') || ''),
      memory: this.parseFree(s.get('free') || ''),
      net: {
        listeners: this.parseListeners(trimLines(s.get('listeners') || '', 80)),
        interfaces: (s.get('interfaces') || '').split('\n').filter(Boolean).slice(0, compact ? 10 : 100),
      },
      services: {
        failed: (s.get('failed') || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split(/\s+/)[0]),
        running_count: parseInt((s.get('running_count') || '0').trim(), 10) || 0,
      },
      firewall: {
        ufw: trimLines(s.get('ufw') || '', 12),
        iptables_rules: parseInt((s.get('iptables') || '0').trim(), 10) || 0,
      },
      updates: {
        upgradable: parseInt((s.get('upgradable') || '0').trim(), 10) || 0,
        reboot_required: (s.get('reboot_required') || '').trim() === 'YES',
      },
      red_flags: { critical: [], warning: [], ok: [] },
    };

    if (s.has('sshd')) {
      const sshd = s.get('sshd') || '';
      const get = (k: string) =>
        (sshd.match(new RegExp(`^${k}\\s+(.+)$`, 'm')) || [])[1] || '';
      result.ssh = {
        port: get('port'),
        permit_root_login: get('permitrootlogin'),
        password_auth: get('passwordauthentication'),
        pubkey_auth: get('pubkeyauthentication'),
      };
    }

    if (s.has('docker_ps')) {
      const ps = (s.get('docker_ps') || '').trim();
      if (ps !== 'NO_DOCKER' && ps) {
        const containers = ps
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [id, image, status, names] = line.split('\t');
            return { id, image, status, names };
          });
        result.docker = {
          containers,
          df: trimLines(s.get('docker_df') || '', 8),
        };
      }
    }

    // Red-flags classification
    for (const d of result.disk) {
      if (d.pct >= 90) result.red_flags.critical.push(`${d.mount} disk ${d.pct}% full`);
      else if (d.pct >= 70) result.red_flags.warning.push(`${d.mount} disk ${d.pct}% full`);
      else result.red_flags.ok.push(`${d.mount} disk ${d.pct}%`);
    }
    if (result.ssh) {
      if (/^yes$/i.test(result.ssh.permit_root_login))
        result.red_flags.critical.push('PermitRootLogin yes');
      if (/^yes$/i.test(result.ssh.password_auth) && /^22$/.test(result.ssh.port))
        result.red_flags.critical.push('PasswordAuthentication yes on port 22');
    }
    if (result.docker) {
      const exited = result.docker.containers.filter((c) => /^Exited/.test(c.status));
      if (exited.length > 0)
        result.red_flags.warning.push(`${exited.length} exited container(s): ${exited.map((c) => c.names).join(', ')}`);
    }
    if (result.services.failed.length > 0)
      result.red_flags.warning.push(`failed units: ${result.services.failed.join(', ')}`);
    if (result.updates.reboot_required)
      result.red_flags.warning.push('reboot-required pending');
    if (result.updates.upgradable > 50)
      result.red_flags.warning.push(`${result.updates.upgradable} upgradable packages`);

    return result;
  }

  private parseDf(text: string): BaselineResult['disk'] {
    const out: BaselineResult['disk'] = [];
    const lines = text.split('\n').slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split(/\s+/);
      if (cols.length < 7) continue;
      const pct = parseInt(cols[5].replace('%', ''), 10);
      out.push({
        filesystem: cols[0],
        size: cols[2],
        used: cols[3],
        avail: cols[4],
        pct: isNaN(pct) ? 0 : pct,
        mount: cols.slice(6).join(' '),
      });
    }
    return out;
  }

  private parseFree(text: string): BaselineResult['memory'] {
    const memLine = text.split('\n').find((l) => /^Mem:/.test(l)) || '';
    const c = memLine.split(/\s+/);
    return {
      total: c[1] || 'n/a',
      used: c[2] || 'n/a',
      free: c[3] || 'n/a',
      available: c[c.length - 1] || 'n/a',
    };
  }

  private parseListeners(text: string): BaselineResult['net']['listeners'] {
    const out: BaselineResult['net']['listeners'] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split(/\s+/);
      if (cols.length < 5) continue;
      out.push({
        proto: cols[0],
        address: cols[4] || '',
        pid_program: cols.slice(5).join(' ').slice(0, 80),
      });
    }
    return out;
  }

  private formatBaseline(r: BaselineResult, compact: boolean): string {
    const lines: string[] = [];
    lines.push('=== ssh_audit_baseline ===');
    lines.push(`host:    ${r.hostname}`);
    lines.push(`os:      ${r.os}`);
    lines.push(`kernel:  ${r.kernel}`);
    lines.push(`uptime:  ${r.uptime}`);
    lines.push(`date:    ${r.date_utc}`);
    lines.push(`load:    ${r.load}`);
    lines.push('');

    if (r.red_flags.critical.length > 0) {
      lines.push('CRITICAL:');
      for (const x of r.red_flags.critical) lines.push(`  - ${x}`);
      lines.push('');
    }
    if (r.red_flags.warning.length > 0) {
      lines.push('WARNING:');
      for (const x of r.red_flags.warning) lines.push(`  - ${x}`);
      lines.push('');
    }

    lines.push('disk:');
    for (const d of r.disk) lines.push(`  ${d.mount}: ${d.used}/${d.size} (${d.pct}%)`);
    lines.push('');
    lines.push(`memory: total=${r.memory.total} used=${r.memory.used} avail=${r.memory.available}`);
    lines.push('');

    lines.push(`listeners (${r.net.listeners.length}):`);
    const showN = compact ? 15 : r.net.listeners.length;
    for (const l of r.net.listeners.slice(0, showN))
      lines.push(`  ${l.proto.padEnd(5)} ${l.address.padEnd(28)} ${l.pid_program}`);
    if (r.net.listeners.length > showN)
      lines.push(`  ... +${r.net.listeners.length - showN} more`);
    lines.push('');

    if (r.ssh) {
      lines.push('sshd:');
      lines.push(`  port=${r.ssh.port} root=${r.ssh.permit_root_login} pwauth=${r.ssh.password_auth} pubkey=${r.ssh.pubkey_auth}`);
      lines.push('');
    }

    lines.push(`services: running=${r.services.running_count}, failed=${r.services.failed.length}`);
    if (r.services.failed.length > 0)
      lines.push(`  failed: ${r.services.failed.join(', ')}`);
    lines.push('');

    if (r.docker) {
      lines.push(`docker: containers=${r.docker.containers.length}`);
      for (const c of r.docker.containers.slice(0, compact ? 8 : r.docker.containers.length))
        lines.push(`  ${c.names.padEnd(30)} ${c.status.padEnd(20)} ${c.image}`);
      lines.push('');
    } else {
      lines.push('docker: not installed or not accessible');
      lines.push('');
    }

    lines.push(`firewall: ufw_active=${/Status: active/.test(r.firewall.ufw)}, iptables_rules=${r.firewall.iptables_rules}`);
    lines.push(`updates:  upgradable=${r.updates.upgradable}, reboot_required=${r.updates.reboot_required}`);
    lines.push('');

    lines.push('--- raw JSON ---');
    lines.push(JSON.stringify(r, null, 2));
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // ssh_tls_check
  // ---------------------------------------------------------------------------

  private async handleTlsCheck(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const domain: string = args.domain;
    const port: number = args.port || 443;
    const checkRenew: boolean = args.check_renew_hook !== false;

    if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
      throw new Error(`Invalid domain: ${domain}`);
    }

    const SEP = '__SSH_MCP_TLS_SEP__';
    const opensslCmd =
      `echo | openssl s_client -connect ${shellQuote(`${domain}:${port}`)} ` +
      `-servername ${shellQuote(domain)} -showcerts 2>/dev/null | ` +
      `openssl x509 -noout -dates -ext subjectAltName -issuer 2>/dev/null`;
    const renewCmd = checkRenew
      ? `(grep -h '^renew_hook' /etc/letsencrypt/renewal/*.conf 2>/dev/null; ` +
        `ls -la /etc/letsencrypt/renewal-hooks/deploy/ 2>/dev/null) | head -40`
      : 'echo SKIPPED';
    const cmd =
      `echo "${SEP}cert${SEP}"; ${opensslCmd}; ` +
      `echo "${SEP}renew${SEP}"; ${renewCmd}`;

    const r = await this.executor.execute(sshConfig, cmd, {
      profileName,
      timeout: 30000,
      idempotent: true,
    });
    const sections = this.splitSections(r.stdout, SEP);
    const cert = sections.get('cert') || '';
    const renew = sections.get('renew') || '';

    const notAfterMatch = cert.match(/notAfter=(.+)$/m);
    const notAfter = notAfterMatch ? notAfterMatch[1].trim() : null;
    const now = new Date();
    const daysLeft = notAfter
      ? Math.floor((new Date(notAfter).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const sanLine = cert.match(/X509v3 Subject Alternative Name:\s*\n\s*(.+)/) ||
      cert.match(/Subject Alternative Name:\s*(.+)/);
    const sanText = sanLine ? sanLine[1] : '';
    const sanIncludes = sanText
      .split(/[,\s]+/)
      .map((x) => x.replace(/^DNS:/, ''))
      .filter(Boolean)
      .includes(domain);

    const issuerMatch = cert.match(/issuer=(.+)$/m);
    const issuer = issuerMatch ? issuerMatch[1].trim() : null;

    const renewHookConfigured =
      checkRenew &&
      (/renew_hook\s*=/.test(renew) || /reload-?nginx|systemctl/.test(renew));

    const out = {
      domain,
      port,
      not_after: notAfter,
      days_until_expiry: daysLeft,
      san_includes_hostname: sanIncludes,
      san_text: sanText.slice(0, 200),
      issuer,
      renew_hook_configured: renewHookConfigured,
      renew_hook_evidence: renew.slice(0, 400),
    };

    const flags: string[] = [];
    if (daysLeft !== null && daysLeft <= 0) flags.push('CRITICAL: certificate EXPIRED');
    else if (daysLeft !== null && daysLeft <= 7) flags.push(`CRITICAL: expires in ${daysLeft} days`);
    else if (daysLeft !== null && daysLeft <= 30) flags.push(`WARNING: expires in ${daysLeft} days`);
    if (!sanIncludes) flags.push(`CRITICAL: SAN does not include ${domain}`);
    if (checkRenew && !renewHookConfigured) flags.push('WARNING: no Let\'s Encrypt deploy_hook configured');

    const text =
      `=== ssh_tls_check ${domain}:${port} ===\n` +
      flags.map((f) => `  ${f}`).join('\n') +
      (flags.length ? '\n\n' : '\n') +
      JSON.stringify(out, null, 2);

    return { content: [{ type: 'text', text }] };
  }

  // ---------------------------------------------------------------------------
  // ssh_disk_breakdown
  // ---------------------------------------------------------------------------

  private async handleDiskBreakdown(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const topN = shellCount(args.top_n ?? 20, 'top_n');
    const requestedPaths: string[] = args.paths && args.paths.length ? args.paths : ['/'];
    const paths = requestedPaths.map((p) => shellQuote(p));

    const SEP = '__SSH_MCP_DISK_SEP__';
    // В разделителе секции стоит номер, а не путь: путь попадал внутрь двойных
    // кавычек `echo`, где кавычки от `shellQuote` — обычные буквы, а `$( )`
    // исполняется
    const duCmds = paths
      .map(
        (p, index) =>
          `echo "${SEP}du_${index}${SEP}"; du -shx ${p}/* 2>/dev/null | sort -rh | head -${topN}`
      )
      .join('; ');

    const cmd =
      `echo "${SEP}df${SEP}"; df -hT 2>/dev/null; ` +
      duCmds + '; ' +
      `echo "${SEP}docker${SEP}"; (docker system df -v 2>/dev/null) || echo NO_DOCKER; ` +
      `echo "${SEP}journald${SEP}"; (journalctl --disk-usage 2>/dev/null) || echo NO_JOURNALD; ` +
      `echo "${SEP}var_log${SEP}"; du -sh /var/log/* 2>/dev/null | sort -rh | head -${topN}; ` +
      `echo "${SEP}cache${SEP}"; du -sh "$HOME"/.cache/* 2>/dev/null | sort -rh | head -${topN}`;

    const r = await this.executor.execute(sshConfig, cmd, {
      profileName,
      timeout: 120000,
      idempotent: true,
    });

    // Имя пути возвращается в заголовки секций уже здесь, у нас: человеку нужно
    // видеть, какой каталог показан, но на сервере этому имени делать нечего
    const named = requestedPaths.reduce(
      (text, path, index) => text.split(`${SEP}du_${index}${SEP}`).join(`${SEP}du_${path}${SEP}`),
      r.stdout
    );

    return { content: [{ type: 'text', text: `=== ssh_disk_breakdown ===\n${named}` }] };
  }

  // ---------------------------------------------------------------------------
  // ssh_service_status
  // ---------------------------------------------------------------------------

  private async handleServiceStatus(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const profileName = args.profile || 'default';
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const unit: string = args.unit;
    const lines = shellCount(args.log_lines ?? 50, 'log_lines');
    const since: string | undefined = args.since;

    if (!unit || !/^[a-zA-Z0-9@._-]+$/.test(unit)) {
      throw new Error(`Invalid unit name: ${unit}`);
    }

    const SEP = '__SSH_MCP_SVC_SEP__';
    const sinceArg = since ? ` --since ${shellQuote(since)}` : '';
    const cmd =
      `echo "${SEP}status${SEP}"; systemctl status ${shellQuote(unit)} --no-pager 2>&1 | head -40; ` +
      `echo "${SEP}is_enabled${SEP}"; systemctl is-enabled ${shellQuote(unit)} 2>&1; ` +
      `echo "${SEP}show${SEP}"; systemctl show ${shellQuote(unit)} --property=Restart,RestartSec,LoadState,ActiveState,SubState 2>&1; ` +
      `echo "${SEP}log${SEP}"; journalctl -u ${shellQuote(unit)} -n ${lines} --no-pager${sinceArg} 2>&1`;

    const r = await this.executor.execute(sshConfig, cmd, {
      profileName,
      timeout: 30000,
      idempotent: true,
    });
    const sections = this.splitSections(r.stdout, SEP);
    const out = {
      unit,
      is_enabled: (sections.get('is_enabled') || '').trim(),
      props: this.parseShowProps(sections.get('show') || ''),
      status_head: (sections.get('status') || '').trim(),
      recent_log: (sections.get('log') || '').trim(),
    };
    const text =
      `=== ssh_service_status ${unit} ===\n` +
      `enabled: ${out.is_enabled}\n` +
      `active:  ${out.props.ActiveState || '?'}/${out.props.SubState || '?'}\n` +
      `restart: ${out.props.Restart || '?'} (${out.props.RestartSec || '?'}s)\n\n` +
      `--- status ---\n${out.status_head}\n\n` +
      `--- last ${lines} log lines ---\n${out.recent_log}`;
    return { content: [{ type: 'text', text }] };
  }

  private parseShowProps(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }
}
