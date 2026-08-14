/**
 * Monitoring Tool - Monitor SSH connections and profiles
 * 
 * Actions:
 * - stats: Get transport state for a profile
 * - reload: Reload SSH profiles
 * - test: Test connection to profile
 * - list: List available profiles
 * - close: Close the shared connection of a profile
 */

import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { idleWindowSec, listControlSockets } from '../runner/control-sockets.js';
import { getRunner } from '../runner/get-runner.js';
import {
  getAvailableProfiles,
  getBrokenProfiles,
  getDefaultProfile,
  reloadProfiles,
  resolveSSHConfig,
} from '../utils/profile-resolver.js';
import { describeBrokenProfile } from '../utils/profiles-file.js';
import { logger } from '../utils/logger.js';
import type { ToolResult } from '../utils/tool-result.js';

export class MonitoringTool {
  getTool(): Tool {
    return {
      name: 'ssh_monitor',
      description: 'Monitor SSH connections and server status. Get stats, reload profiles, test connections, list profiles, close a shared connection.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['stats', 'reload', 'test', 'list', 'close'],
            description: 'Action to perform: stats (transport state), reload (reload profiles), test (test connection), list (list profiles), close (close the shared connection now instead of waiting for it to idle out)'
          },
          profile: {
            type: 'string',
            description: 'Profile name (for test and close actions)'
          }
        },
        required: ['action']
      }
    };
  }
  
  async handleCall(request: CallToolRequest): Promise<ToolResult> {
    const args = request.params.arguments as any;
    const action = args.action;
    
    logger.debug(`[Monitoring Tool] Action: ${action}, profile: ${args.profile || 'default'}`);
    
    try {
      // Ожидание здесь обязательно: без него отказ уходит мимо перехвата ниже
      switch (action) {
        case 'stats':
          return await this.getStats(args.profile);

        case 'reload':
          return await this.reloadProfilesAction();

        case 'test':
          return await this.testConnection(args.profile);

        case 'list':
          return await this.listProfiles();

        case 'close':
          return await this.closeConnection(args.profile);

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
   * Метрик пула здесь нет: соединение живёт в самом ssh и общее для всех
   * процессов машины, поэтому считать его нашими счётчиками нечем.
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
   * Закрыть общее соединение профиля, не дожидаясь срока простоя.
   *
   * Закрывается назначение профиля, а не всё подряд: имя сокета — хэш, по нему
   * сервер не восстановить, а удаление файла соединение не разрывает.
   */
  private async closeConnection(profileName?: string) {
    const profile = profileName || getDefaultProfile();
    const sshConfig = resolveSSHConfig({ profile });
    const destination = `${sshConfig.host}:${sshConfig.port || 22}`;
    const runner = await getRunner(sshConfig);
    const outcome = await runner.closeMaster();

    let output = `🔌 Shared Connection: ${profile}\n\n`;
    switch (outcome) {
      case 'closed':
        output += `✅ Closed the connection to ${destination}\n`;
        break;
      case 'nothing-to-close':
        output += `ℹ️ Nothing to close: ${destination} has no open connection, it already idled out\n`;
        break;
      case 'multiplexing-off':
        output += `ℹ️ Nothing to close: multiplexing is off, connections do not outlive a command\n`;
        break;
    }

    output += `\n${await this.describeLeftovers()}`;

    return {
      content: [{ type: 'text', text: output }]
    };
  }

  /**
   * Что осталось на машине после закрытия: соединения других профилей переживают
   * и это действие, и выход сервера.
   */
  private async describeLeftovers(): Promise<string> {
    try {
      const sockets = await listControlSockets();
      const alive = sockets.filter((socket) => socket.state === 'alive');

      if (alive.length === 0) {
        return 'Left on this machine: no live connections\n';
      }

      return `Left on this machine: ${alive.length} live connection(s), ` +
        `each closing after ${idleWindowSec()}s of idle time\n`;
    } catch (error: any) {
      return `Left on this machine: unknown, the control directory is unreadable (${error.message})\n`;
    }
  }

  /**
   * List available profiles
   */
  private async listProfiles() {
    const profiles = getAvailableProfiles();
    const defaultProfile = getDefaultProfile();
    const broken = getBrokenProfiles();

    let output = '📋 Available SSH Profiles\n\n';

    for (const profile of profiles) {
      const isDefault = profile === defaultProfile ? ' ⭐ (default)' : '';
      output += `• ${profile}${isDefault}\n`;
    }

    // Сломанные записи — отдельным списком: их нельзя перепутать с рабочими
    // профилями, а причина отказа видна сразу, без похода в файл
    if (broken.length > 0) {
      output += `\n⚠️ Broken (fix in SSH_PROFILES_FILE):\n`;
      for (const entry of broken) {
        const isDefault = entry.name === defaultProfile ? ' (default)' : '';
        output += `• ${entry.name}${isDefault} — ${describeBrokenProfile(entry)}\n`;
      }
    }

    output += `\nTotal: ${profiles.length} profiles`;
    output += broken.length > 0 ? `, ${broken.length} broken\n` : '\n';

    return {
      content: [{ type: 'text', text: output }]
    };
  }
}
