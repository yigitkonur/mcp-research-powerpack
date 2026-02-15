/**
 * URL Aggregator Utility
 * Aggregates search results across multiple queries, calculates CTR-weighted scores,
 * and generates consensus-based rankings.
 */

import { CTR_WEIGHTS } from '../config/index.js';
import type { KeywordSearchResult, RedditSearchResult } from '../clients/search.js';

/**
 * Aggregated URL data structure
 */
interface AggregatedUrl {
  url: string;
  title: string;
  snippet: string;
  frequency: number;
  positions: number[];
  queries: string[];
  bestPosition: number;
  totalScore: number;
}

/**
 * Ranked URL with normalized score
 */
interface RankedUrl {
  url: string;
  title: string;
  snippet: string;
  rank: number;
  score: number;
  frequency: number;
  positions: number[];
  queries: string[];
  bestPosition: number;
  isConsensus: boolean;
}

/**
 * Aggregation result containing all processed data
 */
interface AggregationResult {
  rankedUrls: RankedUrl[];
  totalUniqueUrls: number;
  totalQueries: number;
  frequencyThreshold: number;
  thresholdNote?: string;
}

/**
 * Get CTR weight for a position (1-10)
 * Positions beyond 10 get minimal weight
 */
function getCtrWeight(position: number): number {
  if (position >= 1 && position <= 10) {
    return CTR_WEIGHTS[position] ?? 0;
  }
  // Positions beyond 10 get diminishing returns
  return Math.max(0, 10 - (position - 10) * 0.5);
}

/**
 * Aggregate results from multiple searches
 * Flattens all results, deduplicates by URL, and tracks frequency/positions
 */
function aggregateResults(searches: KeywordSearchResult[]): Map<string, AggregatedUrl> {
  const urlMap = new Map<string, AggregatedUrl>();

  for (const search of searches) {
    for (const result of search.results) {
      const normalizedUrl = normalizeUrl(result.link);
      const existing = urlMap.get(normalizedUrl);

      if (existing) {
        existing.frequency += 1;
        existing.positions.push(result.position);
        existing.queries.push(search.keyword);
        const prevBest = existing.bestPosition;
        existing.bestPosition = Math.min(existing.bestPosition, result.position);
        existing.totalScore += getCtrWeight(result.position);
        // Keep best title/snippet (from highest ranking position)
        if (result.position < prevBest) {
          existing.title = result.title;
          existing.snippet = result.snippet;
        }
      } else {
        urlMap.set(normalizedUrl, {
          url: result.link,
          title: result.title,
          snippet: result.snippet,
          frequency: 1,
          positions: [result.position],
          queries: [search.keyword],
          bestPosition: result.position,
          totalScore: getCtrWeight(result.position),
        });
      }
    }
  }

  return urlMap;
}

/**
 * Normalize URL for deduplication
 * Removes trailing slashes, www prefix, and normalizes protocol
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.replace(/^www\./, '');
    let path = parsed.pathname.replace(/\/$/, '') || '/';
    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Filter URLs by minimum frequency
 * Returns URLs appearing in at least minFrequency searches
 */
function filterByFrequency(
  urlMap: Map<string, AggregatedUrl>,
  minFrequency: number
): AggregatedUrl[] {
  const filtered: AggregatedUrl[] = [];
  
  for (const url of urlMap.values()) {
    if (url.frequency >= minFrequency) {
      filtered.push(url);
    }
  }

  return filtered;
}

/**
 * Calculate weighted scores and normalize to 100.0
 * Returns sorted array with rank assignments
 */
function calculateWeightedScores(urls: AggregatedUrl[]): RankedUrl[] {
  if (urls.length === 0) return [];

  // Sort by total score descending
  const sorted = [...urls].sort((a, b) => b.totalScore - a.totalScore);

  // Find max score for normalization
  const maxScore = sorted[0].totalScore;

  // Map to ranked URLs with normalized scores
  return sorted.map((url, index) => ({
    url: url.url,
    title: url.title,
    snippet: url.snippet,
    rank: index + 1,
    score: maxScore > 0 ? (url.totalScore / maxScore) * 100 : 0,
    frequency: url.frequency,
    positions: url.positions,
    queries: url.queries,
    bestPosition: url.bestPosition,
    isConsensus: url.frequency >= 3,
  }));
}

