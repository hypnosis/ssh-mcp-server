#!/usr/bin/env node
/**
 * SSH MCP Server Entry Point
 * SSH MCP Server for AI assistants (Cursor, Claude Desktop)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './utils/logger.js';
import { installProcessGuards } from './utils/process-guards.js';
import { getAvailableProfiles, getDefaultProfile } from './utils/profile-resolver.js';
import { createMcpServer } from './mcp-server.js';
import { listControlSockets, idleWindowSec } from './runner/control-sockets.js';

/**
 * Сказать на выходе, что осталось на машине.
 *
 * Соединения переживают сервер намеренно: сокет общий, и закрытие рвало бы
 * канал соседнему окну. Сколько именно осталось жить каждому — не считаем:
 * время сокета показывает подъём соединения, а не последнюю команду.
 */
async function reportLeftoverConnections(): Promise<void> {
  const sockets = await listControlSockets();
  if (sockets.length === 0) return;

  const alive = sockets.filter((socket) => socket.state === 'alive');
  const stale = sockets.filter((socket) => socket.state === 'stale');

  logger.info(
    `Оставлено соединений: ${alive.length} (закроются сами через ${idleWindowSec()} с простоя)`
  );
  for (const socket of alive) {
    logger.info(`  ${socket.path} — поднято ${socket.since.toISOString()}`);
  }
  if (stale.length > 0) {
    logger.info(`Сокеты без соединения: ${stale.length} — уйдут при следующей команде`);
  }
  logger.info('Закрыть сразу: ssh -O exit <сервер> с теми же настройками профиля');
}

async function main() {
  // Одна сорвавшаяся операция не должна уносить весь сервер
  installProcessGuards();

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
    logger.info(`\nReceived ${signal}, shutting down SSH MCP Server...`);
    
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
