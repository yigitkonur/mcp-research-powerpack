/**
 * Shared Tool Utilities
 * Extracted from individual handlers to eliminate duplication
 */

// Re-export from centralized modules
export {
  mcpLog,
  safeLog as safeLogSimple,
  createToolLogger,
  type LogLevel,
  type ToolLogger as SimpleToolLogger,
} from '../utils/logger.js';

export {
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatList,
  formatDuration,
  truncateText,
  type SuccessOptions,
  type ErrorOptions,
  type BatchHeaderOptions,
  type ListItem,
} from '../utils/response.js';

// ============================================================================
// Token Budget Constants
// ============================================================================

/**
 * Centralized token budgets for all tools
 */
export const TOKEN_BUDGETS = {
  /** Deep research total budget */
  RESEARCH: 32_000,
  /** Web scraper total budget */
  SCRAPER: 32_000,
  /** Reddit comment budget per batch */
  REDDIT_COMMENTS: 1_000,
} as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Logger function type used by tools
 */
export type ToolLogger = (
  level: 'info' | 'error' | 'debug',
  message: string,
  sessionId: string
) => Promise<void>;

/**
 * Standard tool options passed to handlers
 */
export interface ToolOptions {
  sessionId?: string;
  logger?: ToolLogger;
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Safe logger wrapper - NEVER throws
 * Logs to provided logger or falls back to console.error
 *
 * @param logger - Optional logger function
 * @param sessionId - Session ID for logging context
 * @param level - Log level
 * @param message - Message to log
 * @param toolName - Name of the tool for prefixing
 */
export async function safeLog(
  logger: ToolLogger | undefined,
  sessionId: string | undefined,
  level: 'info' | 'error' | 'debug',
  message: string,
  toolName: string
): Promise<void> {
  if (!logger || !sessionId) return;
  try {
    await logger(level, `[${toolName}] ${message}`, sessionId);
  } catch {
    // Silently ignore logger errors - they should never crash the tool
    console.error(`[${toolName}] Logger failed: ${message}`);
  }
}

// ============================================================================
// Token Allocation
// ============================================================================

/**
 * Calculate token allocation for batch operations
 * Distributes a fixed budget across multiple items
 *
 * @param count - Number of items to distribute budget across
 * @param budget - Total token budget
 * @returns Tokens per item
 */
export function calculateTokenAllocation(count: number, budget: number): number {
  if (count <= 0) return budget;
  return Math.floor(budget / count);
}

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format retry hint based on error retryability
 *
 * @param retryable - Whether the error is retryable
 * @returns Hint string or empty string
 */
export function formatRetryHint(retryable: boolean): string {
  return retryable
    ? '\n\n💡 This error may be temporary. Try again in a moment.'
    : '';
}

/**
 * Create a standard error markdown response
 *
 * @param toolName - Name of the tool that errored
 * @param errorCode - Error code
 * @param message - Error message
 * @param retryable - Whether error is retryable
 * @param tip - Optional tip for resolution
 * @returns Formatted markdown error string
 */
export function formatToolError(
  toolName: string,
  errorCode: string,
  message: string,
  retryable: boolean,
  tip?: string
): string {
  const retryHint = formatRetryHint(retryable);
  const tipSection = tip ? `\n\n**Tip:** ${tip}` : '';
  return `# ❌ ${toolName}: Operation Failed\n\n**${errorCode}:** ${message}${retryHint}${tipSection}`;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a value is a non-empty array
 *
 * @param value - Value to check
 * @param fieldName - Field name for error message
 * @returns Error message or undefined if valid
 */
export function validateNonEmptyArray(
  value: unknown,
  fieldName: string
): string | undefined {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }
  if (value.length === 0) {
    return `${fieldName} must not be empty`;
  }
  return undefined;
}

/**
 * Validate array length is within bounds
 *
 * @param arr - Array to check
 * @param min - Minimum length
 * @param max - Maximum length
 * @param fieldName - Field name for error message
 * @returns Error message or undefined if valid
 */
export function validateArrayBounds(
  arr: unknown[],
  min: number,
  max: number,
  fieldName: string
): string | undefined {
  if (arr.length < min) {
    const deficit = min - arr.length;
    return `${fieldName} requires at least ${min} items but you sent ${arr.length}. **Add ${deficit} more item(s)** to your list and call this tool again immediately. Tip: each item should cover a different angle for maximum coverage.`;
  }
  if (arr.length > max) {
    const excess = arr.length - max;
    return `${fieldName} allows at most ${max} items but you sent ${arr.length}. **Remove ${excess} item(s)** (drop the least relevant ones) and call this tool again. If you need all ${arr.length}, split into ${Math.ceil(arr.length / max)} separate calls of ${max} items each.`;
  }
  return undefined;
}

// ============================================================================
// Response Builders
// ============================================================================

/**
 * Build standard header for batch operation results
 *
 * @param title - Title of the results section
 * @param count - Number of items processed
 * @param tokensPerItem - Tokens allocated per item
 * @param totalBudget - Total token budget
 * @returns Formatted header string
 */
export function buildBatchHeader(
  title: string,
  count: number,
  tokensPerItem: number,
  totalBudget: number
): string {
  return `# ${title} (${count} items)\n\n**Token Allocation:** ${tokensPerItem.toLocaleString()} tokens/item (${count} items, ${totalBudget.toLocaleString()} total budget)`;
}

/**
 * Build status line for batch results
 *
 * @param successful - Number of successful items
 * @param failed - Number of failed items
 * @param batches - Number of batches processed
 * @param extras - Optional extra status items
 * @returns Formatted status line
 */
export function buildStatusLine(
  successful: number,
  failed: number,
  batches: number,
  extras?: string[]
): string {
  let status = `**Status:** ✅ ${successful} successful | ❌ ${failed} failed | 📦 ${batches} batch(es)`;
  if (extras && extras.length > 0) {
    status += ` | ${extras.join(' | ')}`;
  }
  return status;
}