/**
 * Mark consensus status for a URL
 * Returns "✓" if frequency >= 3, else "✗"
 */
export function markConsensus(frequency: number): string {
  return frequency >= 3 ? '✓' : '✗';
}

/**
 * Generate justification for why a URL is ranked at its position
 */
function generateJustification(url: RankedUrl, rank: number): string {
  const parts: string[] = [];
  
  if (url.frequency >= 4) {
    parts.push(`Appeared in ${url.frequency} different searches showing strong cross-query relevance`);
  } else if (url.frequency >= 3) {
    parts.push(`Found across ${url.frequency} searches indicating solid topical coverage`);
  } else {
    parts.push(`Appeared in ${url.frequency} search${url.frequency > 1 ? 'es' : ''}`);
  }
  
  if (url.bestPosition === 1) {
    parts.push('ranked #1 in at least one search');
  } else if (url.bestPosition <= 3) {
    parts.push(`best position was top-3 (#${url.bestPosition})`);
  }
  
  return parts.join(', ') + '.';
}

/**
 * Generate enhanced narrative output for consensus URLs
 */
export function generateEnhancedOutput(
  rankedUrls: RankedUrl[],
  allKeywords: string[],
  totalUniqueUrls: number,
  frequencyThreshold: number,
  thresholdNote?: string
): string {
  const lines: string[] = [];
  
  // Header
  lines.push(`## The Perfect Search Results (Aggregated from ${allKeywords.length} Queries)`);
  lines.push('');
  lines.push(`Based on ${allKeywords.length} distinct searches, we identified **${rankedUrls.length} high-consensus resources**. Here's what the data reveals:`);
  lines.push('');
  
  if (thresholdNote) {
    lines.push(`> ${thresholdNote}`);
    lines.push('');
  }
  
  // Top Consensus Resources
  lines.push('### 🥇 Top Consensus Resources');
  lines.push('');
  
  for (const url of rankedUrls.slice(0, 20)) {
    const highConsensus = url.frequency >= 4 ? ' ⭐ HIGHEST CONSENSUS' : '';
    lines.push(`#### #${url.rank}: ${url.title} (Score: ${url.score.toFixed(1)})${highConsensus}`);
    
    // Appeared in queries
    const queriesList = url.queries.map(q => `"${q}"`).join(', ');
    lines.push(`- **Appeared in:** ${url.frequency} queries (${queriesList})`);
    
    // Best ranking
    lines.push(`- **Best ranking:** Position ${url.bestPosition}`);
    
    // Description (truncated snippet)
    const description = url.snippet.length > 200 
      ? url.snippet.substring(0, 197) + '...' 
      : url.snippet;
    lines.push(`- **Description:** ${description}`);
    
    // Justification
    lines.push(`- **Why it's #${url.rank}:** ${generateJustification(url, url.rank)}`);
    
    // URL
    lines.push(`- **URL:** ${url.url}`);
    lines.push('');
  }
  
  // Metadata section
  lines.push('---');
  lines.push('');
  lines.push('### 📈 Metadata');
  lines.push('');
  lines.push(`- **Total Queries:** ${allKeywords.length} (${allKeywords.join(', ')})`);
  
  // Sort all URLs by frequency for the unique URLs list
  const sortedByFreq = [...rankedUrls].sort((a, b) => b.frequency - a.frequency);
  const urlFreqList = sortedByFreq
    .slice(0, 30)
    .map(u => {
      const shortUrl = u.url.length > 40 ? u.url.substring(0, 37) + '...' : u.url;
      return `${shortUrl} (${u.frequency}x)`;
    })
    .join(', ');
  
  lines.push(`- **Unique URLs Found:** ${totalUniqueUrls} — top by frequency: ${urlFreqList}`);
  lines.push(`- **Consensus Threshold:** ≥${frequencyThreshold} appearances`);
  lines.push('');

  // Next Steps - actionable follow-up commands
  lines.push('---');
  lines.push('');
  lines.push('### ➡️ Next Steps');
  lines.push('');

  // Generate URL list for scrape_links command
  const topUrls = rankedUrls.slice(0, Math.min(5, rankedUrls.length));
  if (topUrls.length > 0) {
    const urlList = topUrls.map(u => `"${u.url}"`).join(', ');
    lines.push(`**Scrape top consensus URLs for full content:**`);
    lines.push('```');
    lines.push(`scrape_links(urls=[${urlList}], use_llm=true, what_to_extract="Extract key insights, recommendations, and actionable information")`);
    lines.push('```');
    lines.push('');
  }

  // Reddit follow-up
  lines.push(`**Get community perspective from Reddit:**`);
  lines.push('```');
  lines.push(`search_reddit(queries=["${allKeywords[0] || 'topic'} reddit", "${allKeywords[0] || 'topic'} recommendations", "${allKeywords[0] || 'topic'} best practices"])`);
  lines.push('```');
  lines.push('');

  // Deep research follow-up
  lines.push(`**Synthesize findings with deep research:**`);
  lines.push('```');
  lines.push(`deep_research(questions=[{question: "Based on web search results, what are the key findings, best practices, and recommendations for [topic]?"}])`);
  lines.push('```');
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Full aggregation pipeline with fallback thresholds
 * Tries ≥3, falls back to ≥2, then ≥1 if needed
 */
export function aggregateAndRank(
  searches: KeywordSearchResult[],
  minConsensusUrls: number = 5
): AggregationResult {
  const urlMap = aggregateResults(searches);
  const totalUniqueUrls = urlMap.size;
  const totalQueries = searches.length;

  // Try thresholds in order: 3, 2, 1
  const thresholds = [3, 2, 1];
  let rankedUrls: RankedUrl[] = [];
  let usedThreshold = 3;
  let thresholdNote: string | undefined;

  for (const threshold of thresholds) {
    const filtered = filterByFrequency(urlMap, threshold);
    rankedUrls = calculateWeightedScores(filtered);

    if (rankedUrls.length >= minConsensusUrls || threshold === 1) {
      usedThreshold = threshold;
      if (threshold < 3) {
        thresholdNote = `Note: Frequency filter lowered to ≥${threshold} due to result diversity.`;
      }
      break;
    }
  }

  return {
    rankedUrls,
    totalUniqueUrls,
    totalQueries,
    frequencyThreshold: usedThreshold,
    thresholdNote,
  };
}

/**
 * Build URL lookup map for quick consensus checking during result formatting
 */
export function buildUrlLookup(rankedUrls: RankedUrl[]): Map<string, RankedUrl> {
  const lookup = new Map<string, RankedUrl>();
  
  for (const url of rankedUrls) {
    const normalized = normalizeUrl(url.url);
    lookup.set(normalized, url);
    // Also store original URL
    lookup.set(url.url.toLowerCase(), url);
  }

  return lookup;
}

/**
 * Look up a URL in the ranked results
 */
export function lookupUrl(url: string, lookup: Map<string, RankedUrl>): RankedUrl | undefined {
  const normalized = normalizeUrl(url);
  return lookup.get(normalized) || lookup.get(url.toLowerCase());
}

// ============================================================================
// Reddit-Specific Aggregation
// ============================================================================

/**
 * Aggregated Reddit URL data structure
 */
interface AggregatedRedditUrl {
  url: string;
  title: string;
  snippet: string;
  date?: string;
  frequency: number;
  positions: number[];
  queries: string[];
  bestPosition: number;
  totalScore: number;
}

/**
 * Ranked Reddit URL with normalized score
 */
interface RankedRedditUrl {
  url: string;
  title: string;
  snippet: string;
  date?: string;
  rank: number;
  score: number;
  frequency: number;
  positions: number[];
  queries: string[];
  bestPosition: number;
  isConsensus: boolean;
}

/**
 * Reddit aggregation result
 */
interface RedditAggregationResult {
  rankedUrls: RankedRedditUrl[];
  totalUniqueUrls: number;
  totalQueries: number;
  frequencyThreshold: number;
  thresholdNote?: string;
}

/**
 * Aggregate Reddit search results from multiple queries
 */
function aggregateRedditResults(
  searches: Map<string, RedditSearchResult[]>
): Map<string, AggregatedRedditUrl> {
  const urlMap = new Map<string, AggregatedRedditUrl>();

  for (const [query, results] of searches) {
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const position = i + 1;
      const normalizedUrl = normalizeUrl(result.url);
      const existing = urlMap.get(normalizedUrl);

      if (existing) {
        existing.frequency += 1;
        existing.positions.push(position);
        existing.queries.push(query);
        const prevBest = existing.bestPosition;
        existing.bestPosition = Math.min(existing.bestPosition, position);
        existing.totalScore += getCtrWeight(position);
        // Keep best title/snippet (from highest ranking position)
        if (position < prevBest) {
          existing.title = result.title;
          existing.snippet = result.snippet;
          existing.date = result.date;
        }
      } else {
        urlMap.set(normalizedUrl, {
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          date: result.date,
          frequency: 1,
          positions: [position],
          queries: [query],
          bestPosition: position,
          totalScore: getCtrWeight(position),
        });
      }
    }
  }

  return urlMap;
}

