/**
 * Reddit OAuth API Client
 * Fetches posts and comments sorted by score (most upvoted first)
 */

import { REDDIT } from '../config/index.js';

export interface Post {
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

export interface BatchPostResult {
  results: Map<string, PostResult | Error>;
  batchesProcessed: number;
  totalPosts: number;
  rateLimitHits: number;
  commentAllocation: CommentAllocation;
}

export interface CommentAllocation {
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

export class RedditClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  private userAgent = 'script:research-powerpack-mcp:v3.0 (by /u/research-powerpack)';

  constructor(private clientId: string, private clientSecret: string) {}

  private async auth(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 60000) return this.token;

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Reddit auth failed: ${res.status} ${text}`);
    }
    
    const data = await res.json() as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  private parseUrl(url: string): { sub: string; id: string } | null {
    const m = url.match(/reddit\.com\/r\/([^\/]+)\/comments\/([a-z0-9]+)/i);
    return m ? { sub: m[1], id: m[2] } : null;
  }

  async getPost(url: string, maxComments = 100): Promise<PostResult> {
    const parsed = this.parseUrl(url);
    if (!parsed) throw new Error(`Invalid Reddit URL: ${url}`);

    const token = await this.auth();
    const limit = Math.min(maxComments, 500);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < REDDIT.RETRY_COUNT; attempt++) {
      try {
        const apiUrl = `https://oauth.reddit.com/r/${parsed.sub}/comments/${parsed.id}?sort=top&limit=${limit}&depth=10&raw_json=1`;
        
        const res = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': this.userAgent,
          },
        });

        if (res.status === 429) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 32000;
          console.error(`[Reddit] Rate limited. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT} after ${delay}ms`);
          await this.delay(delay);
          continue;
        }

        if (!res.ok) throw new Error(`Reddit API error: ${res.status}`);
        
        const [postListing, commentListing] = await res.json() as [any, any];
        const p = postListing?.data?.children?.[0]?.data;
        if (!p) throw new Error(`Post not found: ${url}`);

        const post: Post = {
          title: p.title,
          author: p.author || '[deleted]',
          subreddit: p.subreddit,
          body: this.formatBody(p),
          score: p.score,
          commentCount: p.num_comments,
          url: `https://reddit.com${p.permalink}`,
          created: new Date(p.created_utc * 1000),
          flair: p.link_flair_text || undefined,
          isNsfw: p.over_18 || false,
          isPinned: p.stickied || false,
        };

        const comments = this.extractComments(commentListing?.data?.children || [], maxComments, post.author);

        return { post, comments, allocatedComments: maxComments, actualComments: post.commentCount };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < REDDIT.RETRY_COUNT - 1) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 2000;
          console.error(`[Reddit] Error: ${lastError.message}. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT}`);
          await this.delay(delay);
        }
      }
    }

    throw lastError || new Error('Failed to fetch Reddit post');
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
      const results = await Promise.all(
        urls.map(u => this.getPost(u, maxComments).catch(e => e as Error))
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

      const batchResults = await Promise.allSettled(
        batchUrls.map(url => this.getPost(url, commentsPerPost))
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

      onBatchComplete?.(batchNum + 1, totalBatches, allResults.size);
      console.error(`[Reddit] Batch ${batchNum + 1} complete (${allResults.size}/${urls.length})`);

      if (batchNum < totalBatches - 1) await this.delay(500);
    }

    return { results: allResults, batchesProcessed: totalBatches, totalPosts: urls.length, rateLimitHits, commentAllocation: allocation };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
