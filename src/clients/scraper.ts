/**
 * Web Scraper Client
 * Generic interface for URL scraping with automatic fallback modes
 * Implements robust error handling that NEVER crashes
 */

import { parseEnv, SCRAPER } from '../config/index.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { pMapSettled } from '../utils/concurrency.js';

interface ScrapeRequest {
  url: string;
  mode?: 'basic' | 'javascript';
  timeout?: number;
  country?: string;
}

interface ScrapeResponse {
  content: string;
  statusCode: number;
  credits: number;
  headers?: Record<string, string>;
  error?: StructuredError;
}

interface BatchScrapeResult {
  results: Array<ScrapeResponse & { url: string }>;
  batchesProcessed: number;
  totalAttempted: number;
  rateLimitHits: number;
}

// Status codes that indicate we should retry (no credit consumed)
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 510]);
// Status codes that are permanent failures (don't retry)
const PERMANENT_FAILURE_CODES = new Set([400, 401, 403]);

export class ScraperClient {
  private apiKey: string;
  private baseURL = 'https://api.scrape.do';

  constructor(apiKey?: string) {
    const env = parseEnv();
    this.apiKey = apiKey || env.SCRAPER_API_KEY;

    if (!this.apiKey) {
      throw new Error('SCRAPEDO_API_KEY is required');
    }
  }

  /**
   * Scrape a single URL with retry logic
   * NEVER throws - always returns a ScrapeResponse (possibly with error)
   */
  async scrape(request: ScrapeRequest, maxRetries = SCRAPER.RETRY_COUNT): Promise<ScrapeResponse> {
    const { url, mode = 'basic', timeout = 30, country } = request;
    const credits = mode === 'javascript' ? 5 : 1;

    // Validate URL first
    try {
      new URL(url);
    } catch {
      return {
        content: `Invalid URL: ${url}`,
        statusCode: 400,
        credits: 0,
        error: { code: ErrorCode.INVALID_INPUT, message: `Invalid URL: ${url}`, retryable: false },
      };
    }

    const params = new URLSearchParams({
      url: url,
      token: this.apiKey,
      timeout: String(timeout * 1000),
    });

    if (mode === 'javascript') {
      params.append('render', 'true');
    }

    if (country) {
      params.append('geoCode', country.toUpperCase());
    }

    const apiUrl = `${this.baseURL}?${params.toString()}`;
    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Use AbortController for timeout
        const timeoutMs = (timeout + 10) * 1000; // Add 10s buffer over scrape timeout
        const response = await fetchWithTimeout(apiUrl, {
          method: 'GET',
          headers: { Accept: 'text/html,application/json' },
          timeoutMs,
        });

        // Safely read response body
        let content: string;
        try {
          content = await response.text();
        } catch (readError) {
          content = `Failed to read response: ${readError instanceof Error ? readError.message : String(readError)}`;
        }

        // SUCCESS: 2xx - Successful API call
        if (response.ok) {
          return {
            content,
            statusCode: response.status,
            credits,
            headers: Object.fromEntries(response.headers.entries()),
          };
        }

        // 404 - Target not found (permanent, but not an error for our purposes)
        if (response.status === 404) {
          return {
            content: '404 - Page not found',
            statusCode: 404,
            credits,
          };
        }

        // Permanent failures - don't retry
        if (PERMANENT_FAILURE_CODES.has(response.status)) {
          const errorMsg = response.status === 401
            ? 'No credits remaining or subscription suspended'
            : `Request failed with status ${response.status}`;
          return {
            content: `Error: ${errorMsg}`,
            statusCode: response.status,
            credits: 0,
            error: {
              code: response.status === 401 ? ErrorCode.AUTH_ERROR : ErrorCode.INVALID_INPUT,
              message: errorMsg,
              retryable: false,
              statusCode: response.status,
            },
          };
        }

        // Retryable status codes
        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          lastError = {
            code: response.status === 429 ? ErrorCode.RATE_LIMITED : ErrorCode.SERVICE_UNAVAILABLE,
            message: `Server returned ${response.status}`,
            retryable: true,
            statusCode: response.status,
          };

          if (attempt < maxRetries - 1) {
            const delayMs = this.calculateBackoff(attempt);
            console.error(`[Scraper] ${response.status} on attempt ${attempt + 1}/${maxRetries}. Retrying in ${delayMs}ms`);
            await sleep(delayMs);
            continue;
          }
        }

