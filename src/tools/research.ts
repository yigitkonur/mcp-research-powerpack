/**
 * Deep Research Tool Handler - Batch processing with dynamic token allocation
 * Implements robust error handling that NEVER crashes
 */

import type { DeepResearchParams } from '../schemas/deep-research.js';
import { ResearchClient, type ResearchResponse } from '../clients/research.js';
import { FileAttachmentService } from '../services/file-attachment.js';
import { RESEARCH, RESEARCH_PROMPTS } from '../config/index.js';
import { getToolConfig } from '../config/loader.js';
import { classifyError } from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatDuration,
  truncateText,
  TOKEN_BUDGETS,
  calculateTokenAllocation,
} from './utils.js';

// Constants
const MIN_QUESTIONS = 1; // Allow single question for flexibility
const MAX_QUESTIONS = 10;

interface QuestionResult {
  question: string;
  content: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
}

const SYSTEM_PROMPT = `Expert research engine. Multi-source: docs, papers, blogs, case studies. Cite inline [source].

FORMAT RULES:
- For comparisons/features/structured data → use markdown table |Col|Col|Col|
- For narrative/diagnostic/explanation → tight numbered bullets, no prose paragraphs
- No intro, no greeting, no conclusion, no meta-commentary
- No filler phrases: "it is worth noting", "overall", "in conclusion", "importantly"
- Every sentence = fact, data point, or actionable insight
- First line of output = content (never a preamble)`;

// Get research suffix from YAML config (fallback to hardcoded)
function getResearchSuffix(): string {
  const config = getToolConfig('deep_research');
  const suffix = config?.limits?.research_suffix;
  return typeof suffix === 'string' ? suffix : RESEARCH_PROMPTS.SUFFIX;
}

function wrapQuestionWithCompression(question: string): string {
  return `${question}\n\n${getResearchSuffix()}`;
}

/**
 * Handle deep research request
 * NEVER throws - always returns a valid response
 */
