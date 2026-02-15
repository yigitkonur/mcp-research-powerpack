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
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  TOKEN_BUDGETS,
} from './utils.js';

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
      return formatError({
        code: 'NO_RESULTS',
        message: `No results found for any of the ${limited.length} queries`,
        toolName: 'search_reddit',
        howToFix: [
          'Try broader or simpler search terms',
          'Check spelling of technical terms',
          'Remove date filters if using them',
        ],
        alternatives: [
          'web_search(keywords=[...]) for general web results',
          'deep_research(questions=[...]) for synthesized analysis',
        ],
      });
    }

    // Aggregate and rank results by CTR
    const aggregation = aggregateAndRankReddit(results, 3);

    // Generate enhanced output with consensus highlighting AND per-query raw results
    return generateRedditEnhancedOutput(aggregation, limited, results);
  } catch (error) {
    const structuredError = classifyError(error);
    return formatError({
      code: structuredError.code,
      message: structuredError.message,
      retryable: structuredError.retryable,
      toolName: 'search_reddit',
      howToFix: ['Verify SERPER_API_KEY is set correctly'],
      alternatives: ['web_search(keywords=[...]) as backup'],
    });
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
  const suffix = config?.limits?.extraction_suffix;
  if (typeof suffix === 'string') return suffix;
  return `
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
      return formatError({
        code: 'MIN_POSTS',
        message: `Minimum ${REDDIT.MIN_POSTS} Reddit posts required. Received: ${urls.length}`,
        toolName: 'get_reddit_post',
        howToFix: [`Add at least ${REDDIT.MIN_POSTS - urls.length} more Reddit URL(s)`],
      });
    }
    if (urls.length > REDDIT.MAX_POSTS) {
      return formatError({
        code: 'MAX_POSTS',
        message: `Maximum ${REDDIT.MAX_POSTS} Reddit posts allowed. Received: ${urls.length}`,
        toolName: 'get_reddit_post',
        howToFix: [`Remove ${urls.length - REDDIT.MAX_POSTS} URL(s) and retry`],
      });
    }

    const allocation = calculateCommentAllocation(urls.length);
    const commentsPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;
    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, commentsPerPost, fetchComments);
    const results = batchResult.results;

    // Initialize LLM processor if needed
    const llmProcessor = use_llm ? createLLMProcessor() : null;
    const tokensPerUrl = use_llm ? Math.floor(TOKEN_BUDGETS.RESEARCH / urls.length) : 0;
    const enhancedInstruction = use_llm ? enhanceExtractionInstruction(what_to_extract) : undefined;

    let successful = 0;
    let failed = 0;
    let llmErrors = 0;
    const contents: string[] = [];

    for (const [url, result] of results) {
      if (result instanceof Error) {
        failed++;
        contents.push(`## ❌ Failed: ${url}\n\n_${result.message}_`);
      } else {
        successful++;
        let postContent = formatPost(result, fetchComments);

        // Apply LLM extraction per-URL if enabled
        if (use_llm && llmProcessor) {
          mcpLog('info', `[${successful}/${urls.length}] Applying LLM extraction to ${url}`, 'reddit');

          const llmResult = await processContentWithLLM(
            postContent,
            { use_llm: true, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
            llmProcessor
          );

          if (llmResult.processed) {
            postContent = `## LLM Analysis: ${result.post.title}\n\n**r/${result.post.subreddit}** • u/${result.post.author} • ⬆️ ${result.post.score} • 💬 ${result.post.commentCount} comments\n🔗 ${result.post.url}\n\n${llmResult.content}`;
            mcpLog('debug', `[${successful}/${urls.length}] LLM extraction complete`, 'reddit');
          } else {
            llmErrors++;
            mcpLog('warning', `[${successful}/${urls.length}] LLM extraction failed: ${llmResult.error || 'unknown'}`, 'reddit');
          }
        }

        contents.push(postContent);
      }
    }

    // Build 70/20/10 response
    const batchHeader = formatBatchHeader({
      title: `Reddit Posts`,
      totalItems: urls.length,
      successful,
      failed,
      ...(fetchComments ? { extras: { 'Comments/post': commentsPerPost } } : {}),
      ...(use_llm ? { tokensPerItem: tokensPerUrl } : {}),
      batches: totalBatches,
    });

    const statusExtras: string[] = [];
    if (batchResult.rateLimitHits > 0) {
      statusExtras.push(`⚠️ ${batchResult.rateLimitHits} rate limit retries`);
    }
    if (use_llm && !llmProcessor) {
      statusExtras.push('⚠️ LLM unavailable (OPENROUTER_API_KEY not set)');
    } else if (llmErrors > 0) {
      statusExtras.push(`⚠️ ${llmErrors} LLM extraction failures`);
    }

    const nextSteps = [
      successful > 0 ? 'Research further: deep_research(questions=[{question: "Based on Reddit discussion..."}])' : null,
      failed > 0 ? 'Retry failed URLs individually' : null,
      'Search related topics: search_reddit(queries=[...related terms...])',
    ].filter(Boolean) as string[];

    const extraStatus = statusExtras.length > 0 ? `\n${statusExtras.join(' | ')}` : '';

    return formatSuccess({
      title: `Reddit Posts Fetched (${successful}/${urls.length})`,
      summary: batchHeader + extraStatus,
      data: contents.join('\n\n---\n\n'),
      nextSteps,
    });
  } catch (error) {
    const structuredError = classifyError(error);
    return formatError({
      code: structuredError.code,
      message: structuredError.message,
      retryable: structuredError.retryable,
      toolName: 'get_reddit_post',
      howToFix: ['Verify REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set'],
    });
  }
}
