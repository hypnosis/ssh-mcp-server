/**
 * SSH Snapshot Tool
 * Instant system state snapshot
 */
import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
/**
 * Snapshot Tool
 */
export declare class SnapshotTool {
    private executor;
    constructor();
    /**
     * Get tool description for MCP
     */
    getTool(): Tool;
    /**
     * Handle tool call
     */
    handleCall(request: CallToolRequest): Promise<{
        content: Array<{
            type: string;
            text: string;
        }>;
    }>;
    /**
     * Get timestamp
     */
    private getTimestamp;
    /**
     * Get hostname
     */
    private getHostname;
    /**
     * Get uptime
     */
    private getUptime;
    /**
     * Get service status
     */
    private getServices;
    /**
     * Get CPU information
     */
    private getCPU;
    /**
     * Get Memory information
     */
    private getMemory;
    /**
     * Get Disk information
     */
    private getDisk;
    /**
     * Get Docker information
     */
    private getDocker;
    /**
     * Get Network information
     */
    private getNetwork;
    /**
     * Get recent errors
     */
    private getRecentErrors;
    /**
     * Determine service by port
     */
    private getServiceByPort;
    /**
     * Format snapshot for output
     */
    private formatSnapshot;
}
//# sourceMappingURL=snapshot-tool.d.ts.map