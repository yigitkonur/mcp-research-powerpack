/**
 * Cloudflare Workers entry point for Research Powerpack MCP
 * Uses the `agents` package McpAgent pattern for Durable Object-backed MCP sessions
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';

import { TOOLS } from './tools/definitions.js';
import { executeTool, getToolCapabilities } from './tools/registry.js';
import { getCapabilities, SERVER } from './config/index.js';

export class ResearchPowerpackMCP extends McpAgent {
  server = new McpServer({
    name: SERVER.NAME,
    version: SERVER.VERSION,
  });

  async init() {
    const capabilities = getCapabilities();

    // Register each tool from TOOLS definitions with the McpServer
    for (const tool of TOOLS) {
      // Build a Zod schema from the JSON Schema inputSchema
      // The tool definitions use JSON Schema, but McpServer.tool() accepts Zod or raw shapes
      this.server.tool(
        tool.name,
        tool.description,
        tool.inputSchema as Record<string, unknown>,
        async (args: Record<string, unknown>) => {
          try {
            const result = await executeTool(tool.name, args, capabilities);
            return result;
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    }
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', name: SERVER.NAME, version: SERVER.VERSION }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/message') {
      return ResearchPowerpackMCP.serve('/mcp').fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};
