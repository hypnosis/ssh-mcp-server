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
export declare class MonitoringTool {
    getTool(): Tool;
    handleCall(request: CallToolRequest): Promise<{
        content: {
            type: string;
            text: string;
        }[];
    }>;
    /**
     * Get connection pool statistics
     */
    private getStats;
    /**
     * Reload SSH profiles
     */
    private reloadProfilesAction;
    /**
     * Test connection to profile
     */
    private testConnection;
    /**
     * List available profiles
     */
    private listProfiles;
}
//# sourceMappingURL=monitoring-tool.d.ts.map