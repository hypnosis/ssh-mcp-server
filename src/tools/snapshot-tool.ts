/**
 * SSH Snapshot Tool
 * Instant system state snapshot
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolFailure, type ToolResult } from '../utils/tool-result.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { parseDfTable, dedupeByDevice } from '../utils/df-table.js';

/**
 * Snapshot Tool
 */
export class SnapshotTool {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Get tool description for MCP
   */
  getTool(): Tool {
    return {
      name: 'ssh_snapshot',
      description: 'Get comprehensive system health snapshot including services, resources, docker, network, and recent errors',
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: 'SSH profile name',
          },
        },
      },
    };
  }
  
  /**
   * Handle tool call
   */
  // Отмену снимок не берёт: сорванное чтение здесь заменяется пустым
  // показателем, и отменённый вызов вернулся бы снимком с пустотами вместо
  // отказа — то есть неполным ответом, выданным за полный
  async handleCall(request: CallToolRequest): Promise<ToolResult> {
    try {
      const args = request.params.arguments as any;
      const sshConfig = resolveSSHConfig({ profile: args.profile });
      
      logger.info('Collecting system snapshot...');
      
      // Collect data in parallel
      const [
        timestamp,
        hostname,
        uptime,
        services,
        cpu,
        memory,
        disk,
        docker,
        network,
        errors,
      ] = await Promise.all([
        this.getTimestamp(sshConfig),
        this.getHostname(sshConfig),
        this.getUptime(sshConfig),
        this.getServices(sshConfig),
        this.getCPU(sshConfig),
        this.getMemory(sshConfig),
        this.getDisk(sshConfig),
        this.getDocker(sshConfig),
        this.getNetwork(sshConfig),
        this.getRecentErrors(sshConfig),
      ]);
      
      // Format beautiful output
      const output = this.formatSnapshot({
        timestamp,
        hostname,
        uptime,
        services,
        resources: { cpu, memory, disk },
        docker,
        network,
        recentErrors: errors,
      });
      
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error: any) {
      logger.error('ssh_snapshot failed:', error);
      return toolFailure(error);
    }
  }
  
  /**
   * Сколько чтений снимка идёт по соединению одновременно.
   *
   * Залп из десяти мгновенных команд dropbear обрывает: часть каналов
   * возвращается кодом 255 с пустым выводом и без текста ошибки. Обрыв лечит
   * повтор в транспорте, а очередь нужна, чтобы не устраивать сервер этот залп:
   * замер на стенде с dropbear дал шесть срывов на шесть снимков вместо
   * тринадцати. OpenSSH-серверы десять одновременных чтений держат без потерь.
   */
  private static readonly READ_CONCURRENCY = 4;

  /** Хвост очереди чтений: следующее ждёт, пока освободится место */
  private readSlots: Array<Promise<void>> = [];

  /**
   * Read a value from the server.
   *
   * Снимок состоит из независимых чтений: неудача одного не должна отменять
   * остальные, поэтому вместо исключения возвращается запасное значение.
   * Все команды снимка — только чтение, поэтому повтор при обрыве связи безопасен.
   */
  private async read(
    config: any,
    command: string,
    options: { sudo?: boolean; fallback?: string } = {}
  ): Promise<string> {
    return this.withSlot(async () => {
      try {
        const result = await this.executor.execute(config, command, {
          sudo: options.sudo,
          idempotent: true,
        });

        if (result.exitCode !== 0) {
          logger.debug(`[Snapshot] "${command}" exited with ${result.exitCode}: ${result.stderr.trim()}`);
          return options.fallback ?? '';
        }

        return result.stdout.trim();
      } catch (error: any) {
        // Сорванное чтение — это пустой показатель, а не пустой снимок:
        // оборвись канал дважды подряд, отчёт целиком заменялся строкой ошибки
        logger.debug(`[Snapshot] "${command}" failed: ${error?.message ?? error}`);
        return options.fallback ?? '';
      }
    });
  }

  /** Пропустить работу, когда одновременных чтений станет меньше предела */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.readSlots.length >= SnapshotTool.READ_CONCURRENCY) {
      await Promise.race(this.readSlots);
    }

    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.readSlots.push(slot);

    try {
      return await work();
    } finally {
      this.readSlots = this.readSlots.filter((s) => s !== slot);
      release();
    }
  }

  /**
   * Get timestamp
   */
  private async getTimestamp(config: any): Promise<string> {
    return this.read(config, 'date -u +"%Y-%m-%dT%H:%M:%SZ"', { fallback: 'unknown' });
  }

  /**
   * Get hostname
   */
  private async getHostname(config: any): Promise<string> {
    return this.read(config, 'hostname', { fallback: 'unknown' });
  }

  /**
   * Get uptime
   */
  private async getUptime(config: any): Promise<string> {
    return (await this.read(config, 'uptime -p', { fallback: 'unknown' }))
      .replace('up ', '');
  }
  
  /**
   * Get service status
   */
  private async getServices(
    config: any,
      ): Promise<{ checked: boolean; reason?: string; items: Array<{ name: string; status: string; uptime: string | null }> }> {
    const services = ['nginx', 'apache2', 'docker', 'postgresql', 'mysql', 'redis', 'mongodb'];
    const results: Array<{ name: string; status: string; uptime: string | null }> = [];

    // Без systemctl каждая проверка отвечает «inactive», и сервер без systemd
    // выглядит сервером, где ни одна служба не работает
    const systemctl = await this.read(
      config,
      'command -v systemctl >/dev/null 2>&1 && echo yes || echo no',
    );
    if (systemctl !== 'yes') return { checked: false, reason: 'no systemctl on the server', items: [] };

    // Команда на месте, а шина может молчать. Тогда каждая проверка службы
    // отвечает ошибкой, `|| echo inactive` превращает её в «остановлена», и
    // непроверенный сервер печатается как сервер без единой работающей службы.
    // Проба спрашивает про сам systemd, а не про юнит: ответ «нет такого юнита»
    // не должен читаться как молчание шины
    const bus = await this.read(config, 'systemctl show --property=Version 2>&1 || true');
    if (SnapshotTool.SYSTEMD_SILENT.test(bus)) {
      return { checked: false, reason: 'systemd did not answer on this server', items: [] };
    }

    for (const service of services) {
      const status = await this.read(
        config,
        `systemctl is-active ${service} 2>/dev/null || echo inactive`,
      );

      // Пустой ответ — это сорванное чтение, а не остановленная служба:
      // молча пропав из списка, она выглядела бы проверенной
      if (!status) {
        results.push({ name: service, status: 'unknown', uptime: null });
        continue;
      }

      if (status === 'active') {
        const startedAt = await this.read(
          config,
          `systemctl show ${service} --property=ActiveEnterTimestamp --value 2>/dev/null || echo ""`,
        );
        results.push({ name: service, status, uptime: startedAt || null });
      }
    }

    return { checked: true, items: results };
  }

  /** Ответы, которыми systemctl сообщает, что шина systemd ему не отвечает */
  private static readonly SYSTEMD_SILENT =
    /has not been booted|Failed to connect to bus|Access denied/i;

  /**
   * Get CPU information
   */
  private async getCPU(
    config: any,
      ): Promise<{ cores: number | null; usage: number | null; loadAvg: string | null }> {
    const coresOutput = await this.read(config, 'nproc');
    const loadOutput = await this.read(config, 'cat /proc/loadavg');
    // Строка сводки разбирается здесь, а не колонкой в awk: у procps она
    // «%Cpu(s): … 95.1 id», у BusyBox «CPU: … 99% idle», и вырезанная вслепую
    // вторая колонка на BusyBox приносила число из таблицы процессов
    const topOutput = await this.read(config, 'top -bn1 2>/dev/null | head -6');

    // Нечитанное число ядер — это не ноль ядер: пустой ответ обрыва выглядел
    // исправной машиной без процессоров
    const parsedCores = parseInt(coresOutput);
    const cores = isNaN(parsedCores) ? null : parsedCores;
    const usage = SnapshotTool.parseCpuUsage(topOutput);
    const load = loadOutput.split(' ').slice(0, 3).join(' ').trim();

    return { cores, usage, loadAvg: load || null };
  }

  /**
   * Занятость процессора из сводной строки `top`: считается от простоя, потому
   * что доля простоя есть в обоих форматах. `null` — строки не нашлось.
   */
  private static parseCpuUsage(topOutput: string): number | null {
    const line = topOutput
      .split('\n')
      .find((l) => /^\s*%?cpu(\(s\))?\s*:/i.test(l));
    if (!line) return null;

    const idle = line.match(/([\d.]+)\s*%?\s*id(?:le)?\b/);
    if (!idle) return null;

    const usage = 100 - parseFloat(idle[1]);
    if (isNaN(usage)) return null;

    return Math.min(100, Math.max(0, usage));
  }
  
  /**
   * Get Memory information
   */
  private async getMemory(config: any): Promise<{ total: string; used: string; free: string; percent: number | null }> {
    const parts = (await this.read(config, 'free -h | grep Mem')).split(/\s+/);
    const total = SnapshotTool.parseSize(parts[1]);
    const used = SnapshotTool.parseSize(parts[2]);

    return {
      total: parts[1] || 'unknown',
      used: parts[2] || 'unknown',
      free: parts[3] || 'unknown',
      percent: total && used ? Math.round((used / total) * 100) : null,
    };
  }

  /** Множители суффиксов `free -h`: и `Gi` от coreutils, и `G` от BusyBox — степени 1024 */
  private static readonly SIZE_FACTOR: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
    p: 1024 ** 5,
  };

  /**
   * Размер с суффиксом в байты. Без приведения к общей единице `506Mi` и
   * `3.8Gi` делились как 506 и 3.8 — отчёт объявлял 13316% занятой памяти.
   */
  private static parseSize(text: string | undefined): number | null {
    const parsed = (text ?? '').match(/^([\d.]+)\s*([a-zA-Z]?)/);
    if (!parsed) return null;

    const value = parseFloat(parsed[1]);
    if (isNaN(value)) return null;

    const factor = parsed[2] ? SnapshotTool.SIZE_FACTOR[parsed[2].toLowerCase()] : 1;
    return factor ? value * factor : null;
  }
  
  /**
   * Get Disk information
   *
   * Тип тома нужен, чтобы отсечь служебные системы ядра: отбор по имени
   * устройства (`^/dev/`) выбрасывал из обзора корень везде, где он лежит
   * на overlay, — то есть в любом контейнере.
   */
  private async getDisk(
    config: any,
      ): Promise<{
    items: Array<{ mount: string; size: string; used: string; avail: string; percent: string }>;
    unparsed: string[];
  }> {
    const output = await this.read(config, 'df -hT');
    if (!output) return { items: [], unparsed: [] };

    const table = parseDfTable(output);
    return {
      items: dedupeByDevice(table.rows).map((row) => ({
        mount: row.mount,
        size: row.size,
        used: row.used,
        avail: row.avail,
        percent: `${row.pct}%`,
      })),
      unparsed: table.unparsed,
    };
  }
  
  /**
   * Get Docker information
   */
  private async getDocker(config: any): Promise<{ containers: any[]; images: number } | undefined> {
    try {
      // Check for Docker presence
      const dockerPath = await this.read(config, 'which docker');
      if (!dockerPath) {
        return undefined;
      }

      // Container list
      const containersOutput = await this.read(
        config,
        'docker ps --format "{{.ID}}|{{.Names}}|{{.Status}}"',
      );

      const containers = containersOutput.split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [id, name, status] = line.split('|');
          return { id, name, status, uptime: status };
        });

      // Image count
      const images = parseInt(await this.read(config, 'docker images -q | wc -l')) || 0;

      return { containers, images };
    } catch {
      return undefined;
    }
  }
  
  /**
   * Get Network information
   */
  private async getNetwork(
    config: any,
      ): Promise<{ checked: boolean; listening: Array<{ port: string; service: string }>; connections: number }> {
    // Маркер обязателен: конвейер заканчивается на `sort`, поэтому отсутствие
    // ss отдавало пустой список с кодом 0 — «никто не слушает» вместо
    // «смотреть было нечем», и запасной netstat не звали никогда
    const portsOutput = await this.read(
      config,
      'if command -v ss >/dev/null 2>&1; then ss -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | sort -u; ' +
        'elif command -v netstat >/dev/null 2>&1; then netstat -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | sort -u; ' +
        'else echo NO_NET_TOOL; fi',
    );

    if (portsOutput.trim() === 'NO_NET_TOOL') {
      return { checked: false, listening: [], connections: 0 };
    }

    // Порт отделяется последним двоеточием, а не первым: у адреса IPv6
    // (`[::]:2222`, `:::22`) двоеточий несколько, и по первому порт был пуст
    const seen = new Set<string>();
    for (const address of portsOutput.split('\n')) {
      const port = address.slice(address.lastIndexOf(':') + 1).trim();
      if (port && /^\d+$/.test(port)) seen.add(port);
    }

    const ports = [...seen].map(port => ({ port, service: this.getServiceByPort(port) }));

    // Connection count
    const connectionsOutput = await this.read(
      config,
      'if command -v ss >/dev/null 2>&1; then ss -tn 2>/dev/null | grep ESTAB | wc -l; ' +
        'else netstat -tn 2>/dev/null | grep ESTABLISHED | wc -l; fi',
    );

    return { checked: true, listening: ports, connections: parseInt(connectionsOutput) || 0 };
  }
  
  /**
   * Get recent errors
   */
  private async getRecentErrors(
    config: any,
      ): Promise<{ checked: boolean; reason?: string; items: Array<{ source: string; message: string; time: string }> }> {
    // Молчание журнала имеет три причины, и раньше все три выглядели как
    // «ошибок нет»: файла нет, читать нечем, читали и не нашли
    const command =
      'if [ ! -f /var/log/syslog ]; then echo NO_SYSLOG; ' +
      'elif [ ! -r /var/log/syslog ]; then echo SYSLOG_UNREADABLE; ' +
      'else tail -n 100 /var/log/syslog | grep -iE "error|fatal|critical" | tail -n 3; fi';

    // Сперва под sudo — журнал обычно закрыт от обычного пользователя. Там, где
    // sudo нет вовсе (root на BusyBox), команда падает целиком, и без второй
    // попытки причина звучала бы «не прошло» даже на сервере без журнала
    let output = await this.read(config, command, {
      sudo: true,
      fallback: 'READ_FAILED',
    });
    if (output === 'READ_FAILED') {
      output = await this.read(config, command, { fallback: 'READ_FAILED' });
    }

    if (output === 'NO_SYSLOG') {
      return { checked: false, reason: 'no /var/log/syslog on the server', items: [] };
    }
    if (output === 'SYSLOG_UNREADABLE') {
      return { checked: false, reason: '/var/log/syslog is not readable', items: [] };
    }
    if (output === 'READ_FAILED') {
      return { checked: false, reason: 'the read did not go through', items: [] };
    }

    const items = output
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ({ source: 'syslog', message: line.substring(0, 100), time: 'recent' }));

    return { checked: true, items };
  }
  
  /**
   * Determine service by port
   */
  private getServiceByPort(port: string): string {
    const portMap: Record<string, string> = {
      '22': 'ssh',
      '80': 'http',
      '443': 'https',
      '3306': 'mysql',
      '5432': 'postgresql',
      '6379': 'redis',
      '27017': 'mongodb',
      '9000': 'php-fpm',
    };
    return portMap[port] || 'unknown';
  }
  
  /**
   * Format snapshot for output
   */
  private formatSnapshot(snapshot: any): string {
    let output = '';
    
    output += '═'.repeat(70) + '\n';
    output += `  SYSTEM SNAPSHOT\n`;
    output += '═'.repeat(70) + '\n\n';
    
    output += `Hostname: ${snapshot.hostname}\n`;
    output += `Timestamp: ${snapshot.timestamp}\n`;
    output += `Uptime: ${snapshot.uptime}\n\n`;
    
    output += '─'.repeat(70) + '\n';
    output += 'SERVICES\n';
    output += '─'.repeat(70) + '\n';
    if (!snapshot.services.checked) {
      output += `  NOT CHECKED: ${snapshot.services.reason}\n`;
    } else if (snapshot.services.items.length > 0) {
      snapshot.services.items.forEach((svc: any) => {
        const mark = svc.status === 'active' ? '✓' : svc.status === 'unknown' ? '?' : '✗';
        const label = svc.status === 'unknown' ? 'NOT CHECKED' : svc.status;
        output += `  ${svc.name.padEnd(15)} ${mark} ${label}\n`;
      });
    } else {
      output += '  No active services detected\n';
    }
    output += '\n';

    output += '─'.repeat(70) + '\n';
    output += 'RESOURCES\n';
    output += '─'.repeat(70) + '\n';
    const cpuUsage =
      snapshot.resources.cpu.usage === null
        ? 'usage NOT CHECKED'
        : `${snapshot.resources.cpu.usage.toFixed(1)}% used`;
    const memPercent =
      snapshot.resources.memory.percent === null
        ? 'usage NOT CHECKED'
        : `${snapshot.resources.memory.percent}% used`;
    const cores =
      snapshot.resources.cpu.cores === null
        ? 'cores NOT CHECKED'
        : `${snapshot.resources.cpu.cores} cores`;
    const load = snapshot.resources.cpu.loadAvg ?? 'NOT CHECKED';
    output += `  CPU:    ${cores}, ${cpuUsage}, load: ${load}\n`;
    output += `  Memory: ${snapshot.resources.memory.used} / ${snapshot.resources.memory.total} (${memPercent})\n`;
    output += `  Disk:\n`;
    snapshot.resources.disk.items.forEach((d: any) => {
      output += `    ${d.mount.padEnd(10)} ${d.used.padEnd(8)} / ${d.size.padEnd(8)} (${d.percent})\n`;
    });
    snapshot.resources.disk.unparsed.forEach((line: string) => {
      output += `    NOT CHECKED: df printed a row in an unexpected shape: ${line}\n`;
    });
    output += '\n';
    
    if (snapshot.docker) {
      output += '─'.repeat(70) + '\n';
      output += 'DOCKER\n';
      output += '─'.repeat(70) + '\n';
      output += `  Containers: ${snapshot.docker.containers.length} running\n`;
      output += `  Images: ${snapshot.docker.images}\n`;
      if (snapshot.docker.containers.length > 0) {
        snapshot.docker.containers.forEach((c: any) => {
          output += `    ${c.name.padEnd(20)} ${c.status}\n`;
        });
      }
      output += '\n';
    }
    
    output += '─'.repeat(70) + '\n';
    output += 'NETWORK\n';
    output += '─'.repeat(70) + '\n';
    if (!snapshot.network.checked) {
      output += '  NOT CHECKED: neither ss nor netstat on the server\n';
    } else {
      output += `  Established connections: ${snapshot.network.connections}\n`;
      output += `  Listening ports:\n`;
      snapshot.network.listening.forEach((p: any) => {
        output += `    ${p.port.padEnd(6)} ${p.service}\n`;
      });
    }
    output += '\n';
    
    if (!snapshot.recentErrors.checked || snapshot.recentErrors.items.length > 0) {
      output += '─'.repeat(70) + '\n';
      output += 'RECENT ERRORS\n';
      output += '─'.repeat(70) + '\n';
      if (snapshot.recentErrors.checked) {
        snapshot.recentErrors.items.forEach((err: any) => {
          output += `  [${err.source}] ${err.message}\n`;
        });
      } else {
        output += `  NOT CHECKED: ${snapshot.recentErrors.reason}\n`;
      }
      output += '\n';
    }
    
    output += '═'.repeat(70) + '\n';
    
    return output;
  }
}