/**
 * Filter Reddit URLs by minimum frequency
 */
function filterRedditByFrequency(
  urlMap: Map<string, AggregatedRedditUrl>,
  minFrequency: number
): AggregatedRedditUrl[] {
  const filtered: AggregatedRedditUrl[] = [];
  
  for (const url of urlMap.values()) {
    if (url.frequency >= minFrequency) {
      filtered.push(url);
    }
  }

  return filtered;
}

/**
 * Calculate weighted scores for Reddit URLs
 */
function calculateRedditWeightedScores(urls: AggregatedRedditUrl[]): RankedRedditUrl[] {
  if (urls.length === 0) return [];

  // Sort by total score descending
  const sorted = [...urls].sort((a, b) => b.totalScore - a.totalScore);

  // Find max score for normalization
  const maxScore = sorted[0].totalScore;

  // Map to ranked URLs with normalized scores
  return sorted.map((url, index) => ({
    url: url.url,
    title: url.title,
    snippet: url.snippet,
    date: url.date,
    rank: index + 1,
    score: maxScore > 0 ? (url.totalScore / maxScore) * 100 : 0,
    frequency: url.frequency,
    positions: url.positions,
    queries: url.queries,
    bestPosition: url.bestPosition,
    isConsensus: url.frequency >= 2, // Lower threshold for Reddit (often fewer results)
  }));
}

