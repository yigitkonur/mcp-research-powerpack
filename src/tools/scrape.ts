/**
 * Scrape Links Tool Handler
 * Implements robust error handling that NEVER crashes the MCP server
 */

import type { ScrapeLinksParams, ScrapeLinksOutput } from '../schemas/scrape-links.js';
import { ScraperClient } from '../clients/scraper.js';
import { MarkdownCleaner } from '../services/markdown-cleaner.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { removeMetaTags } from '../utils/markdown-formatter.js';
import { SCRAPER } from '../config/index.js';
import { getToolConfig } from '../config/loader.js';
import { classifyError } from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatDuration,
  TOKEN_BUDGETS,
  calculateTokenAllocation,
} from './utils.js';

// Module-level singleton - MarkdownCleaner is stateless
const markdownCleaner = new MarkdownCleaner();

// Get extraction prefix+suffix from YAML config (fallback to hardcoded)
function getExtractionPrefix(): string {
  const config = getToolConfig('scrape_links');
  const prefix = config?.limits?.extraction_prefix;
  return typeof prefix === 'string' ? prefix : SCRAPER.EXTRACTION_PREFIX;
}

function getExtractionSuffix(): string {
  const config = getToolConfig('scrape_links');
  const suffix = config?.limits?.extraction_suffix;
  return typeof suffix === 'string' ? suffix : SCRAPER.EXTRACTION_SUFFIX;
}

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract the main content and key information from this page.';
  return `${getExtractionPrefix()}\n\n${base}\n\n${getExtractionSuffix()}`;
}

/**
 * Handle scrape links request
 * NEVER throws - always returns a valid response with content and metadata
 */
