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
 * Output is structured (section headers + JSON in the text, and the same JSON
 * as structuredContent where an output schema is declared), so agents can
 * consume it without N follow-up ssh_exec calls.
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { shellCount, shellQuote } from '../utils/shell-arg.js';
import { parseDfTable } from '../utils/df-table.js';
import {
  BASELINE_OUTPUT_SCHEMA,
  TLS_CHECK_OUTPUT_SCHEMA,
  type BaselineResult,
  type TlsCheckResult,
} from './audit-output.js';

/** ssh_audit_baseline arguments, matching its inputSchema */
interface BaselineArgs {
  profile?: string;
  include?: string[];
  include_sudo_sections?: boolean;
  compact?: boolean;
}

/** ssh_tls_check arguments, matching its inputSchema */
interface TlsCheckArgs {
  profile?: string;
  domain?: unknown;
  port?: number;
  check_renew_hook?: boolean;
  sudo?: boolean;
}

/** ssh_disk_breakdown arguments, matching its inputSchema */
interface DiskBreakdownArgs {
  profile?: string;
  top_n?: unknown;
  paths?: string[];
}

/** ssh_service_status arguments, matching its inputSchema */
interface ServiceStatusArgs {
  profile?: string;
  unit?: unknown;
  log_lines?: unknown;
  since?: string;
}

