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

// Module-level singleton - MarkdownCleaner is stateless
const markdownCleaner = new MarkdownCleaner();

// Get extraction suffix from YAML config (fallback to hardcoded if not found)
function getExtractionSuffix(): string {
  const config = getToolConfig('scrape_links');
  return config?.limits?.extraction_suffix as string || SCRAPER.EXTRACTION_SUFFIX;
}

interface ToolOptions {
  sessionId?: string;
  logger?: (level: 'info' | 'error' | 'debug', message: string, sessionId: string) => Promise<void>;
}

function calculateTokenAllocation(urlCount: number): number {
  if (urlCount <= 0) return SCRAPER.MAX_TOKENS_BUDGET;
  return Math.floor(SCRAPER.MAX_TOKENS_BUDGET / urlCount);
}

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract the main content and key information from this page.';
  return `${base}\n\n${getExtractionSuffix()}`;
}

/**
 * Safe logger wrapper - NEVER throws
 */
async function safeLog(
  logger: ToolOptions['logger'],
  sessionId: string | undefined,
  level: 'info' | 'error' | 'debug',
  message: string
): Promise<void> {
  if (!logger || !sessionId) return;
  try {
    await logger(level, message, sessionId);
  } catch {
    // Silently ignore logger errors - they should never crash the tool
    console.error(`[Scrape Tool] Logger failed: ${message}`);
  }
}

/**
 * Handle scrape links request
 * NEVER throws - always returns a valid response with content and metadata
 */
export async function handleScrapeLinks(
  params: ScrapeLinksParams,
  options: ToolOptions = {}
): Promise<{ content: string; structuredContent: ScrapeLinksOutput }> {
  const { sessionId, logger } = options;
  const startTime = Date.now();

  // Helper to create error response
  const createErrorResponse = (message: string, executionTime: number): { content: string; structuredContent: ScrapeLinksOutput } => ({
    content: `# ❌ Scraping Failed\n\n${message}`,
    structuredContent: {
      content: `# ❌ Scraping Failed\n\n${message}`,
      metadata: {
        total_urls: params.urls?.length || 0,
        successful: 0,
        failed: params.urls?.length || 0,
        total_credits: 0,
        execution_time_ms: executionTime,
      },
    },
  });

  // Validate params
  if (!params.urls || params.urls.length === 0) {
    return createErrorResponse('No URLs provided', Date.now() - startTime);
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
    return createErrorResponse(`All ${params.urls.length} URLs are invalid`, Date.now() - startTime);
  }

  const tokensPerUrl = calculateTokenAllocation(validUrls.length);
  const totalBatches = Math.ceil(validUrls.length / SCRAPER.BATCH_SIZE);

  await safeLog(logger, sessionId, 'info', `Starting scrape: ${validUrls.length} URL(s), ${tokensPerUrl} tokens/URL, ${totalBatches} batch(es)`);

  // Initialize clients safely
  let client: ScraperClient;
  try {
    client = new ScraperClient();
  } catch (error) {
    const err = classifyError(error);
    return createErrorResponse(`Failed to initialize scraper: ${err.message}`, Date.now() - startTime);
  }

  const llmProcessor = createLLMProcessor(); // Returns null if not configured

  const enhancedInstruction = params.use_llm
    ? enhanceExtractionInstruction(params.what_to_extract)
    : undefined;

  // Scrape URLs - scrapeMultiple NEVER throws
  const results = await client.scrapeMultiple(validUrls, { timeout: params.timeout });

  await safeLog(logger, sessionId, 'info', `Scraping complete. Processing ${results.length} results...`);

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

  // Process each result
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) {
      failed++;
      contents.push(`## Unknown URL\n\n❌ No result returned`);
      continue;
    }

    await safeLog(logger, sessionId, 'info', `[${i + 1}/${results.length}] Processing ${result.url}`);

    // Check for errors in result
    if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
      failed++;
      const errorMsg = result.error?.message || result.content || `HTTP ${result.statusCode}`;
      contents.push(`## ${result.url}\n\n❌ Failed to scrape: ${errorMsg}`);

      await safeLog(logger, sessionId, 'error', `[${i + 1}/${results.length}] Failed: ${errorMsg}`);
      continue;
    }

    // Success case
    successful++;
    totalCredits += result.credits;

    // Process content safely
    let content: string;
    try {
      content = markdownCleaner.processContent(result.content);
    } catch {
      // If markdown cleaning fails, use raw content
      content = result.content;
    }

    // Apply LLM extraction if enabled - processContentWithLLM NEVER throws
    if (params.use_llm && llmProcessor) {
      await safeLog(logger, sessionId, 'info', `[${i + 1}/${results.length}] Applying LLM extraction (${tokensPerUrl} tokens)...`);

      const llmResult = await processContentWithLLM(
        content,
        { use_llm: params.use_llm, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
        llmProcessor
      );

      if (llmResult.processed) {
        content = llmResult.content;
        await safeLog(logger, sessionId, 'info', `[${i + 1}/${results.length}] LLM extraction complete`);
      } else {
        llmErrors++;
        await safeLog(logger, sessionId, 'info', `[${i + 1}/${results.length}] LLM extraction skipped: ${llmResult.error || 'unknown reason'}`);
        // Continue with original content - graceful degradation
      }
    }

    // Remove meta tags safely
    try {
      content = removeMetaTags(content);
    } catch {
      // If this fails, just use the content as-is
    }

    contents.push(`## ${result.url}\n\n${content}`);
  }

  const executionTime = Date.now() - startTime;

  await safeLog(logger, sessionId, 'info', `Completed: ${successful} successful, ${failed} failed, ${totalCredits} credits used`);

  // Build response
  const allocationHeader = `**Token Allocation:** ${tokensPerUrl.toLocaleString()} tokens/URL (${params.urls.length} URLs, ${SCRAPER.MAX_TOKENS_BUDGET.toLocaleString()} total budget)`;
  const statusHeader = `**Status:** ✅ ${successful} successful | ❌ ${failed} failed | 📦 ${totalBatches} batch(es)${llmErrors > 0 ? ` | ⚠️ ${llmErrors} LLM extraction failures` : ''}`;
  const formattedContent = `# Scraped Content (${params.urls.length} URLs)\n\n${allocationHeader}\n${statusHeader}\n\n---\n\n${contents.join('\n\n---\n\n')}`;

  const metadata = {
    total_urls: params.urls.length,
    successful,
    failed,
    total_credits: totalCredits,
    execution_time_ms: executionTime,
    tokens_per_url: tokensPerUrl,
    total_token_budget: SCRAPER.MAX_TOKENS_BUDGET,
    batches_processed: totalBatches,
  };

  return { content: formattedContent, structuredContent: { content: formattedContent, metadata } };
}