export async function handleDeepResearch(
  params: DeepResearchParams
): Promise<{ content: string; structuredContent: object }> {
  const startTime = Date.now();
  const questions = params.questions || [];

  // Validation
  if (questions.length < MIN_QUESTIONS) {
    return {
      content: formatError({
        code: 'MIN_QUESTIONS',
        message: `Minimum ${MIN_QUESTIONS} research question(s) required. Received: ${questions.length}`,
        toolName: 'deep_research',
        howToFix: ['Add at least one question with detailed context following the template: WHAT I NEED, WHY, WHAT I KNOW, SPECIFIC QUESTIONS'],
      }),
      structuredContent: { error: true, message: `Minimum ${MIN_QUESTIONS} question(s) required` },
    };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      content: formatError({
        code: 'MAX_QUESTIONS',
        message: `Maximum ${MAX_QUESTIONS} research questions allowed. Received: ${questions.length}`,
        toolName: 'deep_research',
        howToFix: [`Remove ${questions.length - MAX_QUESTIONS} question(s)`],
      }),
      structuredContent: { error: true, message: `Maximum ${MAX_QUESTIONS} questions allowed` },
    };
  }

  const tokensPerQuestion = calculateTokenAllocation(questions.length, TOKEN_BUDGETS.RESEARCH);

  mcpLog('info', `Starting batch research: ${questions.length} questions, ${tokensPerQuestion.toLocaleString()} tokens/question`, 'research');

  // Initialize client safely
  let client: ResearchClient;
  try {
    client = new ResearchClient();
  } catch (error) {
    const err = classifyError(error);
    return {
      content: formatError({
        code: 'CLIENT_INIT_FAILED',
        message: `Failed to initialize research client: ${err.message}`,
        toolName: 'deep_research',
        howToFix: ['Check OPENROUTER_API_KEY is set'],
        alternatives: [
          'web_search(keywords=["topic best practices", "topic guide", "topic comparison 2025"]) — uses Serper API (different key), search for information directly',
          'search_reddit(queries=["topic recommendations", "topic experience", "topic discussion"]) — uses Serper API, get community perspective',
          'scrape_links(urls=[...any relevant URLs...], use_llm=true) — if you have URLs, scrape them for content (uses Firecrawl + OpenRouter, may also fail if OpenRouter key is the issue)',
        ],
      }),
      structuredContent: { error: true, message: `Failed to initialize: ${err.message}` },
    };
  }

  const fileService = new FileAttachmentService();
  const results: QuestionResult[] = [];

  // Process questions with bounded concurrency (max 3 concurrent LLM calls)
  const allResults = await pMap(questions, async (q, index): Promise<QuestionResult> => {
    try {
      // Enhance question with file attachments if present
      let enhancedQuestion = q.question;
      if (q.file_attachments && q.file_attachments.length > 0) {
        try {
          const attachmentsMarkdown = await fileService.formatAttachments(q.file_attachments);
          enhancedQuestion = q.question + attachmentsMarkdown;
        } catch {
          // If attachment processing fails, continue with original question
          mcpLog('warning', `Failed to process attachments for question ${index + 1}`, 'research');
        }
      }

      // Append compression suffix for info density constraints
      enhancedQuestion = wrapQuestionWithCompression(enhancedQuestion);

      // ResearchClient.research() returns error in response instead of throwing
      const response = await client.research({
        question: enhancedQuestion,
        systemPrompt: SYSTEM_PROMPT,
        reasoningEffort: RESEARCH.REASONING_EFFORT,
        maxSearchResults: Math.min(RESEARCH.MAX_URLS, 20),
        maxTokens: tokensPerQuestion,
      });

      // Check if response contains an error
      if (response.error) {
        return {
          question: q.question,
          content: response.content || '',
          success: false,
          error: response.error.message,
        };
      }

      return {
        question: q.question,
        content: response.content || '',
        success: !!response.content,
        tokensUsed: response.usage?.totalTokens,
        error: response.content ? undefined : 'Empty response received',
      };
    } catch (error) {
      // Safety net - ResearchClient should not throw
      const structuredError = classifyError(error);
      return {
        question: q.question,
        content: '',
        success: false,
        error: structuredError.message,
      };
    }
  }, 3); // Max 3 concurrent research calls

  results.push(...allResults);

  // Build markdown output
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
  const executionTime = Date.now() - startTime;

  // Build 70/20/10 response
  const batchHeader = formatBatchHeader({
    title: `Deep Research Results`,
    totalItems: questions.length,
    successful: successful.length,
    failed: failed.length,
    tokensPerItem: tokensPerQuestion,
    extras: {
      'Total tokens used': totalTokens.toLocaleString(),
    },
  });

  // Build questions data section
  const questionsData: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const preview = truncateText(r.question, 100);
    questionsData.push(`## Question ${i + 1}: ${preview}\n`);

    if (r.success) {
      questionsData.push(r.content);
      if (r.tokensUsed) {
        questionsData.push(`\n*Tokens used: ${r.tokensUsed.toLocaleString()}*`);
      }
    } else {
      questionsData.push(`**❌ Error:** ${r.error}`);
    }
    questionsData.push('\n---\n');
  }

  const nextSteps = [
    successful.length > 0 ? 'SCRAPE CITED SOURCES: scrape_links(urls=[...URLs cited in research above...], use_llm=true, what_to_extract="Extract evidence | data | methodology | conclusions") — verify research citations with primary sources' : null,
    successful.length > 0 ? 'COMMUNITY VALIDATION: search_reddit(queries=["topic findings", "topic real experience", "topic criticism"]) — check if community agrees with research findings' : null,
    successful.length > 0 ? 'ITERATE: If research revealed gaps or new questions, run deep_research again with refined questions targeting those gaps' : null,
    successful.length > 0 ? 'WEB VERIFY: web_search(keywords=["specific claim from research", "topic latest data 2025"]) — if claims need independent verification' : null,
    failed.length > 0 ? 'Retry failed questions with more specific context' : null,
  ].filter(Boolean) as string[];

  const formattedContent = formatSuccess({
    title: `Research Complete (${successful.length}/${questions.length})`,
    summary: batchHeader,
    data: questionsData.join('\n'),
    nextSteps,
    metadata: {
      'Execution time': formatDuration(executionTime),
      'Token budget': TOKEN_BUDGETS.RESEARCH.toLocaleString(),
    },
  });

  mcpLog('info', `Research completed: ${successful.length}/${questions.length} successful, ${totalTokens.toLocaleString()} tokens`, 'research');

  return {
    content: formattedContent,
    structuredContent: {
      totalQuestions: questions.length,
      successful: successful.length,
      failed: failed.length,
      tokensPerQuestion,
      totalTokensUsed: totalTokens,
      results,
    },
  };
}
