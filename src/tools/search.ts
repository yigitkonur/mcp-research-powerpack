/**
 * Web Search Tool Handler
 * NEVER throws - always returns structured response for graceful degradation
 */

import type { WebSearchParams, WebSearchOutput } from '../schemas/web-search.js';
import { SearchClient } from '../clients/search.js';
import {
  aggregateAndRank,
  buildUrlLookup,
  lookupUrl,
  generateEnhancedOutput,
  markConsensus,
} from '../utils/url-aggregator.js';
import { CTR_WEIGHTS } from '../config/index.js';
import { classifyError, MCP_ERROR_CODES, type McpErrorCodeType } from '../utils/errors.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatDuration,
} from './utils.js';

function getPositionScore(position: number): number {
  if (position >= 1 && position <= 10) {
    return CTR_WEIGHTS[position] ?? 0;
  }
  return Math.max(0, 10 - (position - 10) * 0.5);
}

export async function handleWebSearch(
  params: WebSearchParams
): Promise<{ content: string; structuredContent: WebSearchOutput }> {
  const startTime = Date.now();

  try {
    mcpLog('info', `Searching for ${params.keywords.length} keyword(s)`, 'search');

    const client = new SearchClient();
    const response = await client.searchMultiple(params.keywords);

    const aggregation = aggregateAndRank(response.searches, 5);
    const urlLookup = buildUrlLookup(aggregation.rankedUrls);

    const consensusUrls = aggregation.rankedUrls.filter(
      url => url.frequency >= aggregation.frequencyThreshold
    );

    let markdown = '';

    if (consensusUrls.length > 0) {
      markdown += generateEnhancedOutput(
        consensusUrls,
        params.keywords,
        aggregation.totalUniqueUrls,
        aggregation.frequencyThreshold,
        aggregation.thresholdNote
      );
      markdown += '\n---\n\n';
    } else {
      markdown += `## The Perfect Search Results (Aggregated from ${response.totalKeywords} Queries)\n\n`;
      markdown += `> *No high-consensus URLs found across searches. Results may be highly diverse.*\n\n`;
      markdown += `---\n\n`;
    }

    // Limit output based on number of queries to keep under ~20k tokens
    const MAX_QUERIES_SHOWN = 15;
    const MAX_RESULTS_PER_QUERY = response.totalKeywords > 10 ? 5 : 10;
    const queriesToShow = response.searches.slice(0, MAX_QUERIES_SHOWN);
    const queriesOmitted = response.searches.length - queriesToShow.length;

    markdown += `## 📊 Full Search Results by Query`;
    if (queriesOmitted > 0) {
      markdown += ` (showing ${queriesToShow.length} of ${response.searches.length})`;
    }
    markdown += `\n\n`;

    let totalResults = 0;

    queriesToShow.forEach((search, index) => {
      markdown += `### Query ${index + 1}: "${search.keyword}"\n\n`;

      search.results.slice(0, MAX_RESULTS_PER_QUERY).forEach((result, resultIndex) => {
        const position = resultIndex + 1;
        const positionScore = getPositionScore(position);

        const rankedUrl = lookupUrl(result.link, urlLookup);
        const frequency = rankedUrl?.frequency ?? 1;
        const consensusMark = markConsensus(frequency);
        const consensusInfo = rankedUrl
          ? `${consensusMark} (${frequency} searches)`
          : `${consensusMark} (1 search)`;

        markdown += `${position}. **[${result.title}](${result.link})** — Position ${position} | Score: ${positionScore.toFixed(1)} | Consensus: ${consensusInfo}\n`;

        if (result.snippet) {
          let snippet = result.snippet;
          if (snippet.length > 150) {
            snippet = snippet.substring(0, 147) + '...';
          }

          if (result.date) {
            markdown += `   - *${result.date}* — ${snippet}\n`;
          } else {
            markdown += `   - ${snippet}\n`;
          }
        }

        markdown += '\n';
        totalResults++;
      });

      if (search.related && search.related.length > 0) {
        const relatedSuggestions = search.related
          .slice(0, 5)
          .map((r: string) => `\`${r}\``)
          .join(', ');

        markdown += `*Related:* ${relatedSuggestions}\n\n`;
      }

      if (index < queriesToShow.length - 1) {
        markdown += `---\n\n`;
      }
    });

    if (queriesOmitted > 0) {
      markdown += `\n---\n\n> *${queriesOmitted} additional queries not shown. Consensus URLs above include all ${response.searches.length} queries.*\n`;
    }

    const executionTime = Date.now() - startTime;

    mcpLog('info', `Search completed: ${totalResults} results, ${aggregation.totalUniqueUrls} unique URLs, ${consensusUrls.length} consensus`, 'search');

    // Add Next Steps section — scraping is MANDATORY, not optional
    const topConsensusUrls = consensusUrls.length > 0
      ? consensusUrls.slice(0, 5).map(u => `"${u.url}"`).join(', ')
      : aggregation.rankedUrls.slice(0, 5).map(u => `"${u.url}"`).join(', ');

    const nextSteps = [
      `SCRAPE NOW: scrape_links(urls=[${topConsensusUrls}], use_llm=true, what_to_extract="Extract key findings | recommendations | data | evidence | comparisons") — you only have URLs right now, NOT content. Searching without scraping is like reading a table of contents without opening the book. Scrape immediately.`,
      'GET REAL OPINIONS: search_reddit(queries=["topic recommendations", "topic best 2025", "topic vs alternatives", "topic problems", "topic experience"]) — web results are curated marketing. Reddit has raw, unfiltered user experiences. You need both perspectives.',
      'SEARCH DEEPER: Look at the "Related" suggestions above. If ANY of them reveal angles you haven\'t covered, run web_search again with those as keywords. First-pass searches are NEVER comprehensive enough.',
      'ONLY THEN SYNTHESIZE: deep_research(questions=[{question: "Based on scraped content and community feedback from Reddit, synthesize..."}]) — do NOT synthesize until you\'ve scraped AND checked Reddit. Synthesizing from URLs alone produces shallow analysis.',
    ];

    markdown += '\n\n---\n\n**YOUR RESEARCH IS NOT DONE — Do ALL of these next steps (research is a loop, not a single search):**\n';
    nextSteps.forEach((step, i) => { markdown += `${i + 1}. ${step}\n`; });
    markdown += '\n> **Stop and think:** Did this search fully answer your question? Almost certainly not — search results are just links. You MUST scrape the top results AND cross-reference with community opinions before you have real answers. Keep going.\n';

    markdown += `\n---\n*${formatDuration(executionTime)} | ${aggregation.totalUniqueUrls} unique URLs | ${consensusUrls.length} consensus*`;

    const metadata = {
      total_keywords: response.totalKeywords,
      total_results: totalResults,
      execution_time_ms: executionTime,
      total_unique_urls: aggregation.totalUniqueUrls,
      consensus_url_count: consensusUrls.length,
      frequency_threshold: aggregation.frequencyThreshold,
    };

    return { content: markdown, structuredContent: { content: markdown, metadata } };
  } catch (error) {
    const structuredError = classifyError(error);
    const executionTime = Date.now() - startTime;

    mcpLog('error', `web_search: ${structuredError.message}`, 'search');

    const errorContent = formatError({
      code: structuredError.code,
      message: `web_search failed: ${structuredError.message}`,
      retryable: structuredError.retryable,
      toolName: 'web_search',
      howToFix: [
        'Verify SERPER_API_KEY is set correctly in your environment variables — get a free key at https://serper.dev (2,500 free queries)',
        structuredError.retryable ? 'This is temporary — wait 3 seconds and call web_search again with the same keywords' : 'Fix the API key and retry',
      ],
      alternatives: [
        'search_reddit(queries=["topic recommendations", "topic best practices", "topic vs alternatives"]) — same API but different endpoint, may still work; also gives you community perspective',
        'deep_research(questions=[{question: "What are the key findings, best practices, and recommendations for [topic]?"}]) — uses OpenRouter API (completely different service), will work even if Serper is down',
        'scrape_links(urls=[...any URLs you already have from prior steps...], use_llm=true) — if you gathered URLs earlier, scrape them NOW instead of waiting for search to recover',
      ],
    });

    return {
      content: errorContent,
      structuredContent: {
        content: errorContent,
        metadata: {
          total_keywords: params.keywords.length,
          total_results: 0,
          execution_time_ms: executionTime,
          errorCode: structuredError.code,
        },
      },
    };
  }
}
