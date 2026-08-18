/**
 * Assembly of the MCP server: the declared tool list and the call routing
 * are built from the same source, so it is impossible to declare a tool
 * without wiring it up.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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
import { SERVER_INSTRUCTIONS } from './tools/instructions.js';
import { RESOURCES, readResource } from './tools/resources.js';

/** A class of tools and its call handler */
interface ToolProvider {
  tools: Tool[];
  call: (request: CallToolRequest, signal?: AbortSignal) => Promise<ToolResult>;
}

/** The server and the list of tools it declares */
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
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: RESOURCES };
  });

  // The profiles are read on every request rather than captured once: the file
  // is watched and reloaded, and a stale list would name machines that are gone
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    logger.debug('ReadResource request:', request.params.uri);
    return { contents: [readResource(request.params.uri)] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug(`ListTools request received, returning ${tools.length} tools`);
    return { tools };
  });

  // Cancellation is delivered only to tools that just execute commands.
  // File transfer does not take it: the replacement has a window where the
  // target has already been moved aside but the new copy hasn't landed yet
  // — aborting there would leave that emptiness in place
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
