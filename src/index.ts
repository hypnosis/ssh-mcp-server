#!/usr/bin/env node
/**
 * SSH MCP Server Entry Point
 * SSH MCP Server for AI assistants (Cursor, Claude Desktop)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './utils/logger.js';
import { getAvailableProfiles, getDefaultProfile } from './utils/profile-resolver.js';
import { ExecTool } from './tools/exec-tool.js';
import { FileTools } from './tools/file-tools.js';
import { LogTools } from './tools/log-tools.js';
import { SnapshotTool } from './tools/snapshot-tool.js';

async function main() {
  // Get version from package.json
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const version = packageJson.version || '1.0.0';
  logger.info(`Starting SSH MCP Server v${version}`);

  // Load SSH profiles from SSH_PROFILES_FILE
  logger.debug(`[MCP Server] Checking SSH_PROFILES_FILE environment variable...`);
  const profilesFile = process.env.SSH_PROFILES_FILE;
  if (profilesFile) {
    logger.debug(`[MCP Server] SSH_PROFILES_FILE=${profilesFile}`);
  } else {
    logger.error(`[MCP Server] ❌ SSH_PROFILES_FILE environment variable not set`);
  }
  
  try {
    logger.debug(`[MCP Server] Loading SSH profiles...`);
    const profiles = getAvailableProfiles();
    const defaultProfile = getDefaultProfile();
    logger.info(`[MCP Server] ✅ Loaded ${profiles.length} SSH profiles: ${profiles.join(', ')}`);
    logger.info(`[MCP Server] Default profile: "${defaultProfile}"`);
    logger.debug(`[MCP Server] Profile details:`, profiles.map(p => ({ name: p, default: p === defaultProfile })));
  } catch (error: any) {
    logger.error(`[MCP Server] ❌ Failed to load SSH profiles: ${error.message}`);
    logger.error(`[MCP Server] Please set SSH_PROFILES_FILE environment variable`);
    logger.debug(`[MCP Server] Error details:`, error);
    process.exit(1);
  }

  // Initialize tools
  const execTool = new ExecTool();
  const fileTools = new FileTools();
  const logTools = new LogTools();
  const snapshotTool = new SnapshotTool();

  // Create MCP Server
  const server = new Server(
    {
      name: 'ssh-mcp-server',
      version: version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('ListTools request received');
    
    const allTools = [
      execTool.getTool(),
      ...fileTools.getTools(),
      ...logTools.getTools(),
      snapshotTool.getTool(),
    ];
    
    logger.info(`Returning ${allTools.length} tools to MCP client`);
    logger.debug(`Tool names: ${allTools.map(t => t.name).join(', ')}`);
    
    return {
      tools: allTools,
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    logger.debug('CallTool request:', request.params.name);

    const toolName = request.params.name;

    // Route to appropriate tool handler
    if (toolName === 'ssh_exec') {
      return execTool.handleCall(request);
    }

    if (toolName.startsWith('ssh_file_')) {
      return fileTools.handleCall(request);
    }

    if (toolName.startsWith('ssh_log_')) {
      return logTools.handleCall(request);
    }

    if (toolName === 'ssh_snapshot') {
      return snapshotTool.handleCall(request);
    }

    throw new Error(`Unknown tool: ${toolName}`);
  });

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('SSH MCP Server started successfully');
  
  // Calculate actual tool count
  const toolCount = 
    1 + // execTool
    fileTools.getTools().length +
    logTools.getTools().length +
    1; // snapshotTool
  
  logger.info(`Registered tools: ${toolCount} commands (1 exec + ${fileTools.getTools().length} file + ${logTools.getTools().length} log + 1 snapshot)`);
  logger.info('Listening on STDIO...');
}

// Error handling
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
