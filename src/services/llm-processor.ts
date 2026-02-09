/**
 * LLM Processor for content extraction
 * Uses OpenRouter via OPENROUTER_API_KEY for AI-powered content filtering
 * Implements robust retry logic and NEVER throws
 */

import OpenAI from 'openai';
import { RESEARCH, LLM_EXTRACTION, getCapabilities } from '../config/index.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';

interface ProcessingConfig {
  use_llm: boolean;
  what_to_extract: string | undefined;
  max_tokens?: number;
}

interface LLMResult {
  content: string;
  processed: boolean;
  error?: string;
  errorDetails?: StructuredError;
}

// LLM-specific retry configuration
const LLM_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
} as const;

// OpenRouter/OpenAI specific retryable error codes (using Set for type-safe lookup)
const RETRYABLE_LLM_ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'timeout',
  'service_unavailable',
]);

let llmClient: OpenAI | null = null;

export function createLLMProcessor(): OpenAI | null {
  if (!getCapabilities().llmExtraction) return null;
  
  if (!llmClient) {
    llmClient = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: 120000,
      maxRetries: 0, // We handle retries ourselves for more control
    });
  }
  return llmClient;
}

/**
 * Check if an LLM error is retryable
 */
function isRetryableLLMError(error: unknown): boolean {
  if (!error) return false;

  const err = error as {
    status?: number;
    code?: string;
    error?: { type?: string; code?: string };
    message?: string;
  };

  // Check HTTP status codes
  const status = err.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // Check error codes from OpenAI/OpenRouter
  const errorCode = err.code || err.error?.code || err.error?.type;
  if (errorCode && RETRYABLE_LLM_ERROR_CODES.has(errorCode)) {
    return true;
  }

  // Check message for common patterns
  const message = (err.message || '').toLowerCase();
  if (
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('service unavailable') ||
    message.includes('server error') ||
    message.includes('connection') ||
    message.includes('econnreset')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate backoff delay with jitter for LLM retries
 */
function calculateLLMBackoff(attempt: number): number {
  const exponentialDelay = LLM_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, LLM_RETRY_CONFIG.maxDelayMs);
}

/**
 * Process content with LLM extraction
 * NEVER throws - always returns a valid LLMResult
 * Implements retry logic with exponential backoff for transient failures
 */
export async function processContentWithLLM(
  content: string,
  config: ProcessingConfig,
  processor?: OpenAI | null,
  signal?: AbortSignal
): Promise<LLMResult> {
  // Early returns for invalid/skip conditions
  if (!config.use_llm) {
    return { content, processed: false };
  }

  if (!processor) {
    return {
      content,
      processed: false,
      error: 'LLM processor not available (OPENROUTER_API_KEY not set)',
      errorDetails: {
        code: ErrorCode.AUTH_ERROR,
        message: 'LLM processor not available',
        retryable: false,
      },
    };
  }

  if (!content?.trim()) {
    return { content: content || '', processed: false, error: 'Empty content provided' };
  }

  // Truncate extremely long content to avoid token limits
  const maxInputChars = 100000; // ~25k tokens
  const truncatedContent = content.length > maxInputChars
    ? content.substring(0, maxInputChars) + '\n\n[Content truncated due to length]'
    : content;

  const prompt = config.what_to_extract
    ? `Extract and clean the following content. Focus on: ${config.what_to_extract}\n\nContent:\n${truncatedContent}`
    : `Clean and extract the main content from the following text, removing navigation, ads, and irrelevant elements:\n\n${truncatedContent}`;

  // Build request body
  const requestBody: Record<string, unknown> = {
    model: LLM_EXTRACTION.MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: config.max_tokens || LLM_EXTRACTION.MAX_TOKENS,
  };

  if (LLM_EXTRACTION.ENABLE_REASONING) {
    requestBody.reasoning = { enabled: true };
  }

  let lastError: StructuredError | undefined;

  // Retry loop
  for (let attempt = 0; attempt <= LLM_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      if (attempt === 0) {
        mcpLog('info', `Starting extraction with ${LLM_EXTRACTION.MODEL}`, 'llm');
      } else {
        mcpLog('warning', `Retry attempt ${attempt}/${LLM_RETRY_CONFIG.maxRetries}`, 'llm');
      }

      const response = await processor.chat.completions.create(requestBody as any, { signal });

      const result = response.choices?.[0]?.message?.content;
      if (result && result.trim()) {
        mcpLog('info', `Successfully extracted ${result.length} characters`, 'llm');
        return { content: result, processed: true };
      }

      // Empty response - not retryable
      mcpLog('warning', 'Received empty response from LLM', 'llm');
      return {
        content,
        processed: false,
        error: 'LLM returned empty response',
        errorDetails: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'LLM returned empty response',
          retryable: false,
        },
      };

    } catch (err) {
      lastError = classifyError(err);

      // Log the error
      const errDetails = err as { status?: number; code?: string };
      mcpLog('error', `Error (attempt ${attempt + 1}): ${lastError.message} [status=${errDetails.status}, code=${errDetails.code}, retryable=${isRetryableLLMError(err)}]`, 'llm');

      // Check if we should retry
      if (isRetryableLLMError(err) && attempt < LLM_RETRY_CONFIG.maxRetries) {
        const delayMs = calculateLLMBackoff(attempt);
        mcpLog('warning', `Retrying in ${delayMs}ms...`, 'llm');
        try { await sleep(delayMs, signal); } catch { break; }
        continue;
      }

      // Non-retryable or max retries reached
      break;
    }
  }

  // All attempts failed - return original content with error info
  const errorMessage = lastError?.message || 'Unknown LLM error';
  mcpLog('error', `All attempts failed: ${errorMessage}. Returning original content.`, 'llm');

  return {
    content, // Return original content as fallback
    processed: false,
    error: `LLM extraction failed: ${errorMessage}`,
    errorDetails: lastError || {
      code: ErrorCode.UNKNOWN_ERROR,
      message: errorMessage,
      retryable: false,
    },
  };
}

