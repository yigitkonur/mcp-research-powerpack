/**
 * Reddit OAuth API Client
 * Fetches posts and comments sorted by score (most upvoted first)
 * Implements robust error handling that NEVER crashes
 */

import { REDDIT } from '../config/index.js';
import { USER_AGENT_VERSION } from '../version.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { pMap, pMapSettled } from '../utils/concurrency.js';

interface Post {
  title: string;
  author: string;
  subreddit: string;
  body: string;
  score: number;
  commentCount: number;
  url: string;
  created: Date;
  flair?: string;
  isNsfw: boolean;
  isPinned: boolean;
}

export interface Comment {
  author: string;
  body: string;
  score: number;
  depth: number;
  isOP: boolean;
}

export interface PostResult {
  post: Post;
  comments: Comment[];
  allocatedComments: number;
  actualComments: number;
}

interface BatchPostResult {
  results: Map<string, PostResult | Error>;
  batchesProcessed: number;
  totalPosts: number;
  rateLimitHits: number;
  commentAllocation: CommentAllocation;
}

interface CommentAllocation {
  totalBudget: number;
  perPostBase: number;
  perPostCapped: number;
  redistributed: boolean;
}

export function calculateCommentAllocation(postCount: number): CommentAllocation {
  const totalBudget = REDDIT.MAX_COMMENT_BUDGET;
  const perPostBase = Math.floor(totalBudget / postCount);
  const perPostCapped = Math.min(perPostBase, REDDIT.MAX_COMMENTS_PER_POST);
  return { totalBudget, perPostBase, perPostCapped, redistributed: false };
}

// ============================================================================
// Module-Level Token Cache (shared across all RedditClient instances)
// ============================================================================
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

// Token cache logging only when DEBUG env is set
const DEBUG_TOKEN_CACHE = process.env.DEBUG_REDDIT === 'true';

// Pending auth promise for deduplicating concurrent auth calls
let pendingAuthPromise: Promise<string | null> | null = null;

export class RedditClient {
  // Instance-level references (now point to module cache)
  // User agent uses centralized version from package.json - auto-synced!
  private userAgent = `script:${USER_AGENT_VERSION} (by /u/research-powerpack)`;

  constructor(private clientId: string, private clientSecret: string) {}

  /**
   * Authenticate with Reddit API with retry logic
   * Uses module-level token cache and promise deduplication to prevent
   * concurrent auth calls from firing multiple token requests
   * Returns null on failure instead of throwing
   */
  private async auth(): Promise<string | null> {
    // Return module-cached token if still valid (with 60s buffer)
    if (cachedToken && Date.now() < cachedTokenExpiry - 60000) {
      if (DEBUG_TOKEN_CACHE) console.error('[RedditClient] Token cache HIT');
      return cachedToken;
    }

    // Deduplicate concurrent auth calls - if one is already in flight, await it
    if (pendingAuthPromise) {
      if (DEBUG_TOKEN_CACHE) console.error('[RedditClient] Auth already in flight, awaiting...');
      return pendingAuthPromise;
    }

    pendingAuthPromise = this.performAuth();
    try {
      return await pendingAuthPromise;
    } finally {
      pendingAuthPromise = null;
    }
  }

