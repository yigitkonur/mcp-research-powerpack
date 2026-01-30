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

const server = new Server(
  { name: SERVER.NAME, version: SERVER.VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/**
 * Tool execution handler - uses registry pattern for clean routing
 * All capability checks, validation, and error handling are in executeTool
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // All routing handled by registry - no more if/else blocks!
    return await executeTool(name, args, capabilities);
  } catch (error) {
    // McpError propagates to client as protocol error
    if (error instanceof McpError) {
      throw error;
    }
    
    // Unexpected error - format as tool error
    const structuredError = classifyError(error);
    console.error(`[MCP Server] Tool "${name}" error:`, {
      code: structuredError.code,
      message: structuredError.message,
      retryable: structuredError.retryable,
    });
    return createToolErrorFromStructured(structuredError);
  }
});

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

// Handle uncaught exceptions - MUST EXIT per Node.js docs
// The VM is in an unstable state after uncaught exception
process.on('uncaughtException', (error: Error) => {
  console.error(`[MCP Server] FATAL uncaughtException at ${new Date().toISOString()}:`);
  console.error(`  Message: ${error.message}`);
  console.error(`  Stack: ${error.stack}`);
  gracefulShutdown(1);
});

// Handle unhandled promise rejections - MUST EXIT (Node v15+ behavior)
// Suppressing this risks memory leaks and corrupted state
process.on('unhandledRejection', (reason: unknown) => {
  const error = classifyError(reason);
  console.error(`[MCP Server] FATAL unhandledRejection at ${new Date().toISOString()}:`);
  console.error(`  Message: ${error.message}`);
  console.error(`  Code: ${error.code}`);
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
// Start Server
// ============================================================================

const transport = new StdioServerTransport();

// Connect with error handling
try {
  server.connect(transport);
  console.error(`🚀 ${SERVER.NAME} v${SERVER.VERSION} ready`);
} catch (error) {
  const err = classifyError(error);
  console.error(`[MCP Server] Failed to start: ${err.message}`);
  process.exit(1);
}
