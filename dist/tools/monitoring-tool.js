/**
 * Monitoring Tool - Monitor SSH connections and profiles
 *
 * Actions:
 * - stats: Get connection pool statistics
 * - reload: Reload SSH profiles
 * - test: Test connection to profile
 * - list: List available profiles
 */
import { ConnectionPool } from '../managers/connection-pool.js';
import { getAvailableProfiles, getDefaultProfile, reloadProfiles, resolveSSHConfig } from '../utils/profile-resolver.js';
import { logger } from '../utils/logger.js';
export class MonitoringTool {
    getTool() {
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
    async handleCall(request) {
        const args = request.params.arguments;
        const action = args.action;
        logger.debug(`[Monitoring Tool] Action: ${action}, profile: ${args.profile || 'default'}`);
        try {
            switch (action) {
                case 'stats':
                    return this.getStats();
                case 'reload':
                    return this.reloadProfilesAction();
                case 'test':
                    return this.testConnection(args.profile);
                case 'list':
                    return this.listProfiles();
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        }
        catch (error) {
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
     * Get connection pool statistics
     */
    async getStats() {
        const pool = ConnectionPool.getInstance();
        const stats = pool.getStats();
        let output = '📊 SSH Connection Pool Statistics\n\n';
        output += `🔢 Metrics:\n`;
        output += `  Total Connections: ${stats.totalConnections}\n`;
        output += `  Active Connections: ${stats.activeConnections}\n`;
        output += `  Total Commands: ${stats.totalCommands}\n`;
        output += `  Cache Hits: ${stats.cacheHits}\n`;
        output += `  Cache Misses: ${stats.cacheMisses}\n`;
        output += `  Reconnects: ${stats.reconnects}\n`;
        if (stats.cacheHits + stats.cacheMisses > 0) {
            const hitRate = (stats.cacheHits / (stats.cacheHits + stats.cacheMisses) * 100).toFixed(1);
            output += `  Cache Hit Rate: ${hitRate}%\n`;
        }
        output += `\n🔗 Active Connections:\n`;
        if (stats.connections.length === 0) {
            output += `  No active connections\n`;
        }
        else {
            for (const conn of stats.connections) {
                const idleTime = Math.floor(conn.idleTime / 1000);
                const status = conn.isReady ? '✅' : '❌';
                output += `  ${status} ${conn.profileName}\n`;
                output += `     Active Commands: ${conn.activeCommands}\n`;
                output += `     Idle Time: ${idleTime}s\n`;
            }
        }
        return {
            content: [{ type: 'text', text: output }]
        };
    }
    /**
     * Reload SSH profiles
     */
    async reloadProfilesAction() {
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
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Failed to reload profiles: ${error.message}` }],
                isError: true
            };
        }
    }
    /**
     * Test connection to profile
     */
    async testConnection(profileName) {
        try {
            const profile = profileName || getDefaultProfile();
            const sshConfig = resolveSSHConfig({ profile });
            const pool = ConnectionPool.getInstance();
            const startTime = Date.now();
            // Get client (will create connection if needed)
            const client = await pool.getClient(profile, sshConfig);
            const connectTime = Date.now() - startTime;
            // Test command
            const cmdStartTime = Date.now();
            await new Promise((resolve, reject) => {
                client.exec('echo "test"', (err, stream) => {
                    if (err)
                        return reject(err);
                    stream.on('close', () => resolve());
                    stream.on('error', reject);
                    stream.resume();
                });
            });
            const cmdTime = Date.now() - cmdStartTime;
            pool.releaseClient(profile);
            let output = `✅ Connection Test: ${profile}\n\n`;
            output += `Host: ${sshConfig.host}:${sshConfig.port || 22}\n`;
            output += `Username: ${sshConfig.username}\n`;
            output += `Connect Time: ${connectTime}ms\n`;
            output += `Command Time: ${cmdTime}ms\n`;
            output += `Total Time: ${connectTime + cmdTime}ms\n`;
            return {
                content: [{ type: 'text', text: output }]
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Connection test failed: ${error.message}` }],
                isError: true
            };
        }
    }
    /**
     * List available profiles
     */
    async listProfiles() {
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
//# sourceMappingURL=monitoring-tool.js.map