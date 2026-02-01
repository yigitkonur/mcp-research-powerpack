/**
 * Handler Registry - Central tool registration and execution
 * Eliminates repetitive if/else routing with declarative registration
 */

import { z, ZodError } from 'zod';
import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { parseEnv, getCapabilities, getMissingEnvMessage, type Capabilities } from '../config/index.js';
import { classifyError, createToolErrorFromStructured } from '../utils/errors.js';

// Import schemas
import { deepResearchParamsSchema, type DeepResearchParams } from '../schemas/deep-research.js';
import { scrapeLinksParamsSchema, type ScrapeLinksParams } from '../schemas/scrape-links.js';
import { webSearchParamsSchema, type WebSearchParams } from '../schemas/web-search.js';

// Import handlers
import { handleSearchReddit, handleGetRedditPosts } from './reddit.js';
import { handleDeepResearch } from './research.js';
import { handleScrapeLinks } from './scrape.js';
import { handleWebSearch } from './search.js';

// ============================================================================
// Types
// ============================================================================

/**
 * MCP-compliant tool result with index signature for SDK compatibility
 */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Configuration for a registered tool
 */
export interface ToolRegistration {
  name: string;
  capability?: keyof Capabilities;
  schema: z.ZodSchema;
  handler: (params: unknown) => Promise<string>;
  postValidate?: (params: unknown) => string | undefined;
  transformResponse?: (result: string) => { content: string; isError?: boolean };
}

/**
 * Registry type
 */
export type ToolRegistry = Record<string, ToolRegistration>;

// ============================================================================
// Schemas for Simple Tools (inline definitions)
// ============================================================================

const searchRedditParamsSchema = z.object({
  queries: z.array(z.string()).min(10).max(50),
  date_after: z.string().optional(),
});

const getRedditPostParamsSchema = z.object({
  urls: z.array(z.string()).min(2).max(50),
  fetch_comments: z.boolean().default(true),
  max_comments: z.number().default(100),
  use_llm: z.boolean().default(false),
  what_to_extract: z.string().optional(),
});

// ============================================================================
// Handler Wrappers
// ============================================================================

const env = parseEnv();

/**
 * Wrapper for search_reddit handler
 */
async function searchRedditHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof searchRedditParamsSchema>;
  return handleSearchReddit(p.queries, env.SEARCH_API_KEY || '', p.date_after);
}

/**
 * Wrapper for get_reddit_post handler
 */
async function getRedditPostHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof getRedditPostParamsSchema>;
  return handleGetRedditPosts(
    p.urls,
    env.REDDIT_CLIENT_ID || '',
    env.REDDIT_CLIENT_SECRET || '',
    p.max_comments,
    {
      fetchComments: p.fetch_comments,
      maxCommentsOverride: p.max_comments !== 100 ? p.max_comments : undefined,
      use_llm: p.use_llm,
      what_to_extract: p.what_to_extract,
    }
  );
}

/**
 * Wrapper for deep_research handler
 */
async function deepResearchHandler(params: unknown): Promise<string> {
  const { content } = await handleDeepResearch(params as DeepResearchParams);
  return content;
}

/**
 * Wrapper for scrape_links handler
 */
async function scrapeLinksHandler(params: unknown): Promise<string> {
  const { content } = await handleScrapeLinks(params as ScrapeLinksParams);
  return content;
}

/**
 * Wrapper for web_search handler
 */
async function webSearchHandler(params: unknown): Promise<string> {
  const { content } = await handleWebSearch(params as WebSearchParams);
  return content;
}

// ============================================================================
// Tool Registry
// ============================================================================

/**
 * Central registry of all MCP tools
 */
