/**
 * Deep Research Client
 * Handles research API requests with web search capabilities
 * Implements robust retry logic and NEVER crashes the server
 */

import OpenAI from 'openai';
import { RESEARCH } from '../config/index.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';

interface ResearchParams {
  question: string;
  systemPrompt?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxSearchResults?: number;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

export interface ResearchResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    sourcesUsed?: number;
  };
  annotations?: Array<{
    type: 'url_citation';
    url: string;
    title: string;
    startIndex: number;
    endIndex: number;
  }>;
  error?: StructuredError;
}

// Research-specific retry configuration
// Research requests can be long-running, so we use longer delays
const RESEARCH_RETRY_CONFIG = {
  maxRetries: 3, // 3 retries for robustness on transient failures
  baseDelayMs: 5000, // Longer base delay
  maxDelayMs: 60000,
} as const;

// Retryable status codes for research API
const RETRYABLE_RESEARCH_CODES = new Set([429, 500, 502, 503, 504]);

// Models that use Gemini-style google_search tool instead of search_parameters
const GEMINI_STYLE_MODELS = new Set([
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash',
  'google/gemini-pro',
]);

/**
 * Check if a model uses Gemini-style google_search tool
 */
function isGeminiStyleModel(model: string): boolean {
  return GEMINI_STYLE_MODELS.has(model) || model.startsWith('google/gemini');
}

export class ResearchClient {
  private client: OpenAI;