export class AuditTool {
  /** Report section names — also the list of values `include` accepts */
  private static readonly BASELINE_SECTIONS = [
    'system', 'disk', 'mem', 'net', 'ssh', 'services', 'docker', 'firewall', 'updates',
  ];

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
        outputSchema: BASELINE_OUTPUT_SCHEMA,
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
            sudo: {
              type: 'boolean',
              description:
                'Read the Let\'s Encrypt renewal config with sudo. Without it an unprivileged user cannot see the hooks. Default: false.',
              default: false,
            },
          },
          required: ['domain'],
        },
        outputSchema: TLS_CHECK_OUTPUT_SCHEMA,
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

  async handleCall(request: CallToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const toolName = request.params.name;
    try {
      switch (toolName) {
        case 'ssh_audit_baseline':
          return await this.handleBaseline(request, signal);
        case 'ssh_tls_check':
          return await this.handleTlsCheck(request, signal);
        case 'ssh_disk_breakdown':
          return await this.handleDiskBreakdown(request, signal);
        case 'ssh_service_status':
          return await this.handleServiceStatus(request, signal);
        default:
          throw new Error(`Unknown audit tool: ${toolName}`);
      }
    } catch (error: any) {
      logger.error(`${toolName} failed:`, error);
      return toolFailure(error);
    }
  }

  // ---------------------------------------------------------------------------
  // ssh_audit_baseline
  // ---------------------------------------------------------------------------

  private async handleBaseline(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as BaselineArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    // sshd settings are always requested: under root they can be read without
    // sudo, and omitting the section would leave a full audit silent about
    // password login. `include_sudo_sections` selects the reading method,
    // not whether the section is present
    const include: string[] = args.include || [
      'system', 'disk', 'mem', 'net', 'ssh', 'services', 'docker', 'firewall', 'updates',
    ];
    const unknown = include.filter((name) => !AuditTool.BASELINE_SECTIONS.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown audit section(s): ${unknown.join(', ')}. ` +
          `Available: ${AuditTool.BASELINE_SECTIONS.join(', ')}.`
      );
    }
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
      // No -x: BusyBox does not know that option and aborts on the first one
      // ("df: unrecognized option: x"), with the output going to /dev/null —
      // the disk section would come out silently empty on every BusyBox
      // machine. Pseudo filesystems are filtered out during parsing, by the
      // Type column.
      parts.push({ key: 'df', cmd: 'df -hT 2>/dev/null' });
    }
    if (include.includes('mem')) {
      parts.push({ key: 'free', cmd: 'free -h 2>/dev/null || vm_stat 2>/dev/null' });
    }
    if (include.includes('net')) {
      // A marker is required: without it a server with neither ss nor netstat
      // returns emptiness indistinguishable from "nothing is listening"
      parts.push({
        key: 'listeners',
        cmd: 'ss -tulpenH 2>/dev/null || netstat -tulpn 2>/dev/null || echo NO_NET_TOOL',
      });
      parts.push({ key: 'interfaces', cmd: 'ip -br a 2>/dev/null || ifconfig 2>/dev/null | head -40' });
    }
    if (include.includes('ssh')) {
      // Requires sudo
      parts.push({ key: 'sshd', cmd: 'sshd -T 2>/dev/null | grep -E "^(port|permitrootlogin|passwordauth|pubkeyauth|usedns)"' });
    }
    if (include.includes('services')) {
      // A systemd failure travels through as text instead of being silenced:
      // without it "zero services" gets printed even where there was no one to ask
      parts.push({
        key: 'failed',
        cmd:
          'if command -v systemctl >/dev/null 2>&1; then ' +
          'systemctl --failed --no-legend --plain 2>&1; ' +
          'else echo NO_SYSTEMCTL; fi',
      });
      parts.push({
        key: 'running_count',
        cmd:
          'if ! command -v systemctl >/dev/null 2>&1; then echo NO_SYSTEMCTL; ' +
          'elif out=$(systemctl list-units --type=service --state=running --no-legend --plain 2>&1); then ' +
          'printf \'%s\\n\' "$out" | grep -c .; ' +
          'else printf \'%s\\n\' "$out"; fi',
      });
    }
    if (include.includes('docker')) {
      parts.push({ key: 'docker_ps', cmd: 'docker ps -a --format "{{.ID}}\\t{{.Image}}\\t{{.Status}}\\t{{.Names}}" 2>/dev/null || echo NO_DOCKER' });
      parts.push({ key: 'docker_df', cmd: 'docker system df 2>/dev/null || echo NO_DOCKER' });
    }
    if (include.includes('firewall')) {
      // Markers are required: without them ufw being absent and a permission
      // refusal give the same empty output as a disabled firewall — and the
      // report would call it "disabled"
      parts.push({
        key: 'ufw',
        cmd:
          'if command -v ufw >/dev/null 2>&1; then ' +
          'ufw status verbose 2>/dev/null || echo NO_UFW_ACCESS; ' +
          'else echo NO_UFW; fi',
      });
      parts.push({
        key: 'iptables',
        cmd:
          'if command -v iptables >/dev/null 2>&1; then ' +
          'iptables -nL 2>/dev/null | wc -l; ' +
          'else echo NO_IPTABLES; fi',
      });
      // Container ports are published by rules in the nat table, and it
      // fires before the ufw rules: an enabled firewall does not close them
      parts.push({
        key: 'docker_nat',
        cmd:
          'if ! command -v docker >/dev/null 2>&1; then echo NO_DOCKER; ' +
          'elif out=$(iptables -t nat -S DOCKER 2>/dev/null); then printf \'%s\\n\' "$out"; ' +
          'else echo NO_DOCKER_NAT_ACCESS; fi',
      });
      // The number of rules says nothing about protection: a hundred lines can
      // exist on a machine where everything is allowed. The INPUT chain
      // policy answers that instead
      parts.push({
        key: 'iptables_input',
        cmd:
          'if ! command -v iptables >/dev/null 2>&1; then echo NO_IPTABLES; ' +
          'elif out=$(iptables -nL INPUT 2>/dev/null); then printf \'%s\\n\' "$out" | head -1; ' +
          'else echo NO_IPTABLES_ACCESS; fi',
      });
    }
    if (include.includes('updates')) {
      parts.push({
        key: 'upgradable',
        cmd:
          'if command -v apt >/dev/null 2>&1; then ' +
          'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; ' +
          'else echo NO_APT; fi',
      });
      parts.push({ key: 'reboot_required', cmd: '(test -f /var/run/reboot-required && echo YES) || echo NO' });
    }

    const compound = parts
      .map((p) => `echo "${SEP}${p.key}${SEP}"; ${p.cmd}`)
      .join('; ');

    const useSudo = include.includes('ssh') && !!args.include_sudo_sections;
    const r = await this.executor.execute(sshConfig, compound, {
      sudo: useSudo,
      timeout: 60000,
      idempotent: true,
      signal,
    });

    const sections = this.splitSections(r.stdout, SEP);
    const result = this.buildBaselineResult(sections, compact, new Set(include), useSudo);
    return {
      content: [
        { type: 'text', text: this.formatBaseline(result, compact) },
      ],
      structuredContent: result,
    };
  }

  private splitSections(stdout: string, sep: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = new RegExp(`${sep}([a-z0-9_]+)${sep}\\n?`, 'g');
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

  private buildBaselineResult(
    s: Map<string, string>,
    compact: boolean,
    include: Set<string>,
    useSudo: boolean
  ): BaselineResult {
    const trimLines = (txt: string, n: number) =>
      compact ? txt.split('\n').slice(0, n).join('\n') : txt;

    const unavailable: string[] = [];
    const result: BaselineResult = {
      unavailable,
      red_flags: { critical: [], warning: [], ok: [] },
    };

    if (include.has('system')) {
      result.hostname = (s.get('hostname') || '').trim();
      result.uptime = (s.get('uptime') || '').trim();
      result.date_utc = (s.get('date_utc') || '').trim();
      result.os = (s.get('os') || '').trim();
      result.kernel = (s.get('kernel') || '').trim();
      result.load = (s.get('load') || '').trim();
    }

    if (include.has('disk')) {
      if (!(s.get('df') || '').trim()) unavailable.push('disk (df gave no output)');
      const df = this.parseDf(s.get('df') || '');
      result.disk = df.disk;
      for (const line of df.unparsed)
        unavailable.push(`disk row df printed in an unexpected shape: ${line}`);
    }

    if (include.has('mem')) {
      result.memory = this.parseFree(s.get('free') || '');
    }

    if (include.has('net')) {
      const listenersText = (s.get('listeners') || '').trim();
      if (!listenersText || listenersText === 'NO_NET_TOOL')
        unavailable.push('listeners (neither ss nor netstat on the server)');
      result.net = {
        listeners: this.parseListeners(trimLines(s.get('listeners') || '', 80)),
        interfaces: (s.get('interfaces') || '').split('\n').filter(Boolean).slice(0, compact ? 10 : 100),
      };
    }

    if (include.has('services')) {
      // The section is absent from the response entirely when there is
      // nothing to run it with: zero in `running_count` is a statement about
      // the server, not an admission of not knowing
      const failedText = (s.get('failed') || '').trim();
      const runningText = (s.get('running_count') || '').trim();
      const reason = AuditTool.servicesUnavailable(failedText, runningText);

      if (reason) {
        unavailable.push(`services (${reason})`);
      } else {
        result.services = {
          failed: failedText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.split(/\s+/)[0]),
          running_count: parseInt(runningText || '0', 10) || 0,
        };
      }
    }

    // The INPUT chain policy is not part of the response schema, but it
    // decides whether the machine filters traffic at all
    let inputPolicy = '';
    /** Container ports published past the filter */
    let publishedPorts: string[] = [];

    if (include.has('firewall')) {
      result.firewall = this.parseFirewall(
        trimLines(s.get('ufw') || '', 12),
        (s.get('iptables') || '').trim()
      );
      inputPolicy = (((s.get('iptables_input') || '').match(/policy\s+(\w+)/) || [])[1] || '').toUpperCase();
      publishedPorts = AuditTool.dockerPublishedPorts(s.get('docker_nat') || '');
      if (result.firewall.ufw.status === 'no_access')
        unavailable.push('firewall/ufw (installed, but its status is not readable — needs sudo?)');
      if (result.firewall.iptables.status === 'no_access')
        unavailable.push('firewall/iptables (installed, but its rules are not readable — needs sudo?)');
    }

    if (include.has('updates')) {
      const upgradableText = (s.get('upgradable') || '').trim();

      if (upgradableText === 'NO_APT') {
        unavailable.push('updates (no apt on the server)');
      } else {
        result.updates = {
          upgradable: parseInt(upgradableText || '0', 10) || 0,
          reboot_required: (s.get('reboot_required') || '').trim() === 'YES',
        };
      }
    }

    if (include.has('ssh')) {
      const sshd = (s.get('sshd') || '').trim();
      if (!sshd) {
        // An empty `sshd -T` means "not checked", and running the red-flags
        // check on empty fields would declare an unsafe setup safe
        unavailable.push(
          useSudo
            ? 'sshd config (sshd -T gave no output)'
            : 'sshd config (sshd -T gave no output — run with include_sudo_sections: true)'
        );
      } else {
        const get = (k: string) =>
          (sshd.match(new RegExp(`^${k}\\s+(.+)$`, 'm')) || [])[1] || '';
        result.ssh = {
          port: get('port'),
          permit_root_login: get('permitrootlogin'),
          password_auth: get('passwordauthentication'),
          pubkey_auth: get('pubkeyauthentication'),
        };
      }
    }

    if (include.has('docker')) {
      const ps = (s.get('docker_ps') || '').trim();
      result.docker =
        ps && ps !== 'NO_DOCKER'
          ? {
              containers: ps
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                  const [id, image, status, names] = line.split('\t');
                  return { id, image, status, names };
                }),
              df: trimLines(s.get('docker_df') || '', 8),
            }
          : null;
    }

    // Red-flags classification
    for (const d of result.disk ?? []) {
      if (d.pct >= 90) result.red_flags.critical.push(`${d.mount} disk ${d.pct}% full`);
      else if (d.pct >= 70) result.red_flags.warning.push(`${d.mount} disk ${d.pct}% full`);
      else result.red_flags.ok.push(`${d.mount} disk ${d.pct}%`);
    }
    if (result.ssh) {
      if (/^yes$/i.test(result.ssh.permit_root_login))
        result.red_flags.critical.push('PermitRootLogin yes');
      // Port does not enter the condition: password auth is dangerous on any
      // port, and a non-standard port only cuts down on junk brute-forcing
      if (/^yes$/i.test(result.ssh.password_auth))
        result.red_flags.critical.push('PasswordAuthentication yes');
    }

    // The configured port and the listening port are facts from different
    // sources: a socket can set the port, and then the daemon ignores the
    // `Port` directive
    if (result.ssh?.port && result.net && result.net.listeners.length > 0) {
      const listening = AuditTool.sshdListenerPorts(result.net.listeners);
      if (listening.length === 0)
        unavailable.push('sshd port (no sshd among the listeners — the config port is unconfirmed)');
      else if (!listening.includes(result.ssh.port))
        result.red_flags.warning.push(
          `sshd config says port ${result.ssh.port}, but sshd listens on ${listening.join(', ')}`
        );
    }
    if (result.firewall) {
      const { ufw, iptables } = result.firewall;
      const ufwActive = ufw.active === true;
      // A built-in chain's policy is only ever ACCEPT or DROP: the kernel
      // does not accept REJECT in that role
      const chainFilters = inputPolicy === 'DROP';
      // There is nothing to say about a firewall we were not allowed to see:
      // it is already named in the unavailable list, and naming it twice adds nothing
      const chainKnown = iptables.status === 'not_installed' || inputPolicy !== '';

      // The firewall is on, and container ports are exposed anyway: the nat
      // rule fires before the filter, so "firewall active" alone is misleading
      if ((ufwActive || chainFilters) && publishedPorts.length > 0)
        result.red_flags.warning.push(
          `docker publishes port(s) ${publishedPorts.join(', ')} past the firewall (nat/DOCKER runs before the filter rules)`
        );

      if (ufwActive) result.red_flags.ok.push('firewall active (ufw)');
      else if (chainFilters)
        result.red_flags.ok.push(`firewall active (iptables INPUT policy ${inputPolicy})`);
      else if (ufw.status !== 'no_access' && chainKnown)
        result.red_flags.warning.push(
          `no firewall: ufw ${ufw.status === 'not_installed' ? 'not installed' : 'inactive'}, ` +
            `${iptables.status === 'not_installed' ? 'iptables not installed' : `iptables INPUT policy ${inputPolicy}`}` +
            ' — incoming traffic is not filtered'
        );
    }
    if (result.docker) {
      const exited = result.docker.containers.filter((c) => /^Exited/.test(c.status));
      if (exited.length > 0)
        result.red_flags.warning.push(`${exited.length} exited container(s): ${exited.map((c) => c.names).join(', ')}`);
    }
    if (result.services && result.services.failed.length > 0)
      result.red_flags.warning.push(`failed units: ${result.services.failed.join(', ')}`);
    if (result.updates?.reboot_required)
      result.red_flags.warning.push('reboot-required pending');
    if (result.updates && result.updates.upgradable > 50)
      result.red_flags.warning.push(`${result.updates.upgradable} upgradable packages`);

    return result;
  }

  private parseDf(text: string): { disk: BaselineResult['disk']; unparsed: string[] } {
    const table = parseDfTable(text);
    return {
      disk: table.rows.map(({ filesystem, size, used, avail, pct, mount }) => ({
        filesystem,
        size,
        used,
        avail,
        pct,
        mount,
      })),
      unparsed: table.unparsed,
    };
  }

  /**
   * Firewall state from the section command's markers.
   *
   * An empty `iptables` rule list also means "not checked": even on a machine
   * without a single rule, the command prints three chain headers.
   */
  private parseFirewall(ufwText: string, iptablesText: string): NonNullable<BaselineResult['firewall']> {
    const ufw = ufwText.trim();
    const iptablesRules = parseInt(iptablesText, 10);

    return {
      ufw:
        ufw === 'NO_UFW'
          ? { status: 'not_installed', text: '' }
          : ufw === 'NO_UFW_ACCESS' || !ufw
            ? { status: 'no_access', text: '' }
            : { status: 'read', active: /Status: active/.test(ufw), text: ufwText },
      iptables:
        iptablesText === 'NO_IPTABLES'
          ? { status: 'not_installed' }
          : isNaN(iptablesRules) || iptablesRules === 0
            ? { status: 'no_access' }
            : { status: 'read', rules: iptablesRules },
    };
  }

  /**
   * Memory figures by the header's column names.
   *
   * `free` from procps older than 2014 has no `available` column at all, and
   * `cached` comes last instead: taken by position, it would pass cache off
   * as free memory — twice as much as there actually is.
   */
  private parseFree(text: string): BaselineResult['memory'] {
    const lines = text.split('\n');
    const names = (lines.find((l) => /^\s+total\b/.test(l)) || '').trim().split(/\s+/).filter(Boolean);
    const values = (lines.find((l) => /^Mem:/.test(l)) || '').trim().split(/\s+/).slice(1);

    // Without a header, only the column order common to every `free` is left;
    // `available` has no place in that order — not every build prints it
    const column = (name: string, position?: number) => {
      if (names.length === 0) return (position === undefined ? '' : values[position]) || 'n/a';
      const at = names.indexOf(name);
      return (at >= 0 ? values[at] : '') || 'n/a';
    };

    return {
      total: column('total', 0),
      used: column('used', 1),
      free: column('free', 2),
      available: column('available'),
    };
  }

  /**
   * Parsing the list of listening sockets.
   *
   * There are two sources, and their columns differ: for `ss` the local
   * address is fifth, for `netstat` — fourth, with two more header lines
   * before it. So instead of a column number, we look for the first address
   * shaped like `host:port` with a numeric port: for both commands that is
   * exactly the socket being listened on. This also filters out netstat's
   * headers — left unfiltered, they would show up in the report as entries
   * like `{ proto: "Proto", address: "Address" }`.
   */
  private parseListeners(text: string): NonNullable<BaselineResult['net']>['listeners'] {
    const out: NonNullable<BaselineResult['net']>['listeners'] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split(/\s+/);
      if (cols.length < 5) continue;

      const addressAt = cols.findIndex((col, index) => index > 0 && /^\S*:\d+$/.test(col));
      if (addressAt === -1) continue;

      out.push({
        proto: cols[0],
        address: cols[addressAt],
        pid_program: cols.slice(addressAt + 1).join(' ').slice(0, 80),
      });
    }
    return out;
  }

  /**
   * Ports sshd itself listens on.
   *
   * The process name sits at the tail of the line for both `ss` and
   * `netstat`; the port is taken after the last colon, otherwise `[::]:2222`
   * would read differently than `0.0.0.0:2222`.
   */
  private static sshdListenerPorts(
    listeners: NonNullable<BaselineResult['net']>['listeners']
  ): string[] {
    const ports = new Set<string>();
    for (const listener of listeners) {
      if (!/\bsshd\b/.test(listener.pid_program)) continue;
      ports.add(listener.address.slice(listener.address.lastIndexOf(':') + 1));
    }
    return [...ports];
  }

  /**
   * Ports published by containers in the nat table.
   *
   * An empty chain answers with a single `-N DOCKER` line; publish rules
   * arrive as `-A DOCKER … --dport N -j DNAT` lines.
   */
  private static dockerPublishedPorts(natRules: string): string[] {
    const ports: string[] = [];
    for (const line of natRules.split('\n')) {
      const port = (line.trim().match(/^-A\s+DOCKER\b.*--dport\s+(\d+)/) || [])[1];
      if (port) ports.push(port);
    }
    return ports;
  }

  private static formatUfw(ufw: NonNullable<BaselineResult['firewall']>['ufw']): string {
    if (ufw.status === 'not_installed') return 'not installed';
    if (ufw.status === 'no_access') return 'NOT CHECKED';
    return ufw.active ? 'active' : 'inactive';
  }

  private static formatIptables(ipt: NonNullable<BaselineResult['firewall']>['iptables']): string {
    if (ipt.status === 'not_installed') return 'not installed';
    if (ipt.status === 'no_access') return 'NOT CHECKED';
    return `${ipt.rules} rule line(s)`;
  }

  private formatBaseline(r: BaselineResult, compact: boolean): string {
    const lines: string[] = [];
    lines.push('=== ssh_audit_baseline ===');
    if (r.hostname !== undefined) {
      lines.push(`host:    ${r.hostname}`);
      lines.push(`os:      ${r.os}`);
      lines.push(`kernel:  ${r.kernel}`);
      lines.push(`uptime:  ${r.uptime}`);
      lines.push(`date:    ${r.date_utc}`);
      lines.push(`load:    ${r.load}`);
      lines.push('');
    }

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

    if (r.unavailable.length > 0) {
      lines.push('NOT CHECKED:');
      for (const x of r.unavailable) lines.push(`  - ${x}`);
      lines.push('');
    }

    if (r.disk) {
      lines.push('disk:');
      for (const d of r.disk) lines.push(`  ${d.mount}: ${d.used}/${d.size} (${d.pct}%)`);
      lines.push('');
    }

    if (r.memory) {
      lines.push(`memory: total=${r.memory.total} used=${r.memory.used} avail=${r.memory.available}`);
      lines.push('');
    }

    if (r.net) {
      lines.push(`listeners (${r.net.listeners.length}):`);
      const showN = compact ? 15 : r.net.listeners.length;
      for (const l of r.net.listeners.slice(0, showN))
        lines.push(`  ${l.proto.padEnd(5)} ${l.address.padEnd(28)} ${l.pid_program}`);
      if (r.net.listeners.length > showN)
        lines.push(`  ... +${r.net.listeners.length - showN} more`);
      lines.push('');
    }

    if (r.ssh) {
      lines.push('sshd:');
      lines.push(`  port=${r.ssh.port} root=${r.ssh.permit_root_login} pwauth=${r.ssh.password_auth} pubkey=${r.ssh.pubkey_auth}`);
      lines.push('');
    }

    if (r.services) {
      lines.push(`services: running=${r.services.running_count}, failed=${r.services.failed.length}`);
      if (r.services.failed.length > 0)
        lines.push(`  failed: ${r.services.failed.join(', ')}`);
      lines.push('');
    }

    if (r.docker) {
      lines.push(`docker: containers=${r.docker.containers.length}`);
      for (const c of r.docker.containers.slice(0, compact ? 8 : r.docker.containers.length))
        lines.push(`  ${c.names.padEnd(30)} ${c.status.padEnd(20)} ${c.image}`);
      lines.push('');
    } else if (r.docker === null) {
      lines.push('docker: not installed or not accessible');
      lines.push('');
    }

    if (r.firewall) {
      lines.push(`firewall: ufw=${AuditTool.formatUfw(r.firewall.ufw)}, iptables=${AuditTool.formatIptables(r.firewall.iptables)}`);
    }
    if (r.updates) {
      lines.push(`updates:  upgradable=${r.updates.upgradable}, reboot_required=${r.updates.reboot_required}`);
    }
    if (r.firewall || r.updates) lines.push('');

    lines.push('--- raw JSON ---');
    lines.push(JSON.stringify(r, null, 2));
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // ssh_tls_check
  // ---------------------------------------------------------------------------

  private async handleTlsCheck(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as TlsCheckArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const domain = args.domain as string;
    const port: number = args.port || 443;
    const checkRenew: boolean = args.check_renew_hook !== false;

    if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
      throw new Error(`Invalid domain: ${domain}`);
    }

    const SEP = '__SSH_MCP_TLS_SEP__';
    // stderr is not silenced: without it the reason for a failure (no
    // openssl, the connection never opened, the domain does not answer)
    // would disappear, and an empty certificate would turn into a claim that
    // "SAN does not include the domain" about a certificate no one ever saw.
    // The extra lines do not confuse the parsing below — it works by regex.
    const opensslCmd =
      `echo | openssl s_client -connect ${shellQuote(`${domain}:${port}`)} ` +
      `-servername ${shellQuote(domain)} -showcerts 2>&1 | ` +
      `openssl x509 -noout -dates -ext subjectAltName -issuer 2>&1`;
    // Markers instead of swallowed errors: without them, "no directory" and
    // "directory unreadable" give the same emptiness, and the report would call it an absent hook
    const renewCmd = checkRenew
      ? `if [ ! -d /etc/letsencrypt ]; then echo NO_LETSENCRYPT; ` +
        `elif [ ! -r /etc/letsencrypt/renewal ] && [ ! -r /etc/letsencrypt/renewal-hooks/deploy ]; then echo LE_UNREADABLE; ` +
        `else (grep -h '^renew_hook' /etc/letsencrypt/renewal/*.conf 2>/dev/null; ` +
        `ls -la /etc/letsencrypt/renewal-hooks/deploy/ 2>/dev/null) | head -40; fi`
      : 'echo SKIPPED';
    const cmd =
      `echo "${SEP}cert${SEP}"; ${opensslCmd}; ` +
      `echo "${SEP}renew${SEP}"; ${renewCmd}`;

    const r = await this.executor.execute(sshConfig, cmd, {
      sudo: !!args.sudo,
      timeout: 30000,
      idempotent: true,
      signal,
    });
    const sections = this.splitSections(r.stdout, SEP);
    const cert = sections.get('cert') || '';
    const renew = (sections.get('renew') || '').trim();

    const notAfterMatch = cert.match(/notAfter=(.+)$/m);
    const notAfter = notAfterMatch ? notAfterMatch[1].trim() : null;
    const now = new Date();
    const daysLeft = notAfter
      ? Math.floor((new Date(notAfter).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // A certificate counts as read only with a parsed date: without it, every
    // other field is empty not because the certificate lacks them
    const certRead = daysLeft !== null && !Number.isNaN(daysLeft);

    const sanLine = cert.match(/X509v3 Subject Alternative Name:\s*\n\s*(.+)/) ||
      cert.match(/Subject Alternative Name:\s*(.+)/);
    const sanText = sanLine ? sanLine[1] : '';
    const sanIncludes = certRead
      ? sanText
          .split(/[,\s]+/)
          .map((x) => x.replace(/^DNS:/, ''))
          .filter(Boolean)
          .includes(domain)
      : null;

    const issuerMatch = cert.match(/issuer=(.+)$/m);
    const issuer = issuerMatch ? issuerMatch[1].trim() : null;

    // A fourth outcome besides "configured" and "not configured": we were not allowed to look
    const renewChecked = checkRenew && renew !== 'LE_UNREADABLE';
    const renewHookConfigured = renewChecked
      ? /renew_hook\s*=/.test(renew) || /reload-?nginx|systemctl/.test(renew)
      : null;

    const out: TlsCheckResult = {
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
    if (!certRead) {
      const reason = cert.split('\n').map((l) => l.trim()).find(Boolean) ?? 'no output from openssl';
      flags.push(`UNKNOWN: certificate not read — ${reason.slice(0, 160)}`);
    } else if (daysLeft! <= 0) flags.push('CRITICAL: certificate EXPIRED');
    else if (daysLeft! <= 7) flags.push(`CRITICAL: expires in ${daysLeft} days`);
    else if (daysLeft! <= 30) flags.push(`WARNING: expires in ${daysLeft} days`);
    if (certRead && !sanIncludes) flags.push(`CRITICAL: SAN does not include ${domain}`);
    if (checkRenew && !renewChecked)
      flags.push(
        'UNKNOWN: Let\'s Encrypt renewal config not readable — retry with sudo: true'
      );
    else if (checkRenew && renew === 'NO_LETSENCRYPT')
      flags.push('INFO: Let\'s Encrypt is not set up on this server');
    else if (checkRenew && !renewHookConfigured)
      flags.push('WARNING: no Let\'s Encrypt deploy_hook configured');

    const text =
      `=== ssh_tls_check ${domain}:${port} ===\n` +
      flags.map((f) => `  ${f}`).join('\n') +
      (flags.length ? '\n\n' : '\n') +
      JSON.stringify(out, null, 2);

    return {
      content: [{ type: 'text', text }],
      structuredContent: out,
    };
  }

  // ---------------------------------------------------------------------------
  // ssh_disk_breakdown
  // ---------------------------------------------------------------------------

  private async handleDiskBreakdown(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as DiskBreakdownArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const topN = shellCount(args.top_n ?? 20, 'top_n');
    const requestedPaths: string[] = args.paths && args.paths.length ? args.paths : ['/'];
    const paths = requestedPaths.map((p) => shellQuote(p));

    const SEP = '__SSH_MCP_DISK_SEP__';
    // The section separator carries an index, not the path: a path would land
    // inside the `echo` double quotes, where quotes from `shellQuote` are
    // just letters and `$( )` executes
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
      timeout: 120000,
      idempotent: true,
      signal,
    });

    // The separator is a way to slice the output, not part of the answer:
    // left untouched, it would travel to the user as is, along with the section number instead of the directory name
    const sections = this.splitSections(r.stdout, SEP);
    const titles: Array<[string, string]> = [
      ['df', 'filesystems'],
      ...requestedPaths.map(
        (path, index) => [`du_${index}`, `largest entries under ${path}`] as [string, string]
      ),
      ['docker', 'docker'],
      ['journald', 'journald'],
      ['var_log', '/var/log'],
      ['cache', '$HOME/.cache'],
    ];

    const missing: Record<string, string> = {
      NO_DOCKER: 'not installed',
      NO_JOURNALD: 'not installed',
    };
    const body = titles
      .map(([key, title]) => {
        const section = (sections.get(key) || '').trim();
        return `--- ${title} ---\n${missing[section] ?? section ?? ''}`;
      })
      .join('\n\n');

    return { content: [{ type: 'text', text: `=== ssh_disk_breakdown ===\n${body}` }] };
  }

  // ---------------------------------------------------------------------------
  // ssh_service_status
  // ---------------------------------------------------------------------------

  private async handleServiceStatus(request: CallToolRequest, signal?: AbortSignal) {
    const args = (request.params.arguments ?? {}) as ServiceStatusArgs;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    const unit = args.unit as string;
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
      // RestartUSec — what systemd actually prints: the name RestartSec is
      // absent from `show`'s output, and the delay column would stay a question mark forever
      `echo "${SEP}show${SEP}"; systemctl show ${shellQuote(unit)} --property=Restart,RestartUSec,LoadState,ActiveState,SubState 2>&1; ` +
      `echo "${SEP}log${SEP}"; journalctl -u ${shellQuote(unit)} -n ${lines} --no-pager${sinceArg} 2>&1`;

    const r = await this.executor.execute(sshConfig, cmd, {
      timeout: 30000,
      idempotent: true,
      signal,
    });
    const sections = this.splitSections(r.stdout, SEP);
    const out = {
      unit,
      is_enabled: (sections.get('is_enabled') || '').trim(),
      props: this.parseShowProps(sections.get('show') || ''),
      status_head: (sections.get('status') || '').trim(),
      recent_log: (sections.get('log') || '').trim(),
    };
    // A service that was not asked about and a service that does not exist
    // are different answers, and raw systemctl text in the `enabled` field is neither
    const noSystemd = AuditTool.NO_SYSTEMD.test(out.is_enabled) || AuditTool.NO_SYSTEMD.test(out.status_head);
    const unknownUnit = !noSystemd && AuditTool.NO_UNIT.test(out.is_enabled);
    const enabled = noSystemd
      ? 'NOT CHECKED'
      : unknownUnit
        ? 'no unit by that name'
        : /^[a-z-]+$/.test(out.is_enabled)
          ? out.is_enabled
          : 'NOT CHECKED';
    const state = noSystemd
      ? 'NOT CHECKED'
      : `${out.props.ActiveState || '?'}/${out.props.SubState || '?'}`;
    const pause = out.props.RestartUSec;
    const restart = noSystemd
      ? 'NOT CHECKED'
      : `${out.props.Restart || 'NOT CHECKED'}${pause ? ` (after ${pause})` : ''}`;

    const text =
      `=== ssh_service_status ${unit} ===\n` +
      (noSystemd ? 'NOT CHECKED: systemd did not answer on this server\n' : '') +
      `enabled: ${enabled}\n` +
      `active:  ${state}\n` +
      `restart: ${restart}\n\n` +
      `--- status ---\n${out.status_head}\n\n` +
      `--- last ${lines} log lines ---\n${out.recent_log}`;
    return { content: [{ type: 'text', text }] };
  }

  /**
   * What exactly the services section had nothing to run with — or nothing,
   * if it ran fine.
   *
   * Two different "no"s do not merge: the binary is missing entirely, versus
   * the binary is there but systemd does not answer. An empty answer does not
   * count as a reason — it is the legitimate "no service is running".
   */
  private static servicesUnavailable(failed: string, running: string): string | undefined {
    if (failed === 'NO_SYSTEMCTL' || running === 'NO_SYSTEMCTL') {
      return 'no systemctl on the server';
    }
    if (AuditTool.NO_SYSTEMD.test(failed) || AuditTool.NO_SYSTEMD.test(running)) {
      return 'systemd did not answer on this server';
    }
    return undefined;
  }

  /** Answers by which systemd reports that it is not there at all */
  private static readonly NO_SYSTEMD =
    /not found|has not been booted|Failed to connect to bus|Access denied/i;

  /** The answer by which systemd reports that no such service exists */
  private static readonly NO_UNIT = /No such file or directory|could not be found|not-found/i;

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
