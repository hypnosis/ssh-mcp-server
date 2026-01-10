/**
 * SSH Snapshot Tool
 * Мгновенный снимок состояния системы
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';

interface SystemSnapshot {
  timestamp: string;
  hostname: string;
  uptime: string;
  services: Array<{ name: string; status: string; uptime: string | null }>;
  resources: {
    cpu: { cores: number; usage: number; loadAvg: string };
    memory: { total: string; used: string; free: string; percent: number };
    disk: Array<{ mount: string; size: string; used: string; avail: string; percent: string }>;
  };
  docker?: {
    containers: Array<{ id: string; name: string; status: string; uptime: string }>;
    images: number;
  };
  network: {
    listening: Array<{ port: string; service: string }>;
    connections: number;
  };
  recentErrors: Array<{ source: string; message: string; time: string }>;
}

/**
 * Snapshot Tool
 */
export class SnapshotTool {
  private executor: SSHExecutor;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  /**
   * Получить описание tool для MCP
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
   * Обработать вызов tool
   */
  async handleCall(request: CallToolRequest): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const args = request.params.arguments as any;
      const sshConfig = resolveSSHConfig({ profile: args.profile });
      
      logger.info('Collecting system snapshot...');
      
      // Собираем данные параллельно
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
      
      // Форматируем красивый вывод
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
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  }
  
  /**
   * Получить timestamp
   */
  private async getTimestamp(config: any): Promise<string> {
    const result = await this.executor.execute(config, 'date -u +"%Y-%m-%dT%H:%M:%SZ"');
    return result.stdout.trim();
  }
  
  /**
   * Получить hostname
   */
  private async getHostname(config: any): Promise<string> {
    const result = await this.executor.execute(config, 'hostname');
    return result.stdout.trim();
  }
  
  /**
   * Получить uptime
   */
  private async getUptime(config: any): Promise<string> {
    const result = await this.executor.execute(config, 'uptime -p');
    return result.stdout.trim().replace('up ', '');
  }
  
  /**
   * Получить состояние сервисов
   */
  private async getServices(config: any): Promise<Array<{ name: string; status: string; uptime: string | null }>> {
    const services = ['nginx', 'apache2', 'docker', 'postgresql', 'mysql', 'redis', 'mongodb'];
    const results: Array<{ name: string; status: string; uptime: string | null }> = [];
    
    for (const service of services) {
      try {
        const result = await this.executor.execute(config, `systemctl is-active ${service} 2>/dev/null || echo inactive`);
        const status = result.stdout.trim();
        
        if (status === 'active') {
          // Получаем uptime
          const uptimeResult = await this.executor.execute(
            config,
            `systemctl show ${service} --property=ActiveEnterTimestamp --value 2>/dev/null || echo ""`
          );
          results.push({ name: service, status, uptime: uptimeResult.stdout.trim() || null });
        }
      } catch {
        // Service not found, skip
      }
    }
    
    return results;
  }
  
  /**
   * Получить CPU информацию
   */
  private async getCPU(config: any): Promise<{ cores: number; usage: number; loadAvg: string }> {
    const coresResult = await this.executor.execute(config, 'nproc');
    const loadResult = await this.executor.execute(config, 'cat /proc/loadavg');
    const usageResult = await this.executor.execute(
      config,
      'top -bn1 | grep "Cpu(s)" | awk \'{print $2}\' | cut -d"%" -f1'
    );
    
    const cores = parseInt(coresResult.stdout.trim());
    const usage = parseFloat(usageResult.stdout.trim()) || 0;
    const loadAvg = loadResult.stdout.trim().split(' ').slice(0, 3).join(' ');
    
    return { cores, usage, loadAvg };
  }
  
  /**
   * Получить Memory информацию
   */
  private async getMemory(config: any): Promise<{ total: string; used: string; free: string; percent: number }> {
    const result = await this.executor.execute(config, 'free -h | grep Mem');
    const parts = result.stdout.trim().split(/\s+/);
    
    return {
      total: parts[1] || 'unknown',
      used: parts[2] || 'unknown',
      free: parts[3] || 'unknown',
      percent: parts[2] && parts[1] ? Math.round((parseFloat(parts[2]) / parseFloat(parts[1])) * 100) : 0,
    };
  }
  
  /**
   * Получить Disk информацию
   */
  private async getDisk(config: any): Promise<Array<{ mount: string; size: string; used: string; avail: string; percent: string }>> {
    const result = await this.executor.execute(config, 'df -h | grep -E "^/dev/"');
    const lines = result.stdout.trim().split('\n');
    
    return lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        mount: parts[5] || '?',
        size: parts[1] || '?',
        used: parts[2] || '?',
        avail: parts[3] || '?',
        percent: parts[4] || '?',
      };
    });
  }
  
  /**
   * Получить Docker информацию
   */
  private async getDocker(config: any): Promise<{ containers: any[]; images: number } | undefined> {
    try {
      // Проверяем наличие Docker
      const checkResult = await this.executor.execute(config, 'which docker');
      if (checkResult.exitCode !== 0) {
        return undefined;
      }
      
      // Список контейнеров
      const containersResult = await this.executor.execute(
        config,
        'docker ps --format "{{.ID}}|{{.Names}}|{{.Status}}"'
      );
      
      const containers = containersResult.stdout.trim().split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [id, name, status] = line.split('|');
          return { id, name, status, uptime: status };
        });
      
      // Количество образов
      const imagesResult = await this.executor.execute(config, 'docker images -q | wc -l');
      const images = parseInt(imagesResult.stdout.trim()) || 0;
      
      return { containers, images };
    } catch {
      return undefined;
    }
  }
  
  /**
   * Получить Network информацию
   */
  private async getNetwork(config: any): Promise<{ listening: Array<{ port: string; service: string }>; connections: number }> {
    // Открытые порты
    const portsResult = await this.executor.execute(
      config,
      'ss -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | cut -d: -f2 | sort -u || netstat -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | cut -d: -f2 | sort -u'
    );
    
    const ports = portsResult.stdout.trim().split('\n')
      .filter(port => port.length > 0 && !isNaN(parseInt(port)))
      .map(port => ({ port, service: this.getServiceByPort(port) }));
    
    // Количество соединений
    const connectionsResult = await this.executor.execute(
      config,
      'ss -tn 2>/dev/null | grep ESTAB | wc -l || netstat -tn 2>/dev/null | grep ESTABLISHED | wc -l'
    );
    const connections = parseInt(connectionsResult.stdout.trim()) || 0;
    
    return { listening: ports, connections };
  }
  
  /**
   * Получить недавние ошибки
   */
  private async getRecentErrors(config: any): Promise<Array<{ source: string; message: string; time: string }>> {
    const errors: Array<{ source: string; message: string; time: string }> = [];
    
    // Ошибки из syslog
    try {
      const result = await this.executor.execute(
        config,
        'tail -n 100 /var/log/syslog 2>/dev/null | grep -iE "error|fatal|critical" | tail -n 3 || echo ""',
        { sudo: true }
      );
      
      if (result.stdout.trim()) {
        const lines = result.stdout.trim().split('\n');
        lines.forEach(line => {
          if (line.length > 0) {
            errors.push({
              source: 'syslog',
              message: line.substring(0, 100),
              time: 'recent',
            });
          }
        });
      }
    } catch {}
    
    return errors;
  }
  
  /**
   * Определить сервис по порту
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
   * Форматировать snapshot для вывода
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
    if (snapshot.services.length > 0) {
      snapshot.services.forEach((svc: any) => {
        output += `  ${svc.name.padEnd(15)} ${svc.status === 'active' ? '✓' : '✗'} ${svc.status}\n`;
      });
    } else {
      output += '  No active services detected\n';
    }
    output += '\n';
    
    output += '─'.repeat(70) + '\n';
    output += 'RESOURCES\n';
    output += '─'.repeat(70) + '\n';
    output += `  CPU:    ${snapshot.resources.cpu.cores} cores, ${snapshot.resources.cpu.usage.toFixed(1)}% used, load: ${snapshot.resources.cpu.loadAvg}\n`;
    output += `  Memory: ${snapshot.resources.memory.used} / ${snapshot.resources.memory.total} (${snapshot.resources.memory.percent}% used)\n`;
    output += `  Disk:\n`;
    snapshot.resources.disk.forEach((d: any) => {
      output += `    ${d.mount.padEnd(10)} ${d.used.padEnd(8)} / ${d.size.padEnd(8)} (${d.percent})\n`;
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
    output += `  Established connections: ${snapshot.network.connections}\n`;
    output += `  Listening ports:\n`;
    snapshot.network.listening.forEach((p: any) => {
      output += `    ${p.port.padEnd(6)} ${p.service}\n`;
    });
    output += '\n';
    
    if (snapshot.recentErrors.length > 0) {
      output += '─'.repeat(70) + '\n';
      output += 'RECENT ERRORS\n';
      output += '─'.repeat(70) + '\n';
      snapshot.recentErrors.forEach((err: any) => {
        output += `  [${err.source}] ${err.message}\n`;
      });
      output += '\n';
    }
    
    output += '═'.repeat(70) + '\n';
    
    return output;
  }
}
