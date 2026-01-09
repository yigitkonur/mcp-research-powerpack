/**
 * Reddit Tools - Search and Fetch
 * NEVER throws - always returns structured response for graceful degradation
 */

import { SearchClient } from '../clients/search.js';
import { RedditClient, calculateCommentAllocation, type PostResult, type Comment } from '../clients/reddit.js';
import { aggregateAndRankReddit, generateRedditEnhancedOutput } from '../utils/url-aggregator.js';
import { REDDIT } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { getToolConfig } from '../config/loader.js';

// ============================================================================
// Formatters
// ============================================================================

function formatComments(comments: Comment[]): string {
  let md = '';
  for (const c of comments) {
    const indent = '  '.repeat(c.depth);
    const op = c.isOP ? ' **[OP]**' : '';
    const score = c.score >= 0 ? `+${c.score}` : `${c.score}`;
    md += `${indent}- **u/${c.author}**${op} _(${score})_\n`;
    const bodyLines = c.body.split('\n').map(line => `${indent}  ${line}`).join('\n');
    md += `${bodyLines}\n\n`;
  }
  return md;
}

function formatPost(result: PostResult, fetchComments: boolean): string {
  const { post, comments, allocatedComments } = result;
  let md = `## ${post.title}\n\n`;
  md += `**r/${post.subreddit}** • u/${post.author} • ⬆️ ${post.score} • 💬 ${post.commentCount} comments\n`;
  md += `🔗 ${post.url}\n\n`;

  if (post.body) {
    md += `### Post Content\n\n${post.body}\n\n`;
  }

  if (fetchComments && comments.length > 0) {
    md += `### Top Comments (${comments.length}/${post.commentCount} shown, allocated: ${allocatedComments})\n\n`;
    md += formatComments(comments);
  } else if (!fetchComments) {
    md += `_Comments not fetched (fetch_comments=false)_\n\n`;
  }

  return md;
}

// ============================================================================
// Search Reddit Handler
// ============================================================================

export async function handleSearchReddit(
  queries: string[],
  apiKey: string,
  dateAfter?: string
): Promise<string> {
  try {
    const limited = queries.slice(0, 50);
    const client = new SearchClient(apiKey);
    const results = await client.searchRedditMultiple(limited, dateAfter);

    // Check if any results were found
    let totalResults = 0;
    for (const items of results.values()) {
      totalResults += items.length;
    }

    if (totalResults === 0) {
      return `# 🔍 Reddit Search Results\n\n_No results found for any of the ${limited.length} queries._`;
    }

    // Aggregate and rank results by CTR
    const aggregation = aggregateAndRankReddit(results, 3);

    // Generate enhanced output with consensus highlighting AND per-query raw results
    return generateRedditEnhancedOutput(aggregation, limited, results);
  } catch (error) {
    const structuredError = classifyError(error);
    const retryHint = structuredError.retryable 
      ? '\n\n💡 This error may be temporary. Try again in a moment.' 
      : '';
    return `# ❌ search_reddit: Search Failed\n\n**${structuredError.code}:** ${structuredError.message}${retryHint}\n\n**Tip:** Make sure SERPER_API_KEY is set in your environment variables.`;
  }
}

// ============================================================================
// Get Reddit Posts Handler
// ============================================================================

interface GetRedditPostsOptions {
  fetchComments?: boolean;
  maxCommentsOverride?: number;
  use_llm?: boolean;
  what_to_extract?: string;
}

// Get extraction suffix from YAML config (fallback to hardcoded if not found)
function getExtractionSuffix(): string {
  const config = getToolConfig('get_reddit_post');
  return config?.limits?.extraction_suffix as string || `
---

⚠️ IMPORTANT: Extract and synthesize the key insights, opinions, and recommendations from these Reddit discussions. Focus on:
- Common themes and consensus across posts
- Specific recommendations with context
- Contrasting viewpoints and debates
- Real-world experiences and lessons learned
- Technical details and implementation tips

Be comprehensive but concise. Prioritize actionable insights.

---`;
}

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract key insights, recommendations, and community consensus from these Reddit discussions.';
  return `${base}\n\n${getExtractionSuffix()}`;
}

