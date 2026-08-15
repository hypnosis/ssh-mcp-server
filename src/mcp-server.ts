/**
 * Сборка MCP-сервера: объявленный список инструментов и маршрут вызова
 * строятся из одного источника, поэтому объявить инструмент и не подключить
 * его нельзя.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger.js';
import type { ToolResult } from './utils/tool-result.js';
import { ExecTool } from './tools/exec-tool.js';
import { FileTools } from './tools/file-tools.js';
import { JobTools } from './tools/job-tools.js';
import { LogTools } from './tools/log-tools.js';
import { SnapshotTool } from './tools/snapshot-tool.js';
import { MonitoringTool } from './tools/monitoring-tool.js';
import { TransferTool } from './tools/transfer-tool.js';
import { AuditTool } from './tools/audit-tool.js';

/** Класс инструментов и его обработчик вызова */
interface ToolProvider {
  tools: Tool[];
  call: (request: CallToolRequest, signal?: AbortSignal) => Promise<ToolResult>;
}

/** Сервер и список инструментов, который он объявляет */
export interface McpServerBundle {
  server: Server;
  tools: Tool[];
}

export function createMcpServer(version: string): McpServerBundle {
  const execTool = new ExecTool();
  const fileTools = new FileTools();
  const jobTools = new JobTools();
  const logTools = new LogTools();
  const snapshotTool = new SnapshotTool();
  const monitoringTool = new MonitoringTool();
  const transferTool = new TransferTool();
  const auditTool = new AuditTool();

  const providers: ToolProvider[] = [
    { tools: [execTool.getTool()], call: (request, signal) => execTool.handleCall(request, signal) },
    { tools: fileTools.getTools(), call: (request, signal) => fileTools.handleCall(request, signal) },
    { tools: jobTools.getTools(), call: (request, signal) => jobTools.handleCall(request, signal) },
    { tools: logTools.getTools(), call: (request, signal) => logTools.handleCall(request, signal) },
    { tools: [snapshotTool.getTool()], call: (request) => snapshotTool.handleCall(request) },
    { tools: [monitoringTool.getTool()], call: (request) => monitoringTool.handleCall(request) },
    { tools: transferTool.getTools(), call: (request) => transferTool.handleCall(request) },
    { tools: auditTool.getTools(), call: (request, signal) => auditTool.handleCall(request, signal) },
  ];

  const tools = providers.flatMap((provider) => provider.tools);
  const routes = new Map<string, ToolProvider['call']>();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      routes.set(tool.name, provider.call);
    }
  }

  const server = new Server(
    {
      name: 'ssh-mcp-server',
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug(`ListTools request received, returning ${tools.length} tools`);
    return { tools };
  });

  // Отмену вызова получают инструменты, которые только выполняют команды.
  // Передача файлов её не берёт: у замены есть окно, где цель уже отведена в
  // сторону, а новая копия ещё не встала на место, — прерваться там значит
  // оставить пустоту
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    logger.debug('CallTool request:', toolName);

    const call = routes.get(toolName);
    if (!call) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return call(request, extra.signal);
  });

  return { server, tools };
}
