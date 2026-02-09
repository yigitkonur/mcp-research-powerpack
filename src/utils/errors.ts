/**
 * Robust error handling utilities for MCP server
 * Ensures the server NEVER crashes and always returns structured responses
 */

// ============================================================================
// Error Codes (MCP-compliant)
// ============================================================================

export const ErrorCode = {
  // Retryable errors
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  
  // Non-retryable errors
  AUTH_ERROR: 'AUTH_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  
  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// ============================================================================
// Structured Error Types
// ============================================================================

export interface StructuredError {
  code: ErrorCodeType;
  message: string;
  retryable: boolean;
  statusCode?: number;
  cause?: string;
}

interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
  onRetry?: (attempt: number, error: StructuredError, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [408, 429, 500, 502, 503, 504, 510],
};

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify any error into a structured format
 * NEVER throws - always returns a valid StructuredError
 */
export function classifyError(error: unknown): StructuredError {
  // Handle null/undefined
  if (error == null) {
    return {
      code: ErrorCode.UNKNOWN_ERROR,
      message: 'An unknown error occurred',
      retryable: false,
    };
  }

  // Handle abort errors (timeout via AbortController)
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      code: ErrorCode.TIMEOUT,
      message: 'Request timed out',
      retryable: true,
    };
  }

  // Extract error properties safely
  const err = error as {
    message?: string;
    response?: { status?: number; data?: unknown };
    status?: number;
    code?: string;
    name?: string;
    cause?: unknown;
  };

  const message = err.message || String(error);
  const statusCode = err.response?.status || err.status;
  const errCode = err.code;
  const errName = err.name;

  // Network errors (Node.js specific)
  if (errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND' || errCode === 'ECONNRESET') {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: `Network error: ${errCode}`,
      retryable: true,
      cause: message,
    };
  }

  // Timeout errors
  if (
    errCode === 'ECONNABORTED' ||
    errCode === 'ETIMEDOUT' ||
    errName === 'AbortError' ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('timed out')
  ) {
    return {
      code: ErrorCode.TIMEOUT,
      message: 'Request timed out',
      retryable: true,
      cause: message,
    };
  }

  // HTTP status code errors
  if (statusCode) {
    return classifyHttpError(statusCode, message);
  }

  // API key errors
  if (message.includes('API_KEY') || message.includes('api_key') || message.includes('Invalid API')) {
    return {
      code: ErrorCode.AUTH_ERROR,
      message: 'API key missing or invalid',
      retryable: false,
      cause: message,
    };
  }

  // Parse errors
  if (message.includes('JSON') || message.includes('parse') || message.includes('Unexpected token')) {
    return {
      code: ErrorCode.PARSE_ERROR,
      message: 'Failed to parse response',
      retryable: false,
      cause: message,
    };
  }

  // Default to unknown
  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: message.substring(0, 500), // Truncate long messages
    retryable: false,
    cause: err.cause ? String(err.cause) : undefined,
  };
}

/**
 * Classify HTTP status codes into structured errors
 */
function classifyHttpError(status: number, message: string): StructuredError {
  switch (status) {
    case 400:
      return { code: ErrorCode.INVALID_INPUT, message: 'Bad request', retryable: false, statusCode: status };
    case 401:
      return { code: ErrorCode.AUTH_ERROR, message: 'Invalid API key', retryable: false, statusCode: status };
    case 403:
      return { code: ErrorCode.QUOTA_EXCEEDED, message: 'Access forbidden or quota exceeded', retryable: false, statusCode: status };
    case 404:
      return { code: ErrorCode.NOT_FOUND, message: 'Resource not found', retryable: false, statusCode: status };
    case 408:
      return { code: ErrorCode.TIMEOUT, message: 'Request timeout', retryable: true, statusCode: status };
    case 429:
      return { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded', retryable: true, statusCode: status };
    case 500:
      return { code: ErrorCode.INTERNAL_ERROR, message: 'Server error', retryable: true, statusCode: status };
    case 502:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Bad gateway', retryable: true, statusCode: status };
    case 503:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Service unavailable', retryable: true, statusCode: status };
    case 504:
      return { code: ErrorCode.TIMEOUT, message: 'Gateway timeout', retryable: true, statusCode: status };
    case 510:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Request canceled', retryable: true, statusCode: status };
    default:
      if (status >= 500) {
        return { code: ErrorCode.SERVICE_UNAVAILABLE, message: `Server error: ${status}`, retryable: true, statusCode: status };
      }
      return { code: ErrorCode.UNKNOWN_ERROR, message: `HTTP ${status}: ${message}`, retryable: false, statusCode: status };
  }
}

// ============================================================================
// Retry Logic with Exponential Backoff
// ============================================================================

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, options.maxDelayMs);
}