        // Other non-success status - treat as retryable
        lastError = classifyError({ status: response.status, message: content });
        if (attempt < maxRetries - 1 && lastError.retryable) {
          const delayMs = this.calculateBackoff(attempt);
          console.error(`[Scraper] Status ${response.status}. Retrying in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }

        // Final attempt failed
        return {
          content: `Error: ${lastError.message}`,
          statusCode: response.status,
          credits: 0,
          error: lastError,
        };

      } catch (error) {
        lastError = classifyError(error);

        // Non-retryable errors - return immediately
        if (!lastError.retryable) {
          return {
            content: `Error: ${lastError.message}`,
            statusCode: lastError.statusCode || 500,
            credits: 0,
            error: lastError,
          };
        }

        // Retryable error - continue if attempts remaining
        if (attempt < maxRetries - 1) {
          const delayMs = this.calculateBackoff(attempt);
          console.error(`[Scraper] ${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
      }
    }

    // All retries exhausted
    return {
      content: `Error: Failed after ${maxRetries} attempts. ${lastError?.message || 'Unknown error'}`,
      statusCode: lastError?.statusCode || 500,
      credits: 0,
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'All retries exhausted', retryable: false },
    };
  }

  /**
   * Calculate exponential backoff with jitter
   */
  private calculateBackoff(attempt: number): number {
    const baseDelay = SCRAPER.RETRY_DELAYS[attempt] || 8000;
    const jitter = Math.random() * 0.3 * baseDelay;
    return Math.floor(baseDelay + jitter);
  }

  /**
   * Scrape with automatic fallback through different modes
   * NEVER throws - always returns a ScrapeResponse
   */
  async scrapeWithFallback(url: string, options: { timeout?: number } = {}): Promise<ScrapeResponse> {
    const attempts: Array<{ mode: 'basic' | 'javascript'; country?: string; description: string }> = [
      { mode: 'basic', description: 'basic mode' },
      { mode: 'javascript', description: 'javascript rendering' },
      { mode: 'javascript', country: 'us', description: 'javascript + US geo-targeting' },
    ];

    const attemptResults: string[] = [];
    let lastResult: ScrapeResponse | null = null;

    for (const attempt of attempts) {
      // scrape() never throws, so no try-catch needed
      const result = await this.scrape({
        url,
        mode: attempt.mode,
        timeout: options.timeout,
        country: attempt.country,
      });

      lastResult = result;

      // Success
      if (result.statusCode >= 200 && result.statusCode < 300 && !result.error) {
        if (attemptResults.length > 0) {
          console.error(`[Scraper] Success with ${attempt.description} after ${attemptResults.length} fallback(s)`);
        }
        return result;
      }

      // 404 is a valid response, not an error
      if (result.statusCode === 404) {
        return result;
      }

      // Non-retryable errors - don't try other modes
      if (result.error && !result.error.retryable) {
        console.error(`[Scraper] Non-retryable error with ${attempt.description}: ${result.error.message}`);
        return result;
      }

      // Collect failure reason and try next mode
      attemptResults.push(`${attempt.description}: ${result.error?.message || result.statusCode}`);
      console.error(`[Scraper] Failed with ${attempt.description} (${result.statusCode}), trying next fallback...`);
    }

    // All fallbacks exhausted - return last result with aggregated error info
    const errorMessage = `Failed after ${attempts.length} fallback modes: ${attemptResults.join('; ')}`;
    return {
      content: `Error: ${errorMessage}`,
      statusCode: lastResult?.statusCode || 500,
      credits: 0,
      error: {
        code: ErrorCode.SERVICE_UNAVAILABLE,
        message: errorMessage,
        retryable: false,
      },
    };
  }

  /**
   * Scrape multiple URLs with batching
   * NEVER throws - always returns results array
   */
  async scrapeMultiple(urls: string[], options: { timeout?: number } = {}): Promise<Array<ScrapeResponse & { url: string }>> {
    if (urls.length === 0) {
      return [];
    }

    if (urls.length <= SCRAPER.BATCH_SIZE) {
      return this.processBatch(urls, options);
    }

    const result = await this.batchScrape(urls, options);
    return result.results;
  }

  /**
   * Batch scrape with progress callback
   * NEVER throws - uses Promise.allSettled internally
   */
  async batchScrape(
    urls: string[],
    options: { timeout?: number } = {},
    onBatchComplete?: (batchNum: number, totalBatches: number, processed: number) => void
  ): Promise<BatchScrapeResult> {
    const totalBatches = Math.ceil(urls.length / SCRAPER.BATCH_SIZE);
    const allResults: Array<ScrapeResponse & { url: string }> = [];
    let rateLimitHits = 0;

    console.error(`[Scraper] Starting batch processing: ${urls.length} URLs in ${totalBatches} batch(es)`);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const startIdx = batchNum * SCRAPER.BATCH_SIZE;
      const endIdx = Math.min(startIdx + SCRAPER.BATCH_SIZE, urls.length);
      const batchUrls = urls.slice(startIdx, endIdx);

      console.error(`[Scraper] Processing batch ${batchNum + 1}/${totalBatches} (${batchUrls.length} URLs)`);

      // Limit to 10 concurrent scrapes within each batch to prevent connection exhaustion
      const batchResults = await pMapSettled(
        batchUrls,
        url => this.scrapeWithFallback(url, options),
        10
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const url = batchUrls[i] || '';

        if (result.status === 'fulfilled') {
          const scrapeResult = result.value;
          allResults.push({ ...scrapeResult, url });

          // Track rate limits
          if (scrapeResult.error?.code === ErrorCode.RATE_LIMITED) {
            rateLimitHits++;
          }
        } else {
          // This shouldn't happen since scrapeWithFallback never throws,
          // but handle it gracefully just in case
          const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.error(`[Scraper] Unexpected rejection for ${url}: ${errorMsg}`);

          allResults.push({
            url,
            content: `Error: Unexpected failure - ${errorMsg}`,
            statusCode: 500,
            credits: 0,
            error: classifyError(result.reason),
          });
        }
      }

      // Safe callback invocation
      try {
        onBatchComplete?.(batchNum + 1, totalBatches, allResults.length);
      } catch (callbackError) {
        console.error(`[Scraper] onBatchComplete callback error:`, callbackError);
      }

      console.error(`[Scraper] Completed batch ${batchNum + 1}/${totalBatches} (${allResults.length}/${urls.length} total)`);

      // Small delay between batches to avoid overwhelming the API
      if (batchNum < totalBatches - 1) {
        await sleep(500);
      }
    }

    return { results: allResults, batchesProcessed: totalBatches, totalAttempted: urls.length, rateLimitHits };
  }

  /**
   * Process a single batch of URLs
   * NEVER throws
   */
  private async processBatch(urls: string[], options: { timeout?: number }): Promise<Array<ScrapeResponse & { url: string }>> {
    // Limit to 10 concurrent scrapes to prevent connection exhaustion
    const results = await pMapSettled(urls, url => this.scrapeWithFallback(url, options), 10);

    return results.map((result, index) => {
      const url = urls[index] || '';

      if (result.status === 'fulfilled') {
        return { ...result.value, url };
      }

      // Shouldn't happen, but handle gracefully
      return {
        url,
        content: `Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        statusCode: 500,
        credits: 0,
        error: classifyError(result.reason),
      };
    });
  }
}