export const toolRegistry: ToolRegistry = {
  search_reddit: {
    name: 'search_reddit',
    capability: 'search',
    schema: searchRedditParamsSchema,
    handler: searchRedditHandler,
  },

  get_reddit_post: {
    name: 'get_reddit_post',
    capability: 'reddit',
    schema: getRedditPostParamsSchema,
    handler: getRedditPostHandler,
  },

  deep_research: {
    name: 'deep_research',
    capability: 'deepResearch',
    schema: deepResearchParamsSchema,
    handler: deepResearchHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ Error'),
    }),
  },

  scrape_links: {
    name: 'scrape_links',
    capability: 'scraping',
    schema: scrapeLinksParamsSchema,
    handler: scrapeLinksHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ Scraping Failed'),
    }),
  },

  web_search: {
    name: 'web_search',
    capability: 'search',
    schema: webSearchParamsSchema,
    handler: webSearchHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ web_search'),
    }),
  },
};

// ============================================================================
// Execute Tool (Main Entry Point)
// ============================================================================

/**
 * Execute a tool by name with full middleware chain
 *
 * Middleware steps:
 * 1. Lookup tool in registry (throw McpError if not found)
 * 2. Check capability (return error response if missing)
 * 3. Validate params with Zod (return error response if invalid)
 * 4. Execute handler (catch and format any errors)
 * 5. Transform response if needed
 *
 * @param name - Tool name from request
 * @param args - Raw arguments from request
 * @param capabilities - Current capabilities from getCapabilities()
 * @returns MCP-compliant tool result
 */
export async function executeTool(
  name: string,
  args: unknown,
  capabilities: Capabilities
): Promise<CallToolResult> {
  // Step 1: Lookup tool
  const tool = toolRegistry[name];
  if (!tool) {
    throw new McpError(
      McpErrorCode.MethodNotFound,
      `Method not found: ${name}. Available tools: ${Object.keys(toolRegistry).join(', ')}`
    );
  }

  // Step 2: Check capability
  if (tool.capability && !capabilities[tool.capability]) {
    return {
      content: [{ type: 'text', text: getMissingEnvMessage(tool.capability) }],
      isError: true,
    };
  }

  // Step 3: Validate params with Zod
  let validatedParams: unknown;
  try {
    validatedParams = tool.schema.parse(args);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => `- **${i.path.join('.') || 'root'}**: ${i.message}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: `# ❌ Validation Error\n\n${issues}` }],
        isError: true,
      };
    }
    // Non-Zod validation error
    const structured = classifyError(error);
    return createToolErrorFromStructured(structured);
  }

  // Step 3.5: Optional post-validation
  if (tool.postValidate) {
    const postError = tool.postValidate(validatedParams);
    if (postError) {
      return {
        content: [{ type: 'text', text: `# ❌ Validation Error\n\n${postError}` }],
        isError: true,
      };
    }
  }

  // Step 4: Execute handler
  let result: string;
  try {
    result = await tool.handler(validatedParams);
  } catch (error) {
    // Handler threw (shouldn't happen if handlers follow "never throw" pattern)
    const structured = classifyError(error);
    return createToolErrorFromStructured(structured);
  }

  // Step 5: Transform response
  if (tool.transformResponse) {
    const transformed = tool.transformResponse(result);
    return {
      content: [{ type: 'text', text: transformed.content }],
      isError: transformed.isError,
    };
  }

  // Default: success response
  return {
    content: [{ type: 'text', text: result }],
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get list of all registered tool names
 */
export function getRegisteredToolNames(): string[] {
  return Object.keys(toolRegistry);
}

/**
 * Check if a tool is registered
 */
export function isToolRegistered(name: string): boolean {
  return name in toolRegistry;
}

/**
 * Get tool capabilities for logging
 */
export function getToolCapabilities(): { enabled: string[]; disabled: string[] } {
  const caps = getCapabilities();
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [name, tool] of Object.entries(toolRegistry)) {
    const capKey = tool.capability;
    if (!capKey || caps[capKey]) {
      enabled.push(name);
    } else {
      disabled.push(name);
    }
  }

  return { enabled, disabled };
}
