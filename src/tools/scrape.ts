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
    return createErrorResponse('NO_URLS', 'No URLs provided');
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
    return createErrorResponse('INVALID_URLS', `All ${params.urls.length} URLs are invalid`, false, [
      'web_search(keywords=["topic documentation", "topic guide"]) — search for valid URLs first, then scrape the results',
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
    return createErrorResponse('CLIENT_INIT_FAILED', `Failed to initialize scraper: ${err.message}`, false, [
      'web_search(keywords=["topic key findings", "topic summary", "topic overview"]) — search for information instead of scraping',
      'search_reddit(queries=["topic discussion", "topic recommendations"]) — get community insights as an alternative',
      'deep_research(questions=[{question: "Summarize the key information from [topic/URLs]"}]) — use AI research to gather equivalent information',
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
        { use_llm: params.use_llm, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
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
    successful > 0 ? 'FOLLOW LINKS: If scraped content references other URLs/docs/sources, scrape those too: scrape_links(urls=[...extracted URLs...], use_llm=true)' : null,
    successful > 0 ? 'VERIFY: web_search(keywords=["claim from scraped content", "topic official source", "topic benchmark data"]) — cross-check extracted claims' : null,
    successful > 0 ? 'COMMUNITY: search_reddit(queries=["topic experiences", "topic recommendations", "topic issues"]) — if topic warrants community perspective' : null,
    successful > 0 ? 'SYNTHESIZE (only after verifying + community check): deep_research(questions=[{question: "Based on scraped data and verification..."}])' : null,
    failed > 0 ? `Retry failed URLs with longer timeout: scrape_links(urls=[...], timeout=60)` : null,
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
