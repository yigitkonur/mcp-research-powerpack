/**
 * Web Search Client
 * Generic interface for web search via Google (Serper implementation)
 * Implements robust error handling that NEVER crashes
 */

import { parseEnv } from '../config/index.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  date?: string;
  position: number;
}

export interface KeywordSearchResult {
  keyword: string;
  results: SearchResult[];
  totalResults: number;
  related: string[];
  error?: StructuredError;
}

interface MultipleSearchResponse {
  searches: KeywordSearchResult[];
  totalKeywords: number;
  executionTime: number;
  error?: StructuredError;
}

export interface RedditSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

// Search retry configuration
const SEARCH_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
} as const;

const RETRYABLE_SEARCH_CODES = new Set([429, 500, 502, 503, 504]);

// Pre-compiled regex patterns for Reddit search
const REDDIT_SITE_REGEX = /site:\s*reddit\.com/i;
const REDDIT_SUBREDDIT_SUFFIX_REGEX = / : r\/\w+$/;
const REDDIT_SUFFIX_REGEX = / - Reddit$/;

export class SearchClient {
  private apiKey: string;
  private baseURL = 'https://google.serper.dev';

  constructor(apiKey?: string) {
    const env = parseEnv();
    this.apiKey = apiKey || env.SEARCH_API_KEY || '';

    if (!this.apiKey) {
      throw new Error('SERPER_API_KEY is required for search functionality');
    }
  }

  /**
   * Calculate backoff delay
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = SEARCH_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, SEARCH_RETRY_CONFIG.maxDelayMs);
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(status?: number, error?: unknown): boolean {
    if (status && RETRYABLE_SEARCH_CODES.has(status)) return true;
    
    const message = (error as { message?: string })?.message?.toLowerCase() || '';
    return message.includes('timeout') || message.includes('rate limit') || message.includes('connection');
  }

  /**
   * Search multiple keywords in parallel
   * NEVER throws - always returns a valid response
   */
  async searchMultiple(keywords: string[]): Promise<MultipleSearchResponse> {
    const startTime = Date.now();

    if (keywords.length === 0) {
      return {
        searches: [],
        totalKeywords: 0,
        executionTime: 0,
        error: { code: ErrorCode.INVALID_INPUT, message: 'No keywords provided', retryable: false },
      };
    }

    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt <= SEARCH_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.error(`[Search] Retry attempt ${attempt}/${SEARCH_RETRY_CONFIG.maxRetries}`);
        }

        const searchQueries = keywords.map(keyword => ({ q: keyword }));

        const response = await fetchWithTimeout(`${this.baseURL}/search`, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(searchQueries),
          timeoutMs: SEARCH_RETRY_CONFIG.timeoutMs,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          lastError = classifyError({ status: response.status, message: errorText });

          if (this.isRetryable(response.status) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
            const delayMs = this.calculateBackoff(attempt);
            console.error(`[Search] API returned ${response.status}, retrying in ${delayMs}ms...`);
            await sleep(delayMs);
            continue;
          }

          // Return partial result with error
          return {
            searches: [],
            totalKeywords: keywords.length,
            executionTime: Date.now() - startTime,
            error: lastError,
          };
        }

        // Parse response safely
        let data: unknown;
        try {
          data = await response.json();
        } catch (parseError) {
          return {
            searches: [],
            totalKeywords: keywords.length,
            executionTime: Date.now() - startTime,
            error: { code: ErrorCode.PARSE_ERROR, message: 'Failed to parse search response', retryable: false },
          };
        }

        const responses = Array.isArray(data) ? data : [data];

        const searches: KeywordSearchResult[] = responses.map((resp: Record<string, unknown>, index: number) => {
          try {
            const organic = (resp.organic || []) as Array<Record<string, unknown>>;
            const results: SearchResult[] = organic.map((item: Record<string, unknown>, idx: number) => ({
              title: (item.title as string) || 'No title',
              link: (item.link as string) || '#',
              snippet: (item.snippet as string) || '',
              date: item.date as string | undefined,
              position: (item.position as number) || idx + 1,
            }));

            const searchInfo = resp.searchInformation as Record<string, unknown> | undefined;
            const totalResults = searchInfo?.totalResults
              ? parseInt(String(searchInfo.totalResults).replace(/,/g, ''), 10)
              : results.length;

            const relatedSearches = (resp.relatedSearches || []) as Array<Record<string, unknown>>;
            const related = relatedSearches.map((r: Record<string, unknown>) => (r.query as string) || '');

            return { keyword: keywords[index] || '', results, totalResults, related };
          } catch {
            // Return empty result for this keyword on parse error
            return { keyword: keywords[index] || '', results: [], totalResults: 0, related: [] };
          }
        });

        return { searches, totalKeywords: keywords.length, executionTime: Date.now() - startTime };

      } catch (error) {
        lastError = classifyError(error);

        if (this.isRetryable(undefined, error) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
          const delayMs = this.calculateBackoff(attempt);
          console.error(`[Search] ${lastError.code}: ${lastError.message}, retrying in ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }

        break;
      }
    }

    // All retries failed
    return {
      searches: [],
      totalKeywords: keywords.length,
      executionTime: Date.now() - startTime,
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'Search failed', retryable: false },
    };
  }

  /**
   * Search Reddit via Google (adds site:reddit.com automatically)
   * NEVER throws - returns empty array on failure
   */
  async searchReddit(query: string, dateAfter?: string): Promise<RedditSearchResult[]> {
    if (!query?.trim()) {
      return [];
    }

    let q = REDDIT_SITE_REGEX.test(query) ? query : `${query} site:reddit.com`;

    if (dateAfter) {
      q += ` after:${dateAfter}`;
    }

    for (let attempt = 0; attempt <= SEARCH_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(`${this.baseURL}/search`, {
          method: 'POST',
          headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, num: 10 }),
          timeoutMs: SEARCH_RETRY_CONFIG.timeoutMs,
        });

        if (!res.ok) {
          if (this.isRetryable(res.status) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
            const delayMs = this.calculateBackoff(attempt);
            console.error(`[Search Reddit] ${res.status}, retrying in ${delayMs}ms...`);
            await sleep(delayMs);
            continue;
          }
          console.error(`[Search Reddit] Failed with status ${res.status}`);
          return [];
        }

        const data = await res.json() as { organic?: Array<{ title: string; link: string; snippet: string; date?: string }> };
        return (data.organic || []).map((r) => ({
          title: (r.title || '').replace(REDDIT_SUBREDDIT_SUFFIX_REGEX, '').replace(REDDIT_SUFFIX_REGEX, ''),
          url: r.link || '',
          snippet: r.snippet || '',
          date: r.date,
        }));

      } catch (error) {
        const err = classifyError(error);
        if (this.isRetryable(undefined, error) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
          const delayMs = this.calculateBackoff(attempt);
          console.error(`[Search Reddit] ${err.code}, retrying in ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }
        console.error(`[Search Reddit] Failed: ${err.message}`);
        return [];
      }
    }

    return [];
  }

  /**
   * Search Reddit with multiple queries (bounded concurrency)
   * NEVER throws - searchReddit never throws, pMap preserves order
   */
  async searchRedditMultiple(queries: string[], dateAfter?: string): Promise<Map<string, RedditSearchResult[]>> {
    if (queries.length === 0) {
      return new Map();
    }

    // Limit to 8 concurrent Serper API calls to prevent CPU spikes & rate limits
    const results = await pMap(
      queries,
      q => this.searchReddit(q, dateAfter),
      8
    );

    return new Map(queries.map((q, i) => [q, results[i] || []]));
  }
}
