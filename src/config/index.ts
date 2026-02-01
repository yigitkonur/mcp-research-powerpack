/**
 * Consolidated configuration
 * All environment variables, constants, and LLM config in one place
 */

import { VERSION, PACKAGE_NAME, PACKAGE_DESCRIPTION } from '../version.js';

// Import version utilities (not re-exported - use directly from version.ts if needed externally)

// ============================================================================
// Safe Integer Parsing Helper
// ============================================================================

/**
 * Safely parse an integer from environment variable with bounds checking
 * @param value - The string value to parse (from process.env)
 * @param defaultVal - Default value if parsing fails or value is undefined
 * @param min - Minimum allowed value (clamped if below)
 * @param max - Maximum allowed value (clamped if above)
 * @returns Parsed integer within bounds, or default value
 */
function safeParseInt(
  value: string | undefined,
  defaultVal: number,
  min: number,
  max: number
): number {
  if (!value) {
    return defaultVal;
  }
  
  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed)) {
    console.warn(`[Config] Invalid number "${value}", using default ${defaultVal}`);
    return defaultVal;
  }
  
  if (parsed < min) {
    console.warn(`[Config] Value ${parsed} below minimum ${min}, clamping to ${min}`);
    return min;
  }
  
  if (parsed > max) {
    console.warn(`[Config] Value ${parsed} above maximum ${max}, clamping to ${max}`);
    return max;
  }
  
  return parsed;
}

// ============================================================================
// Environment Parsing
// ============================================================================

interface EnvConfig {
  SCRAPER_API_KEY: string;
  SEARCH_API_KEY: string | undefined;
  REDDIT_CLIENT_ID: string | undefined;
  REDDIT_CLIENT_SECRET: string | undefined;
}

let cachedEnv: EnvConfig | null = null;

export function parseEnv(): EnvConfig {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    SCRAPER_API_KEY: process.env.SCRAPEDO_API_KEY || '',
    SEARCH_API_KEY: process.env.SERPER_API_KEY || undefined,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || undefined,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || undefined,
  };
  return cachedEnv;
}

// ============================================================================
// Research API Configuration
// ============================================================================

export const RESEARCH = {
  BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  MODEL: process.env.RESEARCH_MODEL || 'x-ai/grok-4-fast',
  FALLBACK_MODEL: process.env.RESEARCH_FALLBACK_MODEL || 'google/gemini-2.5-flash',
  API_KEY: process.env.OPENROUTER_API_KEY || '',
  // Timeout: min 1s, max 1hr, default 30min
  TIMEOUT_MS: safeParseInt(process.env.API_TIMEOUT_MS, 1800000, 1000, 3600000),
  REASONING_EFFORT: (process.env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high',
  // Max URLs in search results: min 10, max 200, default 100
  MAX_URLS: safeParseInt(process.env.DEFAULT_MAX_URLS, 100, 10, 200),
} as const;

// ============================================================================
// MCP Server Configuration
// ============================================================================

// Version is now automatically read from package.json via version.ts
// No need to manually update version strings anymore!
export const SERVER = {
  NAME: PACKAGE_NAME,
  VERSION: VERSION,
  DESCRIPTION: PACKAGE_DESCRIPTION,
} as const;

// ============================================================================
// Capability Detection (which features are available based on ENV)
// ============================================================================

export interface Capabilities {
  reddit: boolean;        // REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
  search: boolean;        // SERPER_API_KEY
  scraping: boolean;      // SCRAPEDO_API_KEY
  deepResearch: boolean;  // OPENROUTER_API_KEY
  llmExtraction: boolean; // OPENROUTER_API_KEY (for what_to_extract in scraping)
}

export function getCapabilities(): Capabilities {
  const env = parseEnv();
  return {
    reddit: !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET),
    search: !!env.SEARCH_API_KEY,
    scraping: !!env.SCRAPER_API_KEY,
    deepResearch: !!RESEARCH.API_KEY,
    llmExtraction: !!RESEARCH.API_KEY, // Reuses OPENROUTER for LLM extraction
  };
}

export function getMissingEnvMessage(capability: keyof Capabilities): string {
  const messages: Record<keyof Capabilities, string> = {
    reddit: '❌ **Reddit tools unavailable.** Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` to enable.\n\n👉 Create a Reddit app at: https://www.reddit.com/prefs/apps (select "script" type)',
    search: '❌ **Search unavailable.** Set `SERPER_API_KEY` to enable web search and Reddit search.\n\n👉 Get your free API key at: https://serper.dev (2,500 free queries)',
    scraping: '❌ **Web scraping unavailable.** Set `SCRAPEDO_API_KEY` to enable URL content extraction.\n\n👉 Sign up at: https://scrape.do (1,000 free credits)',
    deepResearch: '❌ **Deep research unavailable.** Set `OPENROUTER_API_KEY` to enable AI-powered research.\n\n👉 Get your API key at: https://openrouter.ai/keys',
    llmExtraction: '⚠️ **AI extraction disabled.** The `use_llm` and `what_to_extract` features require `OPENROUTER_API_KEY`.\n\nScraping will work but without intelligent content filtering.',
  };
  return messages[capability];
}

// ============================================================================
// Scraper Configuration (Scrape.do implementation)
// ============================================================================

export const SCRAPER = {
  MAX_CONCURRENT: 30,
  BATCH_SIZE: 30,
  MAX_TOKENS_BUDGET: 32000,
  MIN_URLS: 3,
  MAX_URLS: 50,
  RETRY_COUNT: 3,
  RETRY_DELAYS: [2000, 4000, 8000] as const,
  EXTRACTION_SUFFIX: 'Try to answer this information as comprehensive as possible while keeping info density super high without adding unnecessary words but satisfy the scope defined by previous instructions even more.',
} as const;

// ============================================================================
// Reddit Configuration
// ============================================================================

export const REDDIT = {
  MAX_CONCURRENT: 10,
  BATCH_SIZE: 10,
  MAX_COMMENT_BUDGET: 1000,
  MAX_COMMENTS_PER_POST: 200,
  MIN_POSTS: 2,
  MAX_POSTS: 50,
  RETRY_COUNT: 5,
  RETRY_DELAYS: [2000, 4000, 8000, 16000, 32000] as const,
} as const;

// ============================================================================
// CTR Weights for URL Ranking (inspired from CTR research)
// ============================================================================

export const CTR_WEIGHTS: Record<number, number> = {
  1: 100.00,
  2: 60.00,
  3: 48.89,
  4: 33.33,
  5: 28.89,
  6: 26.44,
  7: 24.44,
  8: 17.78,
  9: 13.33,
  10: 12.56,
} as const;

// ============================================================================
// LLM Extraction Model (uses OPENROUTER for scrape_links AI extraction)
// ============================================================================

export const LLM_EXTRACTION = {
  MODEL: process.env.LLM_EXTRACTION_MODEL || 'openai/gpt-oss-120b:nitro',
  MAX_TOKENS: 8000,
  ENABLE_REASONING: process.env.LLM_ENABLE_REASONING !== 'false', // Default true, can be disabled with 'false'
} as const;
