#!/usr/bin/env node

/**
 * Research Powerpack MCP Server
 * Implements robust error handling - server NEVER crashes on tool failures
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools/definitions.js';
import { executeTool, getToolCapabilities } from './tools/registry.js';
import { classifyError, createToolErrorFromStructured } from './utils/errors.js';
import { SERVER, getCapabilities } from './config/index.js';
import { initLogger } from './utils/logger.js';

// ============================================================================
// Capability Detection (uses registry for tool capability mapping)
// ============================================================================

const capabilities = getCapabilities();
const { enabled: enabledTools, disabled: disabledTools } = getToolCapabilities();

if (enabledTools.length > 0) {
  console.error(`✅ Enabled tools: ${enabledTools.join(', ')}`);
}
if (disabledTools.length > 0) {
  console.error(`⚠️ Disabled tools (missing ENV): ${disabledTools.join(', ')}`);
}
if (capabilities.scraping && !capabilities.llmExtraction) {
  console.error(`ℹ️ scrape_links: AI extraction (use_llm) disabled - set OPENROUTER_API_KEY to enable`);
}

// ============================================================================
// Server Setup
// ============================================================================

/**
 * Register shared tool handlers on any Server instance.
 * Used by both STDIO and HTTP session servers to avoid duplication.
 */
function registerToolHandlers(srv: Server): void {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await executeTool(name, args, capabilities);
    } catch (error) {
      if (error instanceof McpError) throw error;
      const structuredError = classifyError(error);
      console.error(`[MCP Server] Tool "${name}" error:`, {
        code: structuredError.code,
        message: structuredError.message,
        retryable: structuredError.retryable,
      });
      return createToolErrorFromStructured(structuredError);
    }
  });
}

const server = new Server(
  { name: SERVER.NAME, version: SERVER.VERSION },
  { capabilities: { tools: {}, logging: {} } }
);

initLogger(server);
registerToolHandlers(server);

// ============================================================================
// Global Error Handlers - MUST EXIT on fatal errors per Node.js best practices
// See: https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly
// ============================================================================

// Track shutdown state to prevent double shutdown
let isShuttingDown = false;

/**
 * Graceful shutdown handler - closes server and exits
 * @param exitCode - Exit code (0 for clean shutdown, 1 for error)
 */
async function gracefulShutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    await server.close();
    console.error(`[MCP Server] Server closed at ${new Date().toISOString()}`);
  } catch (closeError) {
    console.error('[MCP Server] Error closing server:', closeError);
  } finally {
    process.exit(exitCode);
  }
}

/**
 * Safely extract error information without triggering another exception
 * Prevents infinite loops when error objects have problematic getters
 */
function safeErrorString(error: unknown): string {
  try {
    if (error instanceof Error) {
      // Try to get message and stack safely
      const message = String(error.message || 'Unknown error');
      try {
        const stack = String(error.stack || '');
        if (!stack) {
          return message;
        }
        // Avoid duplicating the message when the stack already includes it
        return stack.includes(message) ? stack : `${message}\n${stack}`;
      } catch {
        return message; // Stack serialization failed, just return message
      }
    }
    return String(error);
  } catch {
    // Even String() can fail on some objects
    return '[Error: Unable to serialize error object]';
  }
}

// Handle uncaught exceptions - MUST EXIT per Node.js docs
// The VM is in an unstable state after uncaught exception
process.on('uncaughtException', (error: Error) => {
  try {
    console.error(`[MCP Server] FATAL uncaughtException at ${new Date().toISOString()}:`);
    console.error(safeErrorString(error));
  } catch {
    // Even logging failed - just exit
    console.error('[MCP Server] FATAL uncaughtException (unable to log details)');
  }
  gracefulShutdown(1);
});

// Handle unhandled promise rejections - MUST EXIT (Node v15+ behavior)
// Suppressing this risks memory leaks and corrupted state
process.on('unhandledRejection', (reason: unknown) => {
  try {
    const error = classifyError(reason);
    console.error(`[MCP Server] FATAL unhandledRejection at ${new Date().toISOString()}:`);
    console.error(`  Message: ${error.message}`);
    console.error(`  Code: ${error.code}`);
  } catch {
    // classifyError or logging failed, use safeErrorString as fallback
    console.error('[MCP Server] FATAL unhandledRejection (unable to classify error):');
    console.error(safeErrorString(reason));
  }
  gracefulShutdown(1);
});

