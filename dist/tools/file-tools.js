/**
 * SSH File Tools
 * Tools for working with files on remote server
 */
import { logger } from '../utils/logger.js';
import { resolveSSHConfig } from '../utils/profile-resolver.js';
import { SSHExecutor } from '../managers/ssh-executor.js';
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';
import { createPathValidator } from '../utils/path-validator.js';
/**
 * File Tools
 */
export class FileTools {
    executor;
    constructor() {
        this.executor = new SSHExecutor();
    }
    /**
     * Get tool descriptions for MCP
     */
    getTools() {
        return [
            // ssh_file_read
            {
                name: 'ssh_file_read',
                description: 'Read file(s) from remote server. Supports single file or batch reading.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        profile: {
                            type: 'string',
                            description: 'SSH profile name',
                        },
                        path: {
                            oneOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } },
                            ],
                            description: 'File path or array of file paths to read',
                        },
                        encoding: {
                            type: 'string',
                            enum: ['utf8', 'base64'],
                            description: 'File encoding. Default: utf8',
                            default: 'utf8',
                        },
                        sudo: {
                            type: 'boolean',
                            description: 'Read files with sudo. Default: false',
                            default: false,
                        },
                    },
                    required: ['path'],
                },
            },
            // ssh_file_write
            {
                name: 'ssh_file_write',
                description: 'Write file(s) to remote server. Supports single file or batch writing.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        profile: {
                            type: 'string',
                            description: 'SSH profile name',
                        },
                        files: {
                            oneOf: [
                                {
                                    type: 'object',
                                    properties: {
                                        path: { type: 'string' },
                                        content: { type: 'string' },
                                        mode: { type: 'string', description: 'File permissions (e.g., "644", "755")' },
                                        sudo: { type: 'boolean', description: 'Write with sudo' },
                                    },
                                    required: ['path', 'content'],
                                },
                                {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            path: { type: 'string' },
                                            content: { type: 'string' },
                                            mode: { type: 'string' },
                                            sudo: { type: 'boolean' },
                                        },
                                        required: ['path', 'content'],
                                    },
                                },
                            ],
                            description: 'Single file object or array of file objects to write',
                        },
                    },
                    required: ['files'],
                },
            },
            // ssh_file_list
            {
                name: 'ssh_file_list',
                description: 'List files in directory on remote server',
                inputSchema: {
                    type: 'object',
                    properties: {
                        profile: {
                            type: 'string',
                            description: 'SSH profile name',
                        },
                        path: {
                            type: 'string',
                            description: 'Directory path to list',
                        },
                        pattern: {
                            type: 'string',
                            description: 'File pattern (e.g., "*.log", "*.conf")',
                        },
                        recursive: {
                            type: 'boolean',
                            description: 'List files recursively. Default: false',
                            default: false,
                        },
                    },
                    required: ['path'],
                },
            },
        ];
    }
    /**
     * Handle tool call
     */
    async handleCall(request) {
        const toolName = request.params.name;
        try {
            switch (toolName) {
                case 'ssh_file_read':
                    return await this.handleFileRead(request);
                case 'ssh_file_write':
                    return await this.handleFileWrite(request);
                case 'ssh_file_list':
                    return await this.handleFileList(request);
                default:
                    throw new Error(`Unknown tool: ${toolName}`);
            }
        }
        catch (error) {
            logger.error(`${toolName} failed:`, error);
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
            };
        }
    }
    /**
     * Handle ssh_file_read
     */
    async handleFileRead(request) {
        const args = request.params.arguments;
        // Validate array parameter format
        const validation = validateArrayParameter(args.path, 'path');
        if (!validation.isValid) {
            return createValidationErrorResponse(validation.errorMessage);
        }
        const profileName = args.profile || 'default';
        const sshConfig = resolveSSHConfig({ profile: args.profile });
        const paths = Array.isArray(args.path) ? args.path : [args.path];
        const encoding = args.encoding || 'utf8';
        const sudo = args.sudo || false;
        // Validate paths against security rules (if configured)
        const pathValidator = createPathValidator(sshConfig);
        if (pathValidator) {
            for (const path of paths) {
                const pathValidation = pathValidator.validate(path);
                if (!pathValidation.valid) {
                    throw new Error(`Path validation failed: ${pathValidation.error}`);
                }
            }
        }
        // Single file - simple result
        if (paths.length === 1) {
            const command = this.buildSafeCommand(paths[0], 'cat', encoding);
            const result = await this.executor.execute(sshConfig, command, { sudo, profileName });
            if (result.exitCode !== 0) {
                throw new Error(`Failed to read file: ${result.stderr || result.stdout}`);
            }
            return {
                content: [{ type: 'text', text: result.stdout }],
            };
        }
        // Множественные файлы - структурированный результат
        const results = [];
        for (const path of paths) {
            try {
                const command = this.buildSafeCommand(path, 'cat', encoding);
                const result = await this.executor.execute(sshConfig, command, { sudo, profileName });
                if (result.exitCode === 0) {
                    results.push({
                        path,
                        content: result.stdout,
                        size: Buffer.byteLength(result.stdout, 'utf8'),
                        success: true,
                    });
                }
                else {
                    results.push({
                        path,
                        content: '',
                        size: 0,
                        success: false,
                        error: result.stderr || result.stdout,
                    });
                }
            }
            catch (error) {
                results.push({
                    path,
                    content: '',
                    size: 0,
                    success: false,
                    error: error.message,
                });
            }
        }
        // Format output
        let output = `Read ${results.length} files:\n\n`;
        for (const result of results) {
            if (result.success) {
                output += `✓ ${result.path} (${result.size} bytes)\n`;
                output += '─'.repeat(60) + '\n';
                output += result.content + '\n\n';
            }
            else {
                output += `✗ ${result.path}\n`;
                output += `  Error: ${result.error}\n\n`;
            }
        }
        return {
            content: [{ type: 'text', text: output }],
        };
    }
    /**
     * Handle ssh_file_write
     */
    async handleFileWrite(request) {
        const args = request.params.arguments;
        const profileName = args.profile || 'default';
        const sshConfig = resolveSSHConfig({ profile: args.profile });
        const files = Array.isArray(args.files) ? args.files : [args.files];
        // Validate paths against security rules (if configured)
        const pathValidator = createPathValidator(sshConfig);
        if (pathValidator) {
            for (const file of files) {
                const pathValidation = pathValidator.validate(file.path);
                if (!pathValidation.valid) {
                    throw new Error(`Path validation failed: ${pathValidation.error}`);
                }
            }
        }
        // Single file - simple result
        if (files.length === 1) {
            const file = files[0];
            await this.writeFile(sshConfig, file.path, file.content, file.mode, file.sudo || false, profileName);
            return {
                content: [{ type: 'text', text: `File written successfully: ${file.path}` }],
            };
        }
        // Множественные файлы - структурированный результат
        const results = [];
        for (const file of files) {
            try {
                await this.writeFile(sshConfig, file.path, file.content, file.mode, file.sudo || false, profileName);
                results.push({
                    path: file.path,
                    success: true,
                    bytesWritten: Buffer.byteLength(file.content, 'utf8'),
                });
            }
            catch (error) {
                results.push({
                    path: file.path,
                    success: false,
                    bytesWritten: 0,
                    error: error.message,
                });
            }
        }
        // Format output
        let output = `Write ${results.length} files:\n\n`;
        for (const result of results) {
            if (result.success) {
                output += `✓ ${result.path} (${result.bytesWritten} bytes)\n`;
            }
            else {
                output += `✗ ${result.path}\n`;
                output += `  Error: ${result.error}\n`;
            }
        }
        return {
            content: [{ type: 'text', text: output }],
        };
    }
    /**
     * Write file to remote server
     */
    async writeFile(sshConfig, path, content, mode, sudo = false, profileName) {
        // Expand tilde in path
        const expanded = this.expandRemoteTilde(path);
        // Escape content for heredoc
        const escapedContent = content.replace(/'/g, "'\"'\"'");
        // Build safe path for write
        let safePath;
        if (expanded.startsWith('$HOME')) {
            const homePrefix = '$HOME';
            const restPath = expanded.substring(5);
            const escapedRest = this.escapeForDoubleQuotes(restPath);
            safePath = `"${homePrefix}${escapedRest}"`;
        }
        else {
            safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
        }
        // Write command via heredoc
        let command = `cat > ${safePath} << 'SSHEOF'\n${escapedContent}\nSSHEOF`;
        // Add chmod if permissions specified
        if (mode) {
            command += ` && chmod ${mode} ${safePath}`;
        }
        const result = await this.executor.execute(sshConfig, command, { sudo, profileName });
        if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr || result.stdout}`);
        }
    }
    /**
     * Handle ssh_file_list
     */
    async handleFileList(request) {
        const args = request.params.arguments;
        const profileName = args.profile || 'default';
        const sshConfig = resolveSSHConfig({ profile: args.profile });
        // Validate path against security rules (if configured)
        const pathValidator = createPathValidator(sshConfig);
        if (pathValidator) {
            const pathValidation = pathValidator.validate(args.path);
            if (!pathValidation.valid) {
                throw new Error(`Path validation failed: ${pathValidation.error}`);
            }
        }
        const expanded = this.expandRemoteTilde(args.path);
        // Build safe path
        let safePath;
        if (expanded.startsWith('$HOME')) {
            const homePrefix = '$HOME';
            const restPath = expanded.substring(5);
            const escapedRest = this.escapeForDoubleQuotes(restPath);
            safePath = `"${homePrefix}${escapedRest}"`;
        }
        else {
            safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
        }
        let command = 'ls -lah';
        if (args.recursive) {
            command = 'ls -lRah';
        }
        if (args.pattern) {
            command += ` ${safePath}/${args.pattern}`;
        }
        else {
            command += ` ${safePath}`;
        }
        const result = await this.executor.execute(sshConfig, command, { profileName });
        if (result.exitCode !== 0) {
            throw new Error(`Failed to list files: ${result.stderr || result.stdout}`);
        }
        return {
            content: [{ type: 'text', text: result.stdout }],
        };
    }
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
    expandRemoteTilde(path) {
        if (!path)
            return path;
        // ~/path → $HOME/path
        if (path.startsWith('~/')) {
            return '$HOME/' + path.substring(2);
        }
        // ~ → $HOME
        if (path === '~') {
            return '$HOME';
        }
        // ~user/path → leave as-is (shell will expand ~user)
        // /absolute/path → leave as-is
        // ./relative/path → leave as-is
        return path;
    }
    /**
     * Escape path for single-quoted context (safest)
     * Used for paths without tilde or variables
     *
     * Single quotes prevent ALL expansions (variables, commands, globs)
     * Only need to handle embedded single quotes: ' → '\''
     */
    escapeForSingleQuotes(path) {
        // Replace ' with '\'' (end quote, escaped quote, start quote)
        return path.replace(/'/g, "'\\''");
    }
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
    escapeForDoubleQuotes(str) {
        return str
            .replace(/\\/g, '\\\\') // \ → \\
            .replace(/"/g, '\\"') // " → \"
            .replace(/\$/g, '\\$') // $ → \$ (prevent variable expansion)
            .replace(/`/g, '\\`') // ` → \` (prevent command substitution)
            .replace(/!/g, '\\!'); // ! → \! (prevent history expansion)
    }
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
    buildSafeCommand(path, command, encoding) {
        const expanded = this.expandRemoteTilde(path);
        // Path with $HOME → use double quotes for expansion
        if (expanded.startsWith('$HOME')) {
            // Split: $HOME (don't escape) + rest (escape everything)
            const homePrefix = '$HOME';
            const restPath = expanded.substring(5); // After $HOME
            // Escape only the part after $HOME
            const escapedRest = this.escapeForDoubleQuotes(restPath);
            const safePath = `"${homePrefix}${escapedRest}"`;
            // Build command based on encoding
            if (encoding === 'base64') {
                return `base64 ${safePath}`;
            }
            else if (command === 'cat') {
                return `cat ${safePath}`;
            }
            else if (command === 'tail') {
                return `tail ${safePath}`;
            }
            else {
                return `${command} ${safePath}`;
            }
        }
        else {
            // Regular path → use single quotes (safest)
            const safePath = `'${this.escapeForSingleQuotes(expanded)}'`;
            // Build command based on encoding
            if (encoding === 'base64') {
                return `base64 ${safePath}`;
            }
            else if (command === 'cat') {
                return `cat ${safePath}`;
            }
            else if (command === 'tail') {
                return `tail ${safePath}`;
            }
            else {
                return `${command} ${safePath}`;
            }
        }
    }
    /**
     * Legacy escape method (kept for backward compatibility)
     * @deprecated Use escapeForSingleQuotes() or escapeForDoubleQuotes() instead
     */
    escapePath(path) {
        return this.escapeForSingleQuotes(path);
    }
}
//# sourceMappingURL=file-tools.js.map