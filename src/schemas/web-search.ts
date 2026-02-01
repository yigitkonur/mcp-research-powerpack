import { z } from 'zod';

// Keyword schema with validation
const keywordSchema = z
  .string({ required_error: 'web_search: Keyword is required' })
  .min(1, { message: 'web_search: Keyword cannot be empty' })
  .max(500, { message: 'web_search: Keyword too long (max 500 characters)' })
  .refine(
    k => k.trim().length > 0,
    { message: 'web_search: Keyword cannot be whitespace only' }
  );

// Input schema for web_search tool
const keywordsSchema = z
  .array(keywordSchema, {
    required_error: 'web_search: Keywords array is required',
    invalid_type_error: 'web_search: Keywords must be an array'
  })
  .min(3, { message: 'web_search: MINIMUM 3 keywords required. Add more diverse keywords covering different perspectives.' })
  .max(100, { message: 'web_search: Maximum 100 keywords allowed per request' })
  .describe('Array of search keywords (MINIMUM 3, RECOMMENDED 5-7, MAX 100). Each keyword runs as a separate Google search in parallel. Use diverse keywords covering different angles for comprehensive results.');

const webSearchParamsShape = {
  keywords: keywordsSchema,
};

export const webSearchParamsSchema = z.object(webSearchParamsShape);
export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

// Output type
export interface WebSearchOutput {
  content: string;
  metadata: {
    total_keywords: number;
    total_results: number;
    execution_time_ms: number;
    total_unique_urls?: number;
    consensus_url_count?: number;
    frequency_threshold?: number;
    errorCode?: string; // MCP error code for programmatic handling (on failure)
  };
}
