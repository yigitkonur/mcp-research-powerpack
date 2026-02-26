import { z } from 'zod';

// URL schema with protocol validation
const urlSchema = z
  .string({ required_error: 'scrape_links: URL is required' })
  .url({ message: 'scrape_links: Invalid URL format' })
  .refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'scrape_links: URL must use http:// or https:// protocol' }
  );

// Input schema for scrape_links tool
const scrapeLinksParamsShape = {
  urls: z
    .array(urlSchema, {
      required_error: 'scrape_links: URLs array is required',
      invalid_type_error: 'scrape_links: URLs must be an array'
    })
    .min(1, { message: 'scrape_links: At least 1 URL is required' })
    .max(50, { message: 'scrape_links: Maximum 50 URLs allowed per request' })
    .describe('URLs to scrape (1-50). Recommend 3-5 URLs for balanced depth/breadth. More URLs = broader coverage but fewer tokens per URL. 3 URLs: ~10K tokens each (deep); 10 URLs: ~3K tokens each (balanced); 50 URLs: ~640 tokens each (scan).'),
  timeout: z
    .number({ invalid_type_error: 'scrape_links: Timeout must be a number' })
    .min(5, { message: 'scrape_links: Timeout must be at least 5 seconds' })
    .max(120, { message: 'scrape_links: Timeout cannot exceed 120 seconds' })
    .default(30)
    .describe('Timeout in seconds for each URL'),
  use_llm: z
    .boolean({ invalid_type_error: 'scrape_links: use_llm must be a boolean' })
    .default(true)
    .describe('AI extraction enabled by default (requires OPENROUTER_API_KEY). Auto-filters nav/ads/footers, extracts ONLY what you specify. Set false only for raw HTML debugging.'),
  what_to_extract: z
    .string()
    .max(1000, { message: 'scrape_links: Extraction instructions too long (max 1000 characters)' })
    .optional()
    .describe('Extraction instructions for AI. Will be wrapped with compression prefix+suffix automatically. Formula: "Extract [target1] | [target2] | [target3] with focus on [aspect1], [aspect2]". Min 3 targets with | separator. Be specific (pricing tiers not pricing). Aim 5-10 targets.'),
  model: z
    .string()
    .max(200, { message: 'scrape_links: Model name too long (max 200 characters)' })
    .optional()
    .describe('Override the LLM extraction model for this request. Uses OpenRouter model IDs (e.g. "openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"). Default: openai/gpt-oss-120b:nitro (configurable via LLM_EXTRACTION_MODEL env var).'),
};

export const scrapeLinksParamsSchema = z.object(scrapeLinksParamsShape);
export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

// Output type
export interface ScrapeLinksOutput {
  content: string;
  metadata: {
    total_urls: number;
    successful: number;
    failed: number;
    total_credits: number;
    execution_time_ms: number;
    tokens_per_url?: number;
    total_token_budget?: number;
    batches_processed?: number;
  };
}
