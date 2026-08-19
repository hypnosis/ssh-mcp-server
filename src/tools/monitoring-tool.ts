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
import { MANAGES_CONNECTION } from './annotations.js';
import { idleWindowSec, listControlSockets } from '../runner/control-sockets.js';
import { getRunner } from '../runner/get-runner.js';
import {
  getAvailableProfiles,
  getBrokenProfiles,
  reloadProfiles,
  resolveSSHConfig,
} from '../utils/profile-resolver.js';
import { describeBrokenProfile } from '../utils/profiles-file.js';
import { logger } from '../utils/logger.js';
import type { PingResult, PingState } from '../runner/types.js';
import { actionSummary, MONITOR_OUTPUT_SCHEMA, pingSummary } from './monitor-output.js';
import type { ToolResult } from '../utils/tool-result.js';

/** ssh_monitor arguments, matching its inputSchema */
interface MonitorArgs {
  action?: string;
  profile?: string;
}

/**
 * The profile an action works on.
 *
 * Nothing is chosen on the caller's behalf: profiles are separate machines, and a guess
 * would point the answer at a server nobody asked about.
 */
function requireProfile(profileName?: string): string {
  if (profileName) {
    return profileName;
  }
  // Listing the names is the whole point of the refusal: the caller has to pick one,
  // and a file with no usable profile never loads in the first place.
  const available = getAvailableProfiles();
  throw new Error(`This action needs a profile. Name one explicitly: ${available.join(', ')}`);
}

/**
 * What to do next, per state. Read before the details, so the state alone is enough to act on.
 */
const ADVICE: Record<PingState, string> = {
  ready: '',
  limited:
    'Commands run, but the shell is not POSIX — the probe command "true" is unknown there. ' +
    'The file tools, ssh_snapshot, ssh_audit_baseline, ssh_tls_check, ssh_disk_breakdown ' +
    'and ssh_service_status have nothing to work with on such a shell; plain ssh_exec with ' +
    'the vendor\'s own commands does.',
  'no-route':
    'The server was never reached. Check the network, the host and the port — credentials are not the problem here.',
  rejected:
    'The server was reached and refused the login. Check the username, the key or password and known hosts — the network is fine.',
};

/**
 * The first line of a connection report: the state, named, before any detail.
 *
 * A reader in a hurry must be able to act on this line alone — the old wording buried the
 * outcome and once reported a working connection as "did not answer".
 */
function headlineFor(profile: string, result: PingResult): string {
  switch (result.state) {
    case 'ready':
      return `✅ ready — ${profile} answered in ${result.latencyMs}ms`;
    case 'limited':
      return `⚠️ limited — ${profile} answered in ${result.latencyMs}ms, probe exit code ${result.exitCode}`;
    case 'no-route':
      return `❌ no-route — ${profile} was not reached in ${result.latencyMs}ms`;
    case 'rejected':
      return `❌ rejected — ${profile} refused the login in ${result.latencyMs}ms`;
  }
}

export class MonitoringTool {
  getTool(): Tool {
    return {
      name: 'ssh_monitor',
      annotations: { title: 'Manage connections', ...MANAGES_CONNECTION },
      description:
        'The connection, not the machine. action: list (profile names) | test (ready|limited|no-route|rejected) | stats | close | reload.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['stats', 'reload', 'test', 'list', 'close'],
            description: 'Which of the five to do.'
          },
          profile: {
            type: 'string',
            description:
              'Which machine. Required for stats, test and close; list and reload take none.'
          }
        },
        required: ['action']
      },
      outputSchema: MONITOR_OUTPUT_SCHEMA,
    };
  }
  
  async handleCall(request: CallToolRequest): Promise<ToolResult> {
    const args = (request.params.arguments ?? {}) as MonitorArgs;
    const action = args.action;
    
    logger.debug(`[Monitoring Tool] Action: ${action}, profile: ${args.profile || 'none given'}`);
    
    try {
      // Awaiting here is mandatory: without it a rejection would slip past the catch below
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
   * A profile's transport state.
   *
   * There are no pool metrics here: the connection lives inside ssh itself
   * and is shared by every process on the machine, so there is nothing for
   * our own counters to measure it with.
   */
  private async getStats(profileName?: string) {
    const profile = requireProfile(profileName);
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
      content: [{ type: 'text', text: output }],
      structuredContent: actionSummary('stats', profile),
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

      let output = '🔄 SSH Profiles Reloaded\n\n';
      output += `✅ Loaded ${afterCount} profiles (was ${beforeCount})\n\n`;
      output += `📋 Available Profiles:\n`;

      for (const profile of profiles) {
        output += `  • ${profile}\n`;
      }
      
      return {
        content: [{ type: 'text', text: output }],
        structuredContent: actionSummary('reload', null),
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
    const profile = requireProfile(profileName);

    try {
      const sshConfig = resolveSSHConfig({ profile });
      const runner = await getRunner(sshConfig);
      const result = await runner.ping();

      let output = `${headlineFor(profile, result)}\n\n`;
      output += `Host: ${sshConfig.host}:${sshConfig.port || 22}\n`;
      output += `Username: ${sshConfig.username}\n`;
      output += `Latency: ${result.latencyMs}ms\n`;
      // The difference between "travelled over an already-open channel" and
      // "had to log in again" explains why the same call sometimes takes seconds
      output += result.masterWasActive
        ? `Reused an existing connection\n`
        : `Opened a new connection\n`;

      const advice = ADVICE[result.state];
      if (advice) {
        output += `\n${advice}\n`;
      }
      if (result.detail) {
        output += `\n${result.detail}\n`;
      }

      return {
        content: [{ type: 'text', text: output }],
        // Only a state the caller has to act on is an error. `limited` is a usable
        // connection, and calling it a failure sends the reader fixing nothing.
        isError: result.state === 'no-route' || result.state === 'rejected',
        // The unreachable states carry the summary too: a server that refused
        // the login is a measurement, and the caller acts on it
        structuredContent: pingSummary(profile, result),
      };

    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Connection test failed: ${error.message}` }],
        isError: true
      };
    }
  }
  
  /**
   * Close a profile's shared connection without waiting for it to idle out.
   *
   * What closes is the profile's destination, not everything at once: the
   * socket's name is a hash, the server cannot be recovered from it, and
   * deleting the file does not tear down the connection.
   */
  private async closeConnection(profileName?: string) {
    const profile = requireProfile(profileName);
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
      content: [{ type: 'text', text: output }],
      structuredContent: actionSummary('close', profile),
    };
  }

  /**
   * What is left on the machine after closing: other profiles' connections
   * outlive both this action and the server process exiting.
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
    const broken = getBrokenProfiles();

    let output = '📋 Available SSH Profiles\n\n';

    for (const profile of profiles) {
      output += `• ${profile}\n`;
    }

    // Broken entries get their own list: they cannot be mistaken for working
    // profiles, and the reason for the failure is visible right away, without opening the file
    if (broken.length > 0) {
      output += `\n⚠️ Broken (fix in SSH_PROFILES_FILE):\n`;
      for (const entry of broken) {
        output += `• ${entry.name} — ${describeBrokenProfile(entry)}\n`;
      }
    }

    output += `\nTotal: ${profiles.length} profiles`;
    output += broken.length > 0 ? `, ${broken.length} broken\n` : '\n';

    return {
      content: [{ type: 'text', text: output }],
      structuredContent: actionSummary('list', null),
    };
  }
}