  /**
   * Internal auth implementation - called only once per cache miss
   */
  private async performAuth(): Promise<string | null> {
    if (DEBUG_TOKEN_CACHE) console.error('[RedditClient] Token cache MISS - authenticating');

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': this.userAgent,
          },
          body: 'grant_type=client_credentials',
          timeoutMs: 15000,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[Reddit] Auth failed (${res.status}): ${text}`);

          // 401/403 are not retryable - invalidate cache
          if (res.status === 401 || res.status === 403) {
            cachedToken = null;
            cachedTokenExpiry = 0;
            return null;
          }

          // Retry on server errors
          if (res.status >= 500 && attempt < 2) {
            await sleep(REDDIT.RETRY_DELAYS[attempt] || 2000);
            continue;
          }

          return null;
        }

        const data = await res.json() as { access_token?: string; expires_in?: number };
        if (!data.access_token) {
          console.error('[Reddit] Auth response missing access_token');
          return null;
        }

        // Update module-level cache (shared across all instances)
        cachedToken = data.access_token;
        cachedTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
        return cachedToken;

      } catch (error) {
        const err = classifyError(error);
        console.error(`[Reddit] Auth error (attempt ${attempt + 1}): ${err.message}`);

        // Invalidate cache on auth errors
        if (err.code === ErrorCode.AUTH_ERROR) {
          cachedToken = null;
          cachedTokenExpiry = 0;
        }

        if (attempt < 2 && err.retryable) {
          await sleep(REDDIT.RETRY_DELAYS[attempt] || 2000);
          continue;
        }

        return null;
      }
    }

    return null;
  }

  private parseUrl(url: string): { sub: string; id: string } | null {
    const m = url.match(/reddit\.com\/r\/([^\/]+)\/comments\/([a-z0-9]+)/i);
    return m ? { sub: m[1], id: m[2] } : null;
  }

  /**
   * Get a single Reddit post with comments
   * Returns PostResult or throws Error (for use with Promise.allSettled)
   */
  async getPost(url: string, maxComments = 100): Promise<PostResult> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      throw new Error(`Invalid Reddit URL format: ${url}`);
    }

    // Auth - returns null on failure
    const token = await this.auth();
    if (!token) {
      throw new Error('Reddit authentication failed - check credentials');
    }

    const limit = Math.min(maxComments, 500);
    let lastError: StructuredError | null = null;

    for (let attempt = 0; attempt < REDDIT.RETRY_COUNT; attempt++) {
      try {
        const apiUrl = `https://oauth.reddit.com/r/${parsed.sub}/comments/${parsed.id}?sort=top&limit=${limit}&depth=10&raw_json=1`;

