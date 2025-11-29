/**
 * LLM Processor for content extraction
 * Uses OpenRouter via OPENROUTER_API_KEY for AI-powered content filtering
 */

import OpenAI from 'openai';
import { RESEARCH, LLM_EXTRACTION, getCapabilities } from '../config/index.js';

interface ProcessingConfig {
  use_llm: boolean;
  what_to_extract: string | undefined;
  max_tokens?: number;
}

interface LLMResult {
  content: string;
  processed: boolean;
  error?: string;
}

let llmClient: OpenAI | null = null;

export function createLLMProcessor(): OpenAI | null {
  if (!getCapabilities().llmExtraction) return null;
  
  if (!llmClient) {
    llmClient = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: 120000,
    });
  }
  return llmClient;
}

export async function processContentWithLLM(
  content: string,
  config: ProcessingConfig,
  processor?: OpenAI | null
): Promise<LLMResult> {
  if (!config.use_llm || !processor || !content?.trim()) {
    return { content, processed: false };
  }

  const prompt = config.what_to_extract
    ? `Extract and clean the following content. Focus on: ${config.what_to_extract}\n\nContent:\n${content}`
    : `Clean and extract the main content from the following text, removing navigation, ads, and irrelevant elements:\n\n${content}`;

  try {
    console.error(`[LLM Processor] Using model: ${LLM_EXTRACTION.MODEL}, max_tokens: ${config.max_tokens || LLM_EXTRACTION.MAX_TOKENS}, reasoning: ${LLM_EXTRACTION.ENABLE_REASONING}`);
    
    // Build request body with reasoning support for gpt-oss models
    const requestBody: any = {
      model: LLM_EXTRACTION.MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: config.max_tokens || LLM_EXTRACTION.MAX_TOKENS,
    };

    // Add reasoning parameter if enabled (for models that support it like gpt-oss-120b)
    if (LLM_EXTRACTION.ENABLE_REASONING) {
      requestBody.reasoning = { enabled: true };
    }

    const response = await processor.chat.completions.create(requestBody);

    const result = response.choices?.[0]?.message?.content;
    if (result) {
      console.error(`[LLM Processor] Successfully extracted ${result.length} characters`);
      return { content: result, processed: true };
    }
    return { content, processed: false, error: 'No content in response' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[LLM Processor] Error: ${error}`);
    return { content, processed: false, error };
  }
}