/**
 * Full Reddit aggregation pipeline with fallback thresholds
 */
export function aggregateAndRankReddit(
  searches: Map<string, RedditSearchResult[]>,
  minConsensusUrls: number = 3
): RedditAggregationResult {
  const urlMap = aggregateRedditResults(searches);
  const totalUniqueUrls = urlMap.size;
  const totalQueries = searches.size;

  // Try thresholds in order: 2, 1 (Reddit often has less overlap than web search)
  const thresholds = [2, 1];
  let rankedUrls: RankedRedditUrl[] = [];
  let usedThreshold = 2;
  let thresholdNote: string | undefined;

  for (const threshold of thresholds) {
    const filtered = filterRedditByFrequency(urlMap, threshold);
    rankedUrls = calculateRedditWeightedScores(filtered);

    if (rankedUrls.length >= minConsensusUrls || threshold === 1) {
      usedThreshold = threshold;
      if (threshold < 2 && totalQueries > 1) {
        thresholdNote = `Note: Frequency filter set to ≥${threshold} due to result diversity across queries.`;
      }
      break;
    }
  }

  return {
    rankedUrls,
    totalUniqueUrls,
    totalQueries,
    frequencyThreshold: usedThreshold,
    thresholdNote,
  };
}

/**
 * Generate enhanced output for Reddit aggregated results
 * Now includes both aggregated view AND per-query raw results
 */