        const res = await fetchWithTimeout(apiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': this.userAgent,
          },
          timeoutMs: 30000,
        });

        // Rate limited - always retry with backoff
        if (res.status === 429) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 32000;
          console.error(`[Reddit] Rate limited. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT} after ${delay}ms`);
          await sleep(delay);
          continue;
        }

        // 404 - Post doesn't exist
        if (res.status === 404) {
          throw new Error(`Post not found: ${url}`);
        }

        // Other errors
        if (!res.ok) {
          lastError = classifyError({ status: res.status });

          if (lastError.retryable && attempt < REDDIT.RETRY_COUNT - 1) {
            const delay = REDDIT.RETRY_DELAYS[attempt] || 2000;
            console.error(`[Reddit] API error ${res.status}. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT}`);
            await sleep(delay);
            continue;
          }

          throw new Error(`Reddit API error: ${res.status}`);
        }

        // Parse response safely
        let data: [any, any];
        try {
          data = await res.json() as [any, any];
        } catch (parseError) {
          throw new Error('Failed to parse Reddit API response');
        }

        const [postListing, commentListing] = data;
        const p = postListing?.data?.children?.[0]?.data;

        if (!p) {
          throw new Error(`Post data not found in response: ${url}`);
        }

        const post: Post = {
          title: p.title || 'Untitled',
          author: p.author || '[deleted]',
          subreddit: p.subreddit || parsed.sub,
          body: this.formatBody(p),
          score: p.score || 0,
          commentCount: p.num_comments || 0,
          url: `https://reddit.com${p.permalink || ''}`,
          created: new Date((p.created_utc || 0) * 1000),
          flair: p.link_flair_text || undefined,
          isNsfw: p.over_18 || false,
          isPinned: p.stickied || false,
        };

        const comments = this.extractComments(commentListing?.data?.children || [], maxComments, post.author);

        return { post, comments, allocatedComments: maxComments, actualComments: post.commentCount };

      } catch (error) {
        lastError = classifyError(error);

        // Don't retry non-retryable errors
        if (!lastError.retryable) {
          throw error instanceof Error ? error : new Error(lastError.message);
        }

        if (attempt < REDDIT.RETRY_COUNT - 1) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 2000;
          console.error(`[Reddit] ${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT}`);
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    throw new Error(lastError?.message || 'Failed to fetch Reddit post after retries');
  }

  private formatBody(p: any): string {
    if (p.selftext?.trim()) return p.selftext;
    if (p.is_self) return '';
    if (p.url) return `**Link:** ${p.url}`;
    return '';
  }

  private extractComments(children: any[], maxComments: number, opAuthor: string): Comment[] {
    const result: Comment[] = [];
    
    const extract = (items: any[], depth = 0) => {
      const sorted = [...items].sort((a, b) => (b.data?.score || 0) - (a.data?.score || 0));
      
      for (const c of sorted) {
        if (result.length >= maxComments) return;
        if (c.kind !== 't1' || !c.data?.author || c.data.author === '[deleted]') continue;
        
        result.push({
          author: c.data.author,
          body: c.data.body || '',
          score: c.data.score || 0,
          depth,
          isOP: c.data.author === opAuthor,
        });
        
        if (c.data.replies?.data?.children && result.length < maxComments) {
          extract(c.data.replies.data.children, depth + 1);
        }
      }
    };

    extract(children);
    return result;
  }

  async getPosts(urls: string[], maxComments = 100): Promise<Map<string, PostResult | Error>> {
    if (urls.length <= REDDIT.BATCH_SIZE) {
      // Limit to 5 concurrent Reddit API calls
      const results = await pMap(
        urls,
        u => this.getPost(u, maxComments).catch(e => e as Error),
        5
      );
      return new Map(urls.map((u, i) => [u, results[i]]));
    }
    return (await this.batchGetPosts(urls, maxComments)).results;
  }

  async batchGetPosts(
    urls: string[],
    maxCommentsOverride?: number,
    fetchComments = true,
    onBatchComplete?: (batchNum: number, totalBatches: number, processed: number) => void
  ): Promise<BatchPostResult> {
    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);
    const allResults = new Map<string, PostResult | Error>();
    let rateLimitHits = 0;

    const allocation = calculateCommentAllocation(urls.length);
    const commentsPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;

    console.error(`[Reddit] Fetching ${urls.length} posts in ${totalBatches} batch(es), ${commentsPerPost} comments/post`);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const startIdx = batchNum * REDDIT.BATCH_SIZE;
      const batchUrls = urls.slice(startIdx, startIdx + REDDIT.BATCH_SIZE);

      console.error(`[Reddit] Batch ${batchNum + 1}/${totalBatches} (${batchUrls.length} posts)`);

      // Limit to 5 concurrent Reddit API calls within each batch
      const batchResults = await pMapSettled(
        batchUrls,
        url => this.getPost(url, commentsPerPost),
        5
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const url = batchUrls[i] || '';

        if (result.status === 'fulfilled') {
          allResults.set(url, result.value);
        } else {
          const errorMsg = result.reason?.message || String(result.reason);
          if (errorMsg.includes('429') || errorMsg.includes('rate')) rateLimitHits++;
          allResults.set(url, new Error(errorMsg));
        }
      }

      // Safe callback invocation
      try {
        onBatchComplete?.(batchNum + 1, totalBatches, allResults.size);
      } catch (callbackError) {
        console.error(`[Reddit] onBatchComplete callback error:`, callbackError);
      }

      console.error(`[Reddit] Batch ${batchNum + 1} complete (${allResults.size}/${urls.length})`);

      // Small delay between batches
      if (batchNum < totalBatches - 1) {
        await sleep(500);
      }
    }

    return { results: allResults, batchesProcessed: totalBatches, totalPosts: urls.length, rateLimitHits, commentAllocation: allocation };
  }
}
