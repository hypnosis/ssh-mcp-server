/**
 * SSH Snapshot Tool
 * Instant system state snapshot
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
  async handleCall(request: CallToolRequest): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const args = request.params.arguments as any;
      const profileName = args.profile || 'default';
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
        this.getTimestamp(sshConfig, profileName),
        this.getHostname(sshConfig, profileName),
        this.getUptime(sshConfig, profileName),
        this.getServices(sshConfig, profileName),
        this.getCPU(sshConfig, profileName),
        this.getMemory(sshConfig, profileName),
        this.getDisk(sshConfig, profileName),
        this.getDocker(sshConfig, profileName),
        this.getNetwork(sshConfig, profileName),
        this.getRecentErrors(sshConfig, profileName),
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
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  }
  
  /**
   * Get timestamp
   */
  private async getTimestamp(config: any, profileName: string): Promise<string> {
    const result = await this.executor.execute(config, 'date -u +"%Y-%m-%dT%H:%M:%SZ"', { profileName });
    return result.stdout.trim();
  }
  
  /**
   * Get hostname
   */
  private async getHostname(config: any, profileName: string): Promise<string> {
    const result = await this.executor.execute(config, 'hostname', { profileName });
    return result.stdout.trim();
  }
  
  /**
   * Get uptime
   */
  private async getUptime(config: any, profileName: string): Promise<string> {
    const result = await this.executor.execute(config, 'uptime -p', { profileName });
    return result.stdout.trim().replace('up ', '');
  }
  
  /**
   * Get service status
   */
  private async getServices(config: any, profileName: string): Promise<Array<{ name: string; status: string; uptime: string | null }>> {
    const services = ['nginx', 'apache2', 'docker', 'postgresql', 'mysql', 'redis', 'mongodb'];
    const results: Array<{ name: string; status: string; uptime: string | null }> = [];
    
    for (const service of services) {
      try {
        const result = await this.executor.execute(config, `systemctl is-active ${service} 2>/dev/null || echo inactive`, { profileName });
        const status = result.stdout.trim();
        
        if (status === 'active') {
          // Get uptime
          const uptimeResult = await this.executor.execute(
            config,
            `systemctl show ${service} --property=ActiveEnterTimestamp --value 2>/dev/null || echo ""`,
            { profileName }
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
   * Get CPU information
   */
  private async getCPU(config: any, profileName: string): Promise<{ cores: number; usage: number; loadAvg: string }> {
    const coresResult = await this.executor.execute(config, 'nproc', { profileName });
    const loadResult = await this.executor.execute(config, 'cat /proc/loadavg', { profileName });
    const usageResult = await this.executor.execute(
      config,
      'top -bn1 | grep "Cpu(s)" | awk \'{print $2}\' | cut -d"%" -f1',
      { profileName }
    );
    
    const cores = parseInt(coresResult.stdout.trim());
    const usage = parseFloat(usageResult.stdout.trim()) || 0;
    const loadAvg = loadResult.stdout.trim().split(' ').slice(0, 3).join(' ');
    
    return { cores, usage, loadAvg };
  }
  
  /**
   * Get Memory information
   */
  private async getMemory(config: any, profileName: string): Promise<{ total: string; used: string; free: string; percent: number }> {
    const result = await this.executor.execute(config, 'free -h | grep Mem', { profileName });
    const parts = result.stdout.trim().split(/\s+/);
    
    return {
      total: parts[1] || 'unknown',
      used: parts[2] || 'unknown',
      free: parts[3] || 'unknown',
      percent: parts[2] && parts[1] ? Math.round((parseFloat(parts[2]) / parseFloat(parts[1])) * 100) : 0,
    };
  }
  
  /**
   * Get Disk information
   */
  private async getDisk(config: any, profileName: string): Promise<Array<{ mount: string; size: string; used: string; avail: string; percent: string }>> {
    const result = await this.executor.execute(config, 'df -h | grep -E "^/dev/"', { profileName });
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
   * Get Docker information
   */
  private async getDocker(config: any, profileName: string): Promise<{ containers: any[]; images: number } | undefined> {
    try {
      // Check for Docker presence
      const checkResult = await this.executor.execute(config, 'which docker', { profileName });
      if (checkResult.exitCode !== 0) {
        return undefined;
      }
      
      // Container list
      const containersResult = await this.executor.execute(
        config,
        'docker ps --format "{{.ID}}|{{.Names}}|{{.Status}}"',
        { profileName }
      );
      
      const containers = containersResult.stdout.trim().split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [id, name, status] = line.split('|');
          return { id, name, status, uptime: status };
        });
      
      // Image count
      const imagesResult = await this.executor.execute(config, 'docker images -q | wc -l', { profileName });
      const images = parseInt(imagesResult.stdout.trim()) || 0;
      
      return { containers, images };
    } catch {
      return undefined;
    }
  }
  
  /**
   * Get Network information
   */
  private async getNetwork(config: any, profileName: string): Promise<{ listening: Array<{ port: string; service: string }>; connections: number }> {
    // Open ports
    const portsResult = await this.executor.execute(
      config,
      'ss -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | cut -d: -f2 | sort -u || netstat -tlnp 2>/dev/null | grep LISTEN | awk \'{print $4}\' | cut -d: -f2 | sort -u',
      { profileName }
    );
    
    const ports = portsResult.stdout.trim().split('\n')
      .filter(port => port.length > 0 && !isNaN(parseInt(port)))
      .map(port => ({ port, service: this.getServiceByPort(port) }));
    
    // Connection count
    const connectionsResult = await this.executor.execute(
      config,
      'ss -tn 2>/dev/null | grep ESTAB | wc -l || netstat -tn 2>/dev/null | grep ESTABLISHED | wc -l',
      { profileName }
    );
    const connections = parseInt(connectionsResult.stdout.trim()) || 0;
    
    return { listening: ports, connections };
  }
  
  /**
   * Get recent errors
   */
  private async getRecentErrors(config: any, profileName: string): Promise<Array<{ source: string; message: string; time: string }>> {
    const errors: Array<{ source: string; message: string; time: string }> = [];
    
    // Errors from syslog
    try {
      const result = await this.executor.execute(
        config,
        'tail -n 100 /var/log/syslog 2>/dev/null | grep -iE "error|fatal|critical" | tail -n 3 || echo ""',
        { sudo: true, profileName }
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
