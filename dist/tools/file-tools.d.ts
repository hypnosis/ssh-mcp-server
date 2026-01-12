/**
 * SSH File Tools
 * Tools for working with files on remote server
 */
import { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
/**
 * File Tools
 */
export declare class FileTools {
    private executor;
    constructor();
    /**
     * Get tool descriptions for MCP
     */
    getTools(): Tool[];
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
     * Handle ssh_file_read
     */
    private handleFileRead;
    /**
     * Handle ssh_file_write
     */
    private handleFileWrite;
    /**
     * Write file to remote server
     */
    private writeFile;
    /**
     * Handle ssh_file_list
     */
    private handleFileList;
    /**
     * Expand tilde (~) for remote execution
     * Converts ~ to $HOME for shell expansion on remote server
     *
     * Examples:
     *   ~/file       → $HOME/file
     *   ~            → $HOME
     *   ~user/file   → ~user/file (left as-is, shell will expand)
     *   /abs/path    → /abs/path (no change)
     *
     * Note: We use $HOME instead of ~ because:
     * 1. Single quotes prevent ~ expansion: cat '~/file' won't work
     * 2. $HOME works in double quotes: cat "$HOME/file" works
     * 3. We can safely escape everything except $HOME in double quotes
     */
    private expandRemoteTilde;
    /**
     * Escape path for single-quoted context (safest)
     * Used for paths without tilde or variables
     *
     * Single quotes prevent ALL expansions (variables, commands, globs)
     * Only need to handle embedded single quotes: ' → '\''
     */
    private escapeForSingleQuotes;
    /**
     * Escape path for double-quoted context
     * Used when we need variable expansion (e.g., $HOME)
     *
     * Double quotes allow variable expansion but we must escape:
     * - Backslashes (\)
     * - Double quotes (")
     * - Dollar signs ($) - except $HOME which we want to expand
     * - Backticks (`)
     * - Exclamation marks (!) - for history expansion
     */
    private escapeForDoubleQuotes;
    /**
     * Build safe shell command with proper quoting
     *
     * Strategy:
     * - If path contains ~ → expand to $HOME → use double quotes
     * - Otherwise → use single quotes (safest)
     *
     * Double quotes are used for $HOME expansion but everything else is escaped
     * to prevent injection attacks (variables, commands, etc.)
     */
    private buildSafeCommand;
    /**
     * Legacy escape method (kept for backward compatibility)
     * @deprecated Use escapeForSingleQuotes() or escapeForDoubleQuotes() instead
     */
    private escapePath;
}
//# sourceMappingURL=file-tools.d.ts.map