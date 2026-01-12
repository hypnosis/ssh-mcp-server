/**
 * SSH Exec Tool
 * Universal tool for executing SSH commands
 */
import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
/**
 * SSH Exec Tool
 */
export declare class ExecTool {
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
}
//# sourceMappingURL=exec-tool.d.ts.map