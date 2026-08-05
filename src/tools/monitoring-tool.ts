/**
 * Monitoring Tool - Monitor SSH connections and profiles
 * 
 * Actions:
 * - stats: Get connection pool statistics
 * - reload: Reload SSH profiles
 * - test: Test connection to profile
 * - list: List available profiles
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { getRunner } from '../runner/get-runner.js';
import { getAvailableProfiles, getDefaultProfile, reloadProfiles, resolveSSHConfig } from '../utils/profile-resolver.js';
import { logger } from '../utils/logger.js';

export class MonitoringTool {
  getTool(): Tool {
    return {
      name: 'ssh_monitor',
      description: 'Monitor SSH connections and server status. Get stats, reload profiles, test connections, list profiles.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['stats', 'reload', 'test', 'list'],
            description: 'Action to perform: stats (get pool stats), reload (reload profiles), test (test connection), list (list profiles)'
          },
          profile: {
            type: 'string',
            description: 'Profile name (for test action)'
          }
        },
        required: ['action']
      }
    };
  }
  
  async handleCall(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const action = args.action;
    
    logger.debug(`[Monitoring Tool] Action: ${action}, profile: ${args.profile || 'default'}`);
    
    try {
      switch (action) {
        case 'stats':
          return this.getStats(args.profile);
        
        case 'reload':
          return this.reloadProfilesAction();
        
        case 'test':
          return this.testConnection(args.profile);
        
        case 'list':
          return this.listProfiles();
        
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error: any) {
      logger.error(`[Monitoring Tool] Error in action "${action}": ${error.message}`);
      
      return {
        content: [{ 
          type: 'text', 
          text: `❌ Error: ${error.message}` 
        }],
        isError: true
      };
    }
  }
  
  /**
   * Состояние транспорта профиля.
   *
   * Метрики пула соединений отсюда ушли: пул есть только у бэкенда ssh2, а на
   * openssh соединение общее для всех процессов и живёт в самом ssh.
   */
  private async getStats(profileName?: string) {
    const profile = profileName || getDefaultProfile();
    const sshConfig = resolveSSHConfig({ profile });
    const runner = await getRunner(sshConfig);
    const stats = await runner.stats();

    let output = `📊 SSH Transport: ${profile}\n\n`;
    output += `  Host: ${sshConfig.host}:${sshConfig.port || 22}\n`;
    output += `  Backend: ${stats.backend}\n`;
    if (stats.sshVersion) {
      output += `  SSH Version: ${stats.sshVersion}\n`;
    }

    output += `\n🔗 Shared Connection:\n`;
    if (stats.multiplexing) {
      output += `  Multiplexing: on\n`;
      output += `  Master: ${stats.masterActive ? '✅ active' : '❌ not running'}\n`;
      if (stats.masterPid) output += `  Master PID: ${stats.masterPid}\n`;
      if (stats.controlPath) output += `  Control Path: ${stats.controlPath}\n`;
    } else {
      output += `  Multiplexing: off\n`;
      if (stats.multiplexingDisabledReason) {
        output += `  Reason: ${stats.multiplexingDisabledReason}\n`;
      }
      output += `  Connection: ${stats.masterActive ? '✅ open' : '❌ closed'}\n`;
    }

    output += `\n🔢 This Session:\n`;
    output += `  Commands: ${stats.commandsThisSession}\n`;
    output += `  Transfers: ${stats.transfersThisSession}\n`;
    if (stats.lastError) {
      output += `  Last Error: ${stats.lastError}\n`;
    }

    return {
      content: [{ type: 'text', text: output }]
    };
  }
  
  /**
   * Reload SSH profiles
   */
  private async reloadProfilesAction() {
    try {
      const beforeCount = getAvailableProfiles().length;
      
      reloadProfiles();
      
      const afterCount = getAvailableProfiles().length;
      const profiles = getAvailableProfiles();
      const defaultProfile = getDefaultProfile();
      
      let output = '🔄 SSH Profiles Reloaded\n\n';
      output += `✅ Loaded ${afterCount} profiles (was ${beforeCount})\n\n`;
      output += `📋 Available Profiles:\n`;
      
      for (const profile of profiles) {
        const isDefault = profile === defaultProfile ? ' (default)' : '';
        output += `  • ${profile}${isDefault}\n`;
      }
      
      return {
        content: [{ type: 'text', text: output }]
      };
      
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Failed to reload profiles: ${error.message}` }],
        isError: true
      };
    }
  }
  
  /**
   * Test connection to profile
   */
  private async testConnection(profileName?: string) {
    const profile = profileName || getDefaultProfile();

    try {
      const sshConfig = resolveSSHConfig({ profile });
      const runner = await getRunner(sshConfig);
      const result = await runner.ping();

      if (!result.ok) {
        return {
          content: [{
            type: 'text',
            text: `❌ Connection test failed: ${profile} did not answer in ${result.latencyMs}ms`
          }],
          isError: true
        };
      }

      let output = `✅ Connection Test: ${profile}\n\n`;
      output += `Host: ${sshConfig.host}:${sshConfig.port || 22}\n`;
      output += `Username: ${sshConfig.username}\n`;
      output += `Latency: ${result.latencyMs}ms\n`;
      // Разница между «доехало по готовому каналу» и «пришлось входить заново»
      // объясняет, почему один и тот же вызов иногда занимает секунды
      output += result.masterWasActive
        ? `Reused an existing connection\n`
        : `Opened a new connection\n`;

      return {
        content: [{ type: 'text', text: output }]
      };

    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Connection test failed: ${error.message}` }],
        isError: true
      };
    }
  }
  
  /**
   * List available profiles
   */
  private async listProfiles() {
    const profiles = getAvailableProfiles();
    const defaultProfile = getDefaultProfile();
    
    let output = '📋 Available SSH Profiles\n\n';
    
    for (const profile of profiles) {
      const isDefault = profile === defaultProfile ? ' ⭐ (default)' : '';
      output += `• ${profile}${isDefault}\n`;
    }
    
    output += `\nTotal: ${profiles.length} profiles\n`;
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
}