// Handle SIGTERM gracefully (Docker/Kubernetes stop signal)
process.on('SIGTERM', () => {
  console.error(`[MCP Server] Received SIGTERM at ${new Date().toISOString()}, shutting down gracefully`);
  gracefulShutdown(0);
});

// Handle SIGINT gracefully (Ctrl+C) - use once() to prevent double-fire
process.once('SIGINT', () => {
  console.error(`[MCP Server] Received SIGINT at ${new Date().toISOString()}, shutting down gracefully`);
  gracefulShutdown(0);
});

// ============================================================================
// Stdin disconnect detection
// The MCP SDK's StdioServerTransport does NOT listen for stdin 'close'/'end'.
// When the parent process disconnects (closes the pipe), stdin emits these
// events but nobody handles them — Node.js keeps polling the dead fd at 100%
// CPU. We fix this by detecting the disconnect and exiting cleanly.
// ============================================================================

process.stdin.on('close', () => {
  console.error(`[MCP Server] stdin closed (parent disconnected) at ${new Date().toISOString()}, shutting down`);
  gracefulShutdown(0);
});

process.stdin.on('end', () => {
  console.error(`[MCP Server] stdin ended (parent disconnected) at ${new Date().toISOString()}, shutting down`);
  gracefulShutdown(0);
});

// Also handle stdout errors (broken pipe when parent is gone)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    console.error(`[MCP Server] stdout broken pipe at ${new Date().toISOString()}, shutting down`);
    gracefulShutdown(0);
  }
});

// ============================================================================
// Start Server — STDIO (default) or HTTP Streamable (MCP_TRANSPORT=http)
// ============================================================================

const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

if (transportMode === 'http') {
  // HTTP Streamable transport — stateful sessions over HTTP
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { createServer: createHttpServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');

  const PORT = parseInt(process.env.MCP_PORT || '3000', 10);

  // Map of session ID → transport + server for multi-session support
  const sessions = new Map<string, {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Server;
  }>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: SERVER.NAME, version: SERVER.VERSION }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Handle DELETE — session termination
      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          sessions.delete(sessionId);
          try { await session.server.close(); } catch { /* ignore */ }
        } else {
          res.writeHead(404).end('Session not found');
        }
        return;
      }

      // For GET/POST — find existing session or create new one
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } else if (!sessionId && req.method === 'POST') {
        // New session (initialization)
        const sessionServer = new Server(
          { name: SERVER.NAME, version: SERVER.VERSION },
          { capabilities: { tools: {}, logging: {} } }
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server: sessionServer });
            console.error(`[HTTP] Session ${id} initialized`);
          },
          onsessionclosed: async (id) => {
            const session = sessions.get(id);
            if (session) {
              sessions.delete(id);
              try { await session.server.close(); } catch { /* ignore */ }
            }
            console.error(`[HTTP] Session ${id} closed`);
          },
        });

        // Note: initLogger overwrites a global serverRef, so logs from all
        // HTTP sessions route to the most-recently-initialized session.
        // A true per-session logger is out of scope for this fix.
        initLogger(sessionServer);
        registerToolHandlers(sessionServer);

        await sessionServer.connect(transport);
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400).end('Bad request — missing session ID');
      }
      return;
    }

    res.writeHead(404).end('Not found');
  });

  httpServer.listen(PORT, () => {
    console.error(`🚀 ${SERVER.NAME} v${SERVER.VERSION} listening on http://localhost:${PORT}/mcp`);
  });
} else {
  // STDIO transport (default)
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error(`🚀 ${SERVER.NAME} v${SERVER.VERSION} ready (stdio)`);
  } catch (error) {
    const err = classifyError(error);
    console.error(`[MCP Server] Failed to start: ${err.message}`);
    process.exit(1);
  }
}