export async function handleGetRedditPosts(
  urls: string[],
  clientId: string,
  clientSecret: string,
  maxComments = 100,
  options: GetRedditPostsOptions = {}
): Promise<string> {
  try {
    const { fetchComments = true, maxCommentsOverride, use_llm = false, what_to_extract } = options;

    if (urls.length < REDDIT.MIN_POSTS) {
      return `# ❌ get_reddit_post: Validation Error\n\nMinimum ${REDDIT.MIN_POSTS} Reddit posts required. Received: ${urls.length}`;
    }
    if (urls.length > REDDIT.MAX_POSTS) {
      return `# ❌ get_reddit_post: Validation Error\n\nMaximum ${REDDIT.MAX_POSTS} Reddit posts allowed. Received: ${urls.length}. Please remove ${urls.length - REDDIT.MAX_POSTS} URL(s) and retry.`;
    }

    const allocation = calculateCommentAllocation(urls.length);
    const commentsPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;
    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, commentsPerPost, fetchComments);
    const results = batchResult.results;

    let md = `# Reddit Posts (${urls.length} posts)\n\n`;

    if (fetchComments) {
      md += `**Comment Allocation:** ${commentsPerPost} comments/post (${urls.length} posts, ${REDDIT.MAX_COMMENT_BUDGET} total budget)\n`;
    } else {
      md += `**Comments:** Not fetched (fetch_comments=false)\n`;
    }
    md += `**Status:** 📦 ${totalBatches} batch(es) processed\n\n`;
    md += `---\n\n`;

    let successful = 0;
    let failed = 0;

    for (const [url, result] of results) {
      if (result instanceof Error) {
        failed++;
        md += `## ❌ Failed: ${url}\n\n_${result.message}_\n\n---\n\n`;
      } else {
        successful++;
        md += formatPost(result, fetchComments);
        md += '\n---\n\n';
      }
    }

    md += `\n**Summary:** ✅ ${successful} successful | ❌ ${failed} failed`;
    if (batchResult.rateLimitHits > 0) {
      md += ` | ⚠️ ${batchResult.rateLimitHits} rate limit retries`;
    }

    // Apply LLM extraction if enabled
    if (use_llm) {
      const llmProcessor = createLLMProcessor();
      if (llmProcessor) {
        const enhancedInstruction = enhanceExtractionInstruction(what_to_extract);
        const tokensPerUrl = Math.floor(32000 / urls.length); // Similar budget as scrape_links
        
        console.error(`[Reddit Tool] Applying LLM extraction (${tokensPerUrl} tokens)...`);
        
        const llmResult = await processContentWithLLM(
          md,
          { use_llm: true, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
          llmProcessor
        );

        if (llmResult.processed) {
          console.error(`[Reddit Tool] LLM extraction complete`);
          return `# Reddit Posts Analysis (LLM Processed)\n\n**Posts Analyzed:** ${urls.length} | **Comment Budget:** ${commentsPerPost}/post\n\n---\n\n${llmResult.content}`;
        } else {
          console.error(`[Reddit Tool] LLM extraction skipped: ${llmResult.error || 'unknown reason'}`);
          md += `\n\n⚠️ _LLM extraction was requested but failed: ${llmResult.error || 'unknown'}. Returning raw content._`;
        }
      } else {
        md += `\n\n⚠️ _LLM extraction was requested but OPENROUTER_API_KEY is not set._`;
      }
    }

    return md.trim();
  } catch (error) {
    const structuredError = classifyError(error);
    const retryHint = structuredError.retryable 
      ? '\n\n💡 This error may be temporary. Try again in a moment.' 
      : '';
    return `# ❌ get_reddit_post: Operation Failed\n\n**${structuredError.code}:** ${structuredError.message}${retryHint}\n\n**Tip:** Make sure REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set in your environment variables.`;
  }
}