export async function handleScrapeLinks(
  params: ScrapeLinksParams
): Promise<{ content: string; structuredContent: ScrapeLinksOutput }> {
  const startTime = Date.now();

  // Helper to create error response
  const createErrorResponse = (code: string, message: string, retryable = false, alternatives?: string[]): { content: string; structuredContent: ScrapeLinksOutput } => ({
    content: formatError({
      code,
      message,
      retryable,
      toolName: 'scrape_links',
      howToFix: code === 'NO_URLS' ? ['Provide at least one valid URL'] : undefined,
      alternatives,
    }),
    structuredContent: {
      content: message,
      metadata: {
        total_urls: params.urls?.length || 0,
        successful: 0,
        failed: params.urls?.length || 0,
        total_credits: 0,
        execution_time_ms: Date.now() - startTime,
      },
    },
  });

  // Validate params
  if (!params.urls || params.urls.length === 0) {
    return createErrorResponse('NO_URLS', 'You called scrape_links with an empty URL list. You need at least 1 URL to scrape.', false, [
      'web_search(keywords=["topic documentation", "topic guide", "topic official site"]) — search for URLs first, then pass the results to scrape_links',
      'search_reddit(queries=["topic recommendations"]) — find Reddit discussions with links to scrape',
      'Once you have URLs, call scrape_links again with urls=[...your URLs...]',
    ]);
  }

  // Filter out invalid URLs early
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];

  for (const url of params.urls) {
    try {
      new URL(url);
      validUrls.push(url);
    } catch {
      invalidUrls.push(url);
    }
  }

  if (validUrls.length === 0) {
    return createErrorResponse('INVALID_URLS', `All ${params.urls.length} URL(s) failed validation — none are valid HTTP/HTTPS URLs. Check for typos, missing protocols (https://), or malformed paths.`, false, [
      'Fix the URLs: ensure each starts with "https://" and is a complete, valid URL (e.g., "https://example.com/page" not "example.com/page")',
      'Then call scrape_links again immediately with the corrected URLs',
      'web_search(keywords=["topic documentation", "topic guide"]) — if you don\'t have valid URLs, search for them first',
      'search_reddit(queries=["topic recommendations"]) — find discussion URLs to scrape instead',
    ]);
  }

  const tokensPerUrl = calculateTokenAllocation(validUrls.length, TOKEN_BUDGETS.SCRAPER);
  const totalBatches = Math.ceil(validUrls.length / SCRAPER.BATCH_SIZE);

  mcpLog('info', `Starting scrape: ${validUrls.length} URL(s), ${tokensPerUrl} tokens/URL, ${totalBatches} batch(es)`, 'scrape');

  // Initialize clients safely
  let client: ScraperClient;
  try {
    client = new ScraperClient();
  } catch (error) {
    const err = classifyError(error);
    return createErrorResponse('CLIENT_INIT_FAILED', `Scraper client failed to initialize: ${err.message}. This usually means SCRAPEDO_API_KEY is missing or invalid.`, false, [
      'Set SCRAPEDO_API_KEY in your environment — get a free key at https://scrape.do (1,000 free credits)',
      'Once set, call scrape_links again with the same URLs',
      'web_search(keywords=["topic key findings", "topic summary", "topic overview"]) — search for information instead of scraping (uses Serper API, different service)',
      'search_reddit(queries=["topic discussion", "topic recommendations"]) — get community insights as an alternative (uses Serper API)',
      'deep_research(questions=[{question: "Summarize key findings about [topic]"}]) — use AI research to gather equivalent information (uses OpenRouter API)',
    ]);
  }

  const llmProcessor = createLLMProcessor(); // Returns null if not configured

  const enhancedInstruction = params.use_llm
    ? enhanceExtractionInstruction(params.what_to_extract)
    : undefined;

  // Scrape URLs - scrapeMultiple NEVER throws
  const results = await client.scrapeMultiple(validUrls, { timeout: params.timeout });

  mcpLog('info', `Scraping complete. Processing ${results.length} results...`, 'scrape');

  let successful = 0;
  let failed = 0;
  let totalCredits = 0;
  let llmErrors = 0;
  const contents: string[] = [];

  // Add invalid URLs to failed count
  for (const invalidUrl of invalidUrls) {
    failed++;
    contents.push(`## ${invalidUrl}\n\n❌ Invalid URL format`);
  }

  // Pass 1: Synchronous processing (markdown cleaning, error checking, credit counting)
  interface ProcessedResult {
    url: string;
    content: string;
    index: number;
  }
  const successItems: ProcessedResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) {
      failed++;
      contents.push(`## Unknown URL\n\n❌ No result returned`);
      continue;
    }

    mcpLog('debug', `[${i + 1}/${results.length}] Processing ${result.url}`, 'scrape');

    // Check for errors in result
    if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
      failed++;
      const errorMsg = result.error?.message || result.content || `HTTP ${result.statusCode}`;
      contents.push(`## ${result.url}\n\n❌ Failed to scrape: ${errorMsg}`);
      mcpLog('warning', `[${i + 1}/${results.length}] Failed: ${errorMsg}`, 'scrape');
      continue;
    }

    // Success case
    successful++;
    totalCredits += result.credits;

    // Process content safely (CPU-bound, fast)
    let content: string;
    try {
      content = markdownCleaner.processContent(result.content);
    } catch {
      content = result.content;
    }

    successItems.push({ url: result.url, content, index: i });
  }

  // Pass 2: Parallel LLM extraction for successful results (I/O-bound)
  if (params.use_llm && llmProcessor && successItems.length > 0) {
    mcpLog('info', `Starting parallel LLM extraction for ${successItems.length} pages (concurrency: 3)`, 'scrape');

    const llmResults = await pMap(successItems, async (item) => {
      mcpLog('debug', `LLM extracting ${item.url} (${tokensPerUrl} tokens)...`, 'scrape');

      const llmResult = await processContentWithLLM(
        item.content,
        { use_llm: params.use_llm, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl, model: params.model },
        llmProcessor
      );

      if (llmResult.processed) {
        mcpLog('debug', `LLM extraction complete for ${item.url}`, 'scrape');
        return { ...item, content: llmResult.content };
      }

      llmErrors++;
      mcpLog('warning', `LLM extraction skipped for ${item.url}: ${llmResult.error || 'unknown reason'}`, 'scrape');
      return item; // Graceful degradation — use original cleaned content
    }, 3);

    // Update successItems with LLM-processed content
    for (let i = 0; i < llmResults.length; i++) {
      successItems[i] = llmResults[i];
    }
  }

  // Pass 3: Final assembly — remove meta tags and build content entries
  for (const item of successItems) {
    let content = item.content;
    try {
      content = removeMetaTags(content);
    } catch {
      // If this fails, just use the content as-is
    }
    contents.push(`## ${item.url}\n\n${content}`);
  }

  const executionTime = Date.now() - startTime;

  mcpLog('info', `Completed: ${successful} successful, ${failed} failed, ${totalCredits} credits used`, 'scrape');

  // Build 70/20/10 response
  const batchHeader = formatBatchHeader({
    title: `Scraped Content (${params.urls.length} URLs)`,
    totalItems: params.urls.length,
    successful,
    failed,
    tokensPerItem: tokensPerUrl,
    batches: totalBatches,
    extras: {
      'Credits used': totalCredits,
      ...(llmErrors > 0 ? { 'LLM extraction failures': llmErrors } : {}),
    },
  });

  const nextSteps = [
    successful > 0 ? 'FOLLOW THE TRAIL: Read through the scraped content above. If it references other URLs, documentation pages, GitHub repos, or data sources — scrape those too: scrape_links(urls=[...referenced URLs...], use_llm=true). The best insights are often one link away from your initial scrape.' : null,
    successful > 0 ? 'VERIFY CLAIMS: The content above may contain outdated info, marketing claims, or biased perspectives. Cross-check: web_search(keywords=["specific claim from above", "topic official documentation", "topic benchmark data 2025"]) — trust but verify.' : null,
    successful > 0 ? 'GET REAL-WORLD EXPERIENCE: search_reddit(queries=["topic experiences", "topic problems", "topic recommendations", "topic vs alternatives"]) — scraped docs tell you what something IS, Reddit tells you how it WORKS IN PRACTICE. You need both.' : null,
    successful > 0 ? 'ONLY THEN SYNTHESIZE: deep_research(questions=[{question: "Based on scraped primary sources and community validation..."}]) — do NOT synthesize yet if you haven\'t verified claims and checked community opinions. Premature synthesis = shallow analysis.' : null,
    failed > 0 ? `RETRY FAILURES: ${failed} URL(s) failed. Retry with longer timeout: scrape_links(urls=[...failed URLs...], timeout=90). If still failing, the site may be blocking scrapers — try web_search to find cached/mirrored versions.` : null,
  ].filter(Boolean) as string[];

  const formattedContent = formatSuccess({
    title: 'Scraping Complete',
    summary: batchHeader,
    data: contents.join('\n\n---\n\n'),
    nextSteps,
    metadata: {
      'Execution time': formatDuration(executionTime),
      'Token budget': TOKEN_BUDGETS.SCRAPER.toLocaleString(),
    },
  });

  const metadata = {
    total_urls: params.urls.length,
    successful,
    failed,
    total_credits: totalCredits,
    execution_time_ms: executionTime,
    tokens_per_url: tokensPerUrl,
    total_token_budget: TOKEN_BUDGETS.SCRAPER,
    batches_processed: totalBatches,
  };

  return { content: formattedContent, structuredContent: { content: formattedContent, metadata } };
}
