/**
 * MCP Response Formatters - 70/20/10 Pattern
 * 
 * All tool responses should follow this structure:
 * - 70% Summary: Key insights, status, metrics
 * - 20% Data: Structured results (lists, tables)
 * - 10% Next Steps: Actionable follow-up commands
 */

// ============================================================================
// Success Response Formatter
// ============================================================================

export interface SuccessOptions {
  /** Title/header for the response */
  title: string;
  /** Summary section (70% of content) */
  summary: string;
  /** Optional data section (20% of content) */
  data?: string;
  /** Optional next steps (10% of content) */
  nextSteps?: string[];
  /** Optional metadata footer */
  metadata?: Record<string, string | number>;
}

/**
 * Format a successful response using 70/20/10 pattern
 */
export function formatSuccess(opts: SuccessOptions): string {
  const parts: string[] = [];

  // Title
  parts.push(`✓ ${opts.title}`);
  parts.push('');

  // Summary (70%)
  parts.push(opts.summary);

  // Data section (20%)
  if (opts.data) {
    parts.push('');
    parts.push('---');
    parts.push(opts.data);
  }

  // Next steps (10%)
  if (opts.nextSteps?.length) {
    parts.push('');
    parts.push('---');
    parts.push('**Next Steps:**');
    opts.nextSteps.forEach(step => parts.push(`→ ${step}`));
  }

  // Metadata footer
  if (opts.metadata && Object.keys(opts.metadata).length > 0) {
    parts.push('');
    parts.push('---');
    const metaStr = Object.entries(opts.metadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    parts.push(`*${metaStr}*`);
  }

  return parts.join('\n');
}

// ============================================================================
// Error Response Formatter
// ============================================================================

export interface ErrorOptions {
  /** Error code (e.g., RATE_LIMITED, TIMEOUT) */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Is this error retryable? */
  retryable?: boolean;
  /** How to fix the error */
  howToFix?: string[];
  /** Alternative actions */
  alternatives?: string[];
  /** Tool name for context */
  toolName?: string;
}

/**
 * Format an error response with recovery guidance
 * Designed to keep agents moving — every error includes actionable alternatives
 */
export function formatError(opts: ErrorOptions): string {
  const parts: string[] = [];

  // Error header
  const prefix = opts.toolName ? `[${opts.toolName}] ` : '';
  parts.push(`❌ ${prefix}${opts.code}: ${opts.message}`);

  // Retryable hint — be specific about what to do while waiting
  if (opts.retryable) {
    parts.push('');
    parts.push('*This error is retryable. Wait a moment and try again — but use the alternatives below in the meantime so research continues.*');
  }

  // How to fix
  if (opts.howToFix?.length) {
    parts.push('');
    parts.push('**How to Fix:**');
    opts.howToFix.forEach((step, i) => parts.push(`${i + 1}. ${step}`));
  }

  // Alternatives — directive, not optional
  if (opts.alternatives?.length) {
    parts.push('');
    parts.push('**DO THIS INSTEAD (don\'t stop researching):**');
    opts.alternatives.forEach((alt, i) => parts.push(`${i + 1}. ${alt}`));
  }

  // Continuation footer — push agents to keep going
  if (opts.alternatives?.length) {
    parts.push('');
    parts.push('> This tool failed but your research should NOT stop. Use the alternatives above to continue gathering information from other sources.');
  }

  return parts.join('\n');
}

// ============================================================================
// Batch Header Formatter
// ============================================================================

export interface BatchHeaderOptions {
  /** Batch operation title */
  title: string;
  /** Total items attempted */
  totalItems: number;
  /** Successfully processed count */
  successful: number;
  /** Failed count */
  failed: number;
  /** Optional tokens per item */
  tokensPerItem?: number;
  /** Optional batch count */
  batches?: number;
  /** Extra stats to include */
  extras?: Record<string, string | number>;
}

/**
 * Format a batch operation header with stats
 */
export function formatBatchHeader(opts: BatchHeaderOptions): string {
  const parts: string[] = [];

  // Title with emoji based on success rate
  const successRate = opts.totalItems > 0 ? opts.successful / opts.totalItems : 0;
  const emoji = successRate === 1 ? '✓' : successRate >= 0.5 ? '⚠️' : '❌';
  parts.push(`${emoji} ${opts.title}`);
  parts.push('');

  // Stats
  parts.push(`• Total: ${opts.totalItems}`);
  parts.push(`• Successful: ${opts.successful}`);
  if (opts.failed > 0) {
    parts.push(`• Failed: ${opts.failed}`);
  }
  if (opts.tokensPerItem) {
    parts.push(`• Tokens/item: ~${opts.tokensPerItem.toLocaleString()}`);
  }
  if (opts.batches) {
    parts.push(`• Batches: ${opts.batches}`);
  }

  // Extra stats
  if (opts.extras) {
    Object.entries(opts.extras).forEach(([key, val]) => {
      parts.push(`• ${key}: ${val}`);
    });
  }

  return parts.join('\n');
}

// ============================================================================
// List Formatter
// ============================================================================

export interface ListItem {
  /** Item title/name */
  title: string;
  /** Optional description */
  description?: string;
  /** Optional metadata */
  meta?: string;
  /** Optional URL */
  url?: string;
}

/**
 * Format a numbered list with optional metadata
 */
export function formatList(items: ListItem[], options?: { maxItems?: number; numbered?: boolean }): string {
  const max = options?.maxItems ?? 20;
  const numbered = options?.numbered ?? true;
  const toShow = items.slice(0, max);
  const remaining = items.length - max;

  const lines = toShow.map((item, i) => {
    const prefix = numbered ? `${i + 1}. ` : '• ';
    let line = `${prefix}**${item.title}**`;
    if (item.meta) {
      line += ` (${item.meta})`;
    }
    if (item.description) {
      line += `\n   ${item.description}`;
    }
    if (item.url) {
      line += `\n   ${item.url}`;
    }
    return line;
  });

  if (remaining > 0) {
    lines.push(`\n*...and ${remaining} more*`);
  }

  return lines.join('\n');
}

// ============================================================================
// Duration Formatter
// ============================================================================

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ============================================================================
// Text Truncation
// ============================================================================

/**
 * Truncate text to max length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