  constructor() {
    if (!RESEARCH.API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required for research');
    }

    this.client = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: RESEARCH.TIMEOUT_MS,
      maxRetries: 0, // We handle retries ourselves
    });
  }

  /**
   * Check if an error is retryable for research requests
   */
  private isRetryableError(error: unknown): boolean {
    if (!error) return false;

    const err = error as {
      status?: number;
      code?: string;
      message?: string;
    };

    // Check HTTP status codes
    if (err.status && RETRYABLE_RESEARCH_CODES.has(err.status)) {
      return true;
    }

    // Check message patterns
    const message = (err.message || '').toLowerCase();
    if (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('service unavailable') ||
      message.includes('connection')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Calculate backoff for research retries
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = RESEARCH_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, RESEARCH_RETRY_CONFIG.maxDelayMs);
  }

  /**
   * Build request payload based on model type
   * Gemini models use tools with google_search, others use search_parameters
   */
  private buildRequestPayload(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: {
      temperature: number;
      reasoningEffort: 'low' | 'medium' | 'high';
      maxTokens: number;
      maxSearchResults: number;
      responseFormat?: { type: 'json_object' | 'text' };
    }
  ): Record<string, unknown> {
    const { temperature, reasoningEffort, maxTokens, maxSearchResults, responseFormat } = options;

    if (isGeminiStyleModel(model)) {
      // Gemini uses tools with google_search
      const payload: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        tools: [
          {
            type: 'google_search',
            googleSearch: {},
          },
        ],
      };
      if (responseFormat) {
        payload.response_format = responseFormat;
      }
      return payload;
    }

    // Default: use search_parameters (for Grok, Perplexity, etc.)
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature,
      reasoning_effort: reasoningEffort,
      max_completion_tokens: maxTokens,
      search_parameters: {
        mode: 'on',
        max_search_results: Math.min(maxSearchResults, 30),
        return_citations: true,
        sources: [{ type: 'web' }],
      },
    };
    if (responseFormat) {
      payload.response_format = responseFormat;
    }
    return payload;
  }

  /**
   * Execute a single research request with a specific model
   */
  private async executeResearch(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: {
      temperature: number;
      reasoningEffort: 'low' | 'medium' | 'high';
      maxTokens: number;
      maxSearchResults: number;
      responseFormat?: { type: 'json_object' | 'text' };
    },
    signal?: AbortSignal
  ): Promise<ResearchResponse> {
    const requestPayload = this.buildRequestPayload(model, messages, options);
    let lastError: StructuredError | undefined;

    // Retry loop for this model
    for (let attempt = 0; attempt <= RESEARCH_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          mcpLog('warning', `Retry attempt ${attempt}/${RESEARCH_RETRY_CONFIG.maxRetries} for ${model}`, 'research');
        }

        const response = await this.client.chat.completions.create(requestPayload as any, { signal });
        const choice = response.choices?.[0];
        const message = choice?.message as any;

        // Validate response
        if (!message?.content && !choice) {
          lastError = {
            code: ErrorCode.INTERNAL_ERROR,
            message: 'Research API returned empty response',
            retryable: true,
          };

          if (attempt < RESEARCH_RETRY_CONFIG.maxRetries) {
            const delayMs = this.calculateBackoff(attempt);
            mcpLog('warning', `Empty response, retrying in ${delayMs}ms...`, 'research');
            await sleep(delayMs, signal);
            continue;
          }
        }

        return {
          id: response.id || '',
          model: response.model || model,
          created: response.created || Date.now(),
          content: message?.content || '',
          finishReason: choice?.finish_reason,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
            sourcesUsed: (response.usage as any).num_sources_used,
          } : undefined,
          annotations: message?.annotations?.map((a: any) => ({
            type: 'url_citation' as const,
            url: a.url_citation?.url || '',
            title: a.url_citation?.title || '',
            startIndex: a.url_citation?.start_index || 0,
            endIndex: a.url_citation?.end_index || 0,
          })),
        };

      } catch (error: unknown) {
        lastError = classifyError(error);

        const err = error as { status?: number; message?: string };
        mcpLog('error', `Error with ${model} (attempt ${attempt + 1}): ${lastError.message} (status: ${err.status})`, 'research');

        // Check if we should retry
        if (this.isRetryableError(error) && attempt < RESEARCH_RETRY_CONFIG.maxRetries) {
          const delayMs = this.calculateBackoff(attempt);
          mcpLog('warning', `Retrying in ${delayMs}ms...`, 'research');
          try { await sleep(delayMs, signal); } catch { break; }
          continue;
        }

        // Non-retryable or max retries reached
        break;
      }
    }

    // Return error response
    return {
      id: '',
      model,
      created: Date.now(),
      content: '',
      error: lastError || {
        code: ErrorCode.UNKNOWN_ERROR,
        message: 'Unknown research error',
        retryable: false,
      },
    };
  }

  /**
   * Perform research with retry logic and fallback to secondary model
   * Returns a ResearchResponse - may contain error field on failure
   * NEVER throws - always returns a valid response object
   */
  async research(params: ResearchParams, signal?: AbortSignal): Promise<ResearchResponse> {
    const {
      question,
      systemPrompt,
      reasoningEffort = RESEARCH.REASONING_EFFORT,
      maxSearchResults = RESEARCH.MAX_URLS,
      maxTokens = 32000,
      temperature = 0.3,
      responseFormat,
    } = params;

    // Validate input
    if (!question?.trim()) {
      return {
        id: '',
        model: RESEARCH.MODEL,
        created: Date.now(),
        content: '',
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: 'Research question cannot be empty',
          retryable: false,
        },
      };
    }

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: question });

    const options = { temperature, reasoningEffort, maxTokens, maxSearchResults, responseFormat };

    // Try primary model first
    mcpLog('info', `Trying primary model: ${RESEARCH.MODEL}`, 'research');
    const primaryResult = await this.executeResearch(RESEARCH.MODEL, messages, options, signal);

    if (!primaryResult.error) {
      return primaryResult;
    }

    // Primary failed - try fallback model if different
    if (RESEARCH.FALLBACK_MODEL && RESEARCH.FALLBACK_MODEL !== RESEARCH.MODEL) {
      mcpLog('warning', `Primary model failed, trying fallback: ${RESEARCH.FALLBACK_MODEL}`, 'research');
      const fallbackResult = await this.executeResearch(RESEARCH.FALLBACK_MODEL, messages, options, signal);

      if (!fallbackResult.error) {
        return fallbackResult;
      }

      // Both failed - return the fallback error (more recent)
      mcpLog('error', `Both models failed. Primary: ${primaryResult.error?.message}, Fallback: ${fallbackResult.error?.message}`, 'research');
      return {
        ...fallbackResult,
        content: `Research failed with both models. Primary (${RESEARCH.MODEL}): ${primaryResult.error?.message}. Fallback (${RESEARCH.FALLBACK_MODEL}): ${fallbackResult.error?.message}`,
      };
    }

    // No fallback or same model - return primary error
    mcpLog('error', `All attempts failed: ${primaryResult.error?.message}`, 'research');
    return {
      ...primaryResult,
      content: `Research failed: ${primaryResult.error?.message}`,
    };
  }
}
