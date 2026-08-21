#!/usr/bin/env node
/**
 * SSH MCP Server entry point
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './utils/logger.js';
import { installProcessGuards } from './utils/process-guards.js';
import { getAvailableProfiles } from './utils/profile-resolver.js';
import { createMcpServer } from './mcp-server.js';
import { reportLeftoverConnections } from './runner/leftover-report.js';

async function main() {
  // A single failed operation must not take down the whole server
  installProcessGuards();

  // Get version from package.json
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const version = packageJson.version || '1.0.0';
  logger.info(`Starting SSH MCP Server v${version}`);

  // Profiles are read at startup to report them, not to gate it: a server that
  // exits over a missing file cannot answer tools/list, and the machine to
  // reach is named per call anyway
  logger.debug(`[MCP Server] Checking SSH_PROFILES_FILE environment variable...`);
  const profilesFile = process.env.SSH_PROFILES_FILE;
  if (profilesFile) {
    logger.debug(`[MCP Server] SSH_PROFILES_FILE=${profilesFile}`);
  }

  try {
    logger.debug(`[MCP Server] Loading SSH profiles...`);
    const profiles = getAvailableProfiles();
    logger.info(`[MCP Server] Loaded ${profiles.length} SSH profiles: ${profiles.join(', ')}`);
  } catch (error: any) {
    logger.warn(`[MCP Server] No usable SSH profiles: ${error.message}`);
    logger.warn(`[MCP Server] Tools stay listed; every call fails with that message until profiles load`);
    logger.debug(`[MCP Server] Error details:`, error);
  }

  const { server, tools } = createMcpServer(version);

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('SSH MCP Server started successfully');
  logger.info(`Registered tools: ${tools.length}`);
  logger.debug(`Tool names: ${tools.map((tool) => tool.name).join(', ')}`);
  logger.info('Listening on STDIO...');
  
  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down SSH MCP Server...`);
    
    try {
      await reportLeftoverConnections();
      logger.info('SSH MCP Server stopped gracefully');
      process.exit(0);
    } catch (error: any) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };
  
  // Register signal handlers
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Error handling
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
