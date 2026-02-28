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
        message: `Zero Reddit results across all ${limited.length} queries. Your search terms may be too specific, misspelled, or the topic has no Reddit coverage.`,
        toolName: 'search_reddit',
        howToFix: [
          `Broaden your queries — replace multi-word phrases with single keywords (e.g., "best React state management library 2025" → "React state management")`,
          'Double-check spelling of technical terms (e.g., "PostgreSQL" not "PostgressQL")',
          'Remove the date_after filter if you used one — it may be filtering out all results',
          `Call search_reddit again NOW with ${Math.max(3, limited.length)} simplified, broader queries targeting the same topic from different angles`,
        ],
        alternatives: [
          'web_search(keywords=["topic best practices", "topic guide", "topic recommendations 2025"]) — Reddit had nothing, so pivot to the broader web immediately',
          'scrape_links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from earlier searches, scrape them now instead of waiting',
          'deep_research(questions=[{question: "What are the key findings about [topic]?"}]) — use AI research to synthesize what you need',
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
      message: `search_reddit failed: ${structuredError.message}`,
      retryable: structuredError.retryable,
      toolName: 'search_reddit',
      howToFix: [
        'Verify SERPER_API_KEY is set correctly in your environment variables',
        structuredError.retryable ? 'This is a temporary error — call search_reddit again with the same queries in 3 seconds' : 'Check the API key and fix configuration before retrying',
      ],
      alternatives: [
        'web_search(keywords=["topic recommendations", "topic best practices", "topic vs alternatives"]) — same API but different endpoint, may still work',
        'deep_research(questions=[{question: "What does the community recommend for [topic]?"}]) — uses OpenRouter API (completely different service), will work even if Serper is down',
        'scrape_links(urls=[...any URLs you already have...], use_llm=true) — if you gathered URLs from earlier steps, scrape them NOW instead of waiting',
      ],
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
      const deficit = REDDIT.MIN_POSTS - urls.length;
      return formatError({
        code: 'MIN_POSTS',
        message: `You sent ${urls.length} Reddit URL(s) but the minimum is ${REDDIT.MIN_POSTS}. You need ${deficit} more URL(s).`,
        toolName: 'get_reddit_post',
        howToFix: [
          `You're only ${deficit} URL(s) short! Run search_reddit first to find more posts, then come back with ${REDDIT.MIN_POSTS}+ URLs`,
          `Call: search_reddit(queries=["topic discussion", "topic recommendations", "topic experiences"]) — this will return Reddit post URLs you can use`,
          `Then call get_reddit_post again with the original URL(s) PLUS the new ones from search_reddit`,
        ],
        alternatives: [
          `search_reddit(queries=["topic discussion", "topic recommendations", "topic experiences"]) — find ${deficit}+ more Reddit posts, then call get_reddit_post with ALL URLs combined`,
          `web_search(keywords=["topic site:reddit.com"]) — find Reddit posts via web search as a backup source of URLs`,
        ],
      });
    }
    if (urls.length > REDDIT.MAX_POSTS) {
      const excess = urls.length - REDDIT.MAX_POSTS;
      const batches = Math.ceil(urls.length / REDDIT.MAX_POSTS);
      return formatError({
        code: 'MAX_POSTS',
        message: `You sent ${urls.length} URLs but the maximum is ${REDDIT.MAX_POSTS} per call. You have ${excess} too many.`,
        toolName: 'get_reddit_post',
        howToFix: [
          `Split into ${batches} separate calls of ~${Math.ceil(urls.length / batches)} URLs each, then combine the results`,
          `Or remove the ${excess} least-relevant URLs and call this tool again with the top ${REDDIT.MAX_POSTS}`,
        ],
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
      successful > 0 ? 'VERIFY WHAT REDDIT SAYS: Reddit comments are opinions, not facts. Cross-check the top claims: web_search(keywords=["specific claim from comments", "topic official benchmarks", "topic documentation"]) — community consensus can be wrong. Verify before trusting.' : null,
      successful > 0 ? 'FOLLOW THE LINKS: Comments above likely mention specific tools, libraries, blog posts, or docs. Scrape them: scrape_links(urls=[...URLs from comments...], use_llm=true, what_to_extract="Extract evidence | data | recommendations | benchmarks") — the gold is often in the links people share, not the comments themselves.' : null,
      'MISSING PERSPECTIVES? Look at the subreddits above. Are you only seeing one community\'s view? search_reddit(queries=["topic" + different subreddit angles, "topic criticism", "topic alternatives"]) — a single subreddit is an echo chamber. Get diverse opinions.',
      successful > 0 ? 'ONLY THEN SYNTHESIZE: deep_research(questions=[{question: "Based on verified Reddit community findings..."}]) — synthesize AFTER you\'ve verified claims and scraped referenced links. Raw Reddit comments without verification = unreliable conclusions.' : null,
      failed > 0 ? `RETRY FAILURES: ${failed} post(s) failed to fetch. Try them individually, or use scrape_links(urls=[...failed URLs...], use_llm=true) as a direct HTTP fallback.` : null,
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
      message: `get_reddit_post failed: ${structuredError.message}`,
      retryable: structuredError.retryable,
      toolName: 'get_reddit_post',
      howToFix: [
        'Verify REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set in environment variables',
        'Create a Reddit app at https://www.reddit.com/prefs/apps (select "script" type) if you haven\'t already',
        structuredError.retryable ? 'This is temporary — call get_reddit_post again with the same URLs in 3 seconds' : 'Fix the credentials and retry',
      ],
      alternatives: [
        'scrape_links(urls=[...the same Reddit URLs...], use_llm=true, what_to_extract="Extract post title | post content | top comments | recommendations | consensus") — scrape Reddit pages directly via HTTP as a fallback (no Reddit API credentials needed)',
        'web_search(keywords=["topic reddit discussion", "topic reddit recommendations"]) — find cached/indexed Reddit content via Google',
        'deep_research(questions=[{question: "What are community opinions and recommendations for [topic]?"}]) — uses OpenRouter (different API), synthesizes community perspective from web sources',
      ],
    });
  }
}