export function generateRedditEnhancedOutput(
  aggregation: RedditAggregationResult,
  allQueries: string[],
  rawResults?: Map<string, RedditSearchResult[]>
): string {
  const { rankedUrls, totalUniqueUrls, frequencyThreshold, thresholdNote } = aggregation;
  const lines: string[] = [];

  // Header
  lines.push(`# 🔍 Reddit Search Results (Aggregated from ${allQueries.length} Queries)`);
  lines.push('');
  lines.push(`**Total Unique Posts:** ${totalUniqueUrls} | **Consensus Threshold:** ≥${frequencyThreshold} appearances`);
  lines.push('');

  if (thresholdNote) {
    lines.push(`> ${thresholdNote}`);
    lines.push('');
  }

  // Consensus section (URLs appearing in multiple queries)
  const consensusUrls = rankedUrls.filter(u => u.frequency >= frequencyThreshold && u.frequency > 1);
  if (consensusUrls.length > 0) {
    lines.push('## ⭐ High-Consensus Posts (Multiple Queries)');
    lines.push('');
    lines.push('*These posts appeared across multiple search queries, indicating high relevance:*');
    lines.push('');

    for (const url of consensusUrls) {
      const dateStr = url.date ? ` • 📅 ${url.date}` : '';
      const queriesList = url.queries.map(q => `"${q}"`).join(', ');
      lines.push(`### #${url.rank}: ${url.title}`);
      lines.push(`**Score:** ${url.score.toFixed(1)} | **Found in:** ${url.frequency} queries (${queriesList})${dateStr}`);
      lines.push(`${url.url}`);
      lines.push(`> ${url.snippet}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // All results ranked by CTR score
  lines.push('## 📊 All Results (CTR-Ranked)');
  lines.push('');

  for (const url of rankedUrls) {
    const dateStr = url.date ? ` • 📅 ${url.date}` : '';
    const consensusMarker = url.frequency > 1 ? ' ⭐' : '';
    lines.push(`**${url.rank}. ${url.title}**${consensusMarker}${dateStr}`);
    lines.push(`${url.url}`);
    lines.push(`> ${url.snippet}`);
    if (url.frequency > 1) {
      lines.push(`_Found in ${url.frequency} queries: ${url.queries.map(q => `"${q}"`).join(', ')}_`);
    }
    lines.push('');
  }

  // Per-Query Raw Results Section (NEW)
  if (rawResults && rawResults.size > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 📋 Per-Query Raw Results');
    lines.push('');
    lines.push('*Complete results for each individual query before aggregation:*');
    lines.push('');

    for (const [query, results] of rawResults) {
      lines.push(`### 🔎 Query: "${query}"`);
      lines.push(`**Results:** ${results.length} posts`);
      lines.push('');

      if (results.length === 0) {
        lines.push('_No results found for this query._');
        lines.push('');
        continue;
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const position = i + 1;
        const dateStr = result.date ? ` • 📅 ${result.date}` : '';
        lines.push(`${position}. **${result.title}**${dateStr}`);
        lines.push(`   ${result.url}`);
        lines.push(`   > ${result.snippet}`);
        lines.push('');
      }
    }
  }

  // Metadata
  lines.push('---');
  lines.push('');
  lines.push('### 📈 Search Metadata');
  lines.push('');
  lines.push(`- **Queries:** ${allQueries.map(q => `"${q}"`).join(', ')}`);
  lines.push(`- **Unique Posts Found:** ${totalUniqueUrls}`);
  lines.push(`- **High-Consensus Posts:** ${consensusUrls.length}`);
  lines.push('');

  // Next Steps - actionable follow-up commands that form a research loop
  lines.push('---');
  lines.push('');
  lines.push('### ➡️ Next Steps (DO ALL OF THESE — research is iterative)');
  lines.push('');

  // IMMEDIATE: Fetch raw comments
  const topUrls = rankedUrls.slice(0, Math.min(10, rankedUrls.length));
  if (topUrls.length >= 2) {
    const urlList = topUrls.map(u => `"${u.url}"`).join(', ');
    lines.push(`**1. IMMEDIATE — Fetch raw comments (best insights are in comments):**`);
    lines.push('```');
    lines.push(`get_reddit_post(urls=[${urlList}], fetch_comments=true)`);
    lines.push('```');
    lines.push('');
  }

  // VERIFY: Cross-check community claims with web search
  const topicKeyword = allQueries[0] || 'topic';
  lines.push(`**2. VERIFY — Cross-check Reddit claims with web search:**`);
  lines.push('```');
  lines.push(`web_search(keywords=["${topicKeyword} official docs", "${topicKeyword} best practices 2025", "${topicKeyword} comparison benchmark"])`);
  lines.push('```');
  lines.push('');

  // DEEP DIVE: Scrape external links referenced in posts
  lines.push(`**3. DEEP DIVE — If posts reference external links/docs, scrape them:**`);
  lines.push('```');
  lines.push(`scrape_links(urls=[...URLs mentioned in Reddit posts...], use_llm=true, what_to_extract="Extract key findings | recommendations | data points | comparisons")`);
  lines.push('```');
  lines.push('');

  // SYNTHESIZE: Only after gathering raw data
  lines.push(`**4. SYNTHESIZE — Only after steps 1-3:**`);
  lines.push('```');
  lines.push(`deep_research(questions=[{question: "Based on Reddit discussions and web verification about [topic], what are the validated recommendations?"}])`);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}
