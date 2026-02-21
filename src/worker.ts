/**
 * Cloudflare Workers entry point for Research Powerpack MCP
 * Uses the `agents` package McpAgent pattern for Durable Object-backed MCP sessions.
 *
 * NOTE: This file deliberately avoids importing from `tools/definitions.ts` because
 * that module loads YAML from disk via `config/loader.ts` (readFileSync + import.meta.url),
 * which is incompatible with the Workers runtime. Instead, tools are registered directly
 * from `toolRegistry` which carries Zod schemas and handlers without filesystem access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';

import { toolRegistry, executeTool } from './tools/registry.js';
import { getCapabilities, SERVER, resetEnvCache } from './config/index.js';

/**
 * Bridge Cloudflare Worker env bindings into process.env so that
 * config modules (which read process.env) work in both STDIO and Workers.
 */
function bridgeEnv(env: Record<string, unknown>): void {
  const keys = [
    'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
    'SERPER_API_KEY', 'SCRAPEDO_API_KEY',
    'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET',
    'RESEARCH_MODEL', 'RESEARCH_FALLBACK_MODEL',
    'API_TIMEOUT_MS', 'DEFAULT_REASONING_EFFORT', 'DEFAULT_MAX_URLS',
    'LLM_EXTRACTION_MODEL', 'LLM_ENABLE_REASONING',
    'DEBUG_REDDIT',
  ];
  for (const key of keys) {
    if (env[key] !== undefined && typeof env[key] === 'string') {
      process.env[key] = env[key] as string;
    }
  }
  // Reset cached configs so they re-read from the now-populated process.env
  resetEnvCache();
}

// Short descriptions for each tool (avoids pulling from YAML at runtime)
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_reddit:
    'Search Reddit with 10-50 diverse parallel queries. Each query targets a different angle.',
  get_reddit_post:
    'Fetch Reddit posts and comments. Supports AI extraction via use_llm flag.',
  deep_research:
    'Deep research with 2-10 parallel questions and 32K token budget.',
  scrape_links:
    'Scrape 1-50 URLs with optional AI content extraction.',
  web_search:
    'Parallel Google search with 3-100 keywords returning 10 results each.',
};

export class ResearchMcpPowerpack extends McpAgent {
  server = new McpServer({
    name: SERVER.NAME,
    version: SERVER.VERSION,
  });

  async init() {
    // Bridge Cloudflare env bindings into process.env for config modules
    if (this.env) {
      bridgeEnv(this.env as unknown as Record<string, unknown>);
    }

    const capabilities = getCapabilities();

    for (const [name, tool] of Object.entries(toolRegistry)) {
      const description = TOOL_DESCRIPTIONS[name] ?? name;
      // Extract the raw Zod shape from the ZodObject for McpServer.tool()
      const shape = (tool.schema as any).shape ?? {};

      this.server.tool(
        name,
        description,
        shape,
        async (args: Record<string, unknown>) => {
          try {
            return await executeTool(name, args, capabilities);
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
    // Bridge env bindings on every request so config reads work
    if (env && typeof env === 'object') {
      bridgeEnv(env as Record<string, unknown>);
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', name: SERVER.NAME, version: SERVER.VERSION }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Handle OAuth discovery endpoints - return 404 to indicate authless server
    // Per MCP spec: authless servers should NOT serve OAuth metadata
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname.startsWith('/.well-known/oauth-protected-resource/') ||
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      return new Response(
        JSON.stringify({
          error: 'not_found',
          error_description: 'This is an authless MCP server. No authentication required.'
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        },
      );
    }

    if (url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/message') {
      return ResearchMcpPowerpack.serve('/mcp').fetch(request, env, ctx);
    }

    // Return JSON for 404s to avoid parse errors
    return new Response(
      JSON.stringify({ error: 'Not found', path: url.pathname }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  },
};