/**
 * Sleep utility that respects abort signals
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    function onAbort() {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    }

    const timeout = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
    // Re-check: signal may have aborted between initial check and listener registration
    if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * Execute a function with retry logic
 * NEVER throws on final failure - returns error result instead
 * @internal - Currently unused but kept for future retry implementations
 */
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<{ success: true; data: T } | { success: false; error: StructuredError; attempts: number }> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: StructuredError = { code: ErrorCode.UNKNOWN_ERROR, message: 'No attempts made', retryable: false };

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController();

    try {
      const data = await fn(controller.signal);
      return { success: true, data };
    } catch (error) {
      lastError = classifyError(error);

      // Don't retry non-retryable errors
      if (!lastError.retryable) {
        return { success: false, error: lastError, attempts: attempt + 1 };
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= opts.maxRetries) {
        return { success: false, error: lastError, attempts: attempt + 1 };
      }

      // Calculate backoff and wait
      const delayMs = calculateBackoff(attempt, opts);
      opts.onRetry?.(attempt + 1, lastError, delayMs);

      try {
        await sleep(delayMs);
      } catch {
        // Sleep was aborted, return immediately
        return { success: false, error: lastError, attempts: attempt + 1 };
      }
    }
  }

  return { success: false, error: lastError, attempts: opts.maxRetries + 1 };
}

/**
 * Wrap a fetch call with timeout via AbortController
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, signal: externalSignal, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal.aborted) {
      controller.abort();
    }
  }

  return fetch(url, { ...fetchOptions, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  });
}

// ============================================================================
// Safe Execution Wrappers
// ============================================================================

/**
 * Safely execute any function, NEVER throws
 * @internal - Currently unused but kept for future safe execution patterns
 */
async function safeExecute<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<{ data: T; error?: StructuredError }> {
  try {
    const data = await fn();
    return { data };
  } catch (error) {
    return { data: fallback, error: classifyError(error) };
  }
}

/**
 * Safely parse JSON, NEVER throws
 * @internal - Currently unused but kept for future JSON parsing needs
 */
function safeJsonParse<T>(text: string, fallback: T): { data: T; error?: string } {
  try {
    return { data: JSON.parse(text) as T };
  } catch (error) {
    return { data: fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// MCP Tool Error Response Types (for client-facing error responses)
// ============================================================================

/**
 * MCP-compliant error codes for tool responses
 * These codes are exposed to clients for programmatic error handling
 */
export const MCP_ERROR_CODES = {
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type McpErrorCodeType = typeof MCP_ERROR_CODES[keyof typeof MCP_ERROR_CODES];

/**
 * Structured response type for MCP tool errors
 * Per MCP spec: tools return isError:true for recoverable/tool-level failures
 * Uses index signature for SDK compatibility with additional fields
 */
interface ToolErrorResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  errorCode?: McpErrorCodeType;
  retryAfter?: number; // Seconds to wait before retry (for rate limits)
  [key: string]: unknown; // Allow additional fields for SDK compatibility
}

/**
 * Map internal ErrorCode to client-facing MCP_ERROR_CODES
 */
function mapErrorCodeToMCP(code: ErrorCodeType): McpErrorCodeType {
  switch (code) {
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.QUOTA_EXCEEDED:
      return MCP_ERROR_CODES.RATE_LIMITED;
    case ErrorCode.TIMEOUT:
      return MCP_ERROR_CODES.TIMEOUT;
    case ErrorCode.NETWORK_ERROR:
      return MCP_ERROR_CODES.NETWORK_ERROR;
    case ErrorCode.SERVICE_UNAVAILABLE:
      return MCP_ERROR_CODES.SERVICE_UNAVAILABLE;
    case ErrorCode.AUTH_ERROR:
      return MCP_ERROR_CODES.AUTH_ERROR;
    case ErrorCode.NOT_FOUND:
      return MCP_ERROR_CODES.NOT_FOUND;
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.PARSE_ERROR:
      return MCP_ERROR_CODES.VALIDATION_ERROR;
    case ErrorCode.INTERNAL_ERROR:
    case ErrorCode.UNKNOWN_ERROR:
    default:
      return MCP_ERROR_CODES.INTERNAL_ERROR;
  }
}

/**
 * Create a standardized MCP tool error response
 * @param message - Human-readable error message
 * @param errorCode - Optional MCP error code for programmatic handling
 * @param retryAfter - Optional seconds to wait before retry (for rate limits)
 */
function createToolError(
  message: string,
  errorCode?: McpErrorCodeType,
  retryAfter?: number
): ToolErrorResponse {
  const response: ToolErrorResponse = {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
  
  if (errorCode) {
    response.errorCode = errorCode;
  }
  
  if (retryAfter !== undefined && retryAfter > 0) {
    response.retryAfter = retryAfter;
  }
  
  return response;
}

/**
 * Create a tool error response from a StructuredError
 * Automatically maps error codes and calculates retryAfter for rate limits
 */
export function createToolErrorFromStructured(
  structuredError: StructuredError,
  attempt: number = 0
): ToolErrorResponse {
  const errorCode = mapErrorCodeToMCP(structuredError.code);
  
  // Calculate retryAfter for rate-limited errors
  let retryAfter: number | undefined;
  if (structuredError.retryable && errorCode === MCP_ERROR_CODES.RATE_LIMITED) {
    retryAfter = Math.ceil(calculateBackoff(attempt, DEFAULT_RETRY_OPTIONS) / 1000);
  }
  
  // Format user-friendly error message
  const retryHint = structuredError.retryable 
    ? '\n\n💡 This error may be temporary. Try again in a moment.' 
    : '';
  const errorText = `## ❌ Error\n\n**${structuredError.code}:** ${structuredError.message}${retryHint}\n\nPlease check your input parameters and try again.`;
  
  return createToolError(errorText, errorCode, retryAfter);
}
