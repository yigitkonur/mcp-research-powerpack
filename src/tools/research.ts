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
        message: `You sent ${questions.length} question(s) but need at least ${MIN_QUESTIONS}. Add ${MIN_QUESTIONS - questions.length} more question(s) and call deep_research again.`,
        toolName: 'deep_research',
        howToFix: [
          `Add at least ${MIN_QUESTIONS - questions.length} more question(s) following the structured template: WHAT I NEED → WHY → WHAT I KNOW → HOW I'LL USE → SPECIFIC QUESTIONS`,
          'Each question should target a different angle of your research topic for maximum coverage',
          'Then call deep_research again immediately with the expanded questions array',
        ],
        alternatives: [
          'web_search(keywords=["topic overview", "topic best practices", "topic guide"]) — gather context first, then formulate better research questions',
          'search_reddit(queries=["topic discussion", "topic recommendations"]) — get community perspective while you refine your questions',
        ],
      }),
      structuredContent: { error: true, message: `Need ${MIN_QUESTIONS - questions.length} more question(s). Add them and retry.` },
    };
  }
  if (questions.length > MAX_QUESTIONS) {
    const excess = questions.length - MAX_QUESTIONS;
    const batches = Math.ceil(questions.length / MAX_QUESTIONS);
    return {
      content: formatError({
        code: 'MAX_QUESTIONS',
        message: `You sent ${questions.length} questions but the maximum per call is ${MAX_QUESTIONS}. You have ${excess} too many.`,
        toolName: 'deep_research',
        howToFix: [
          `Split into ${batches} separate deep_research calls of ~${Math.ceil(questions.length / batches)} questions each`,
          `Call deep_research with the first ${MAX_QUESTIONS} questions NOW, then call again with the remaining ${excess}`,
          'Each call gets its own 32K token budget, so splitting actually gives you MORE tokens total',
        ],
      }),
      structuredContent: { error: true, message: `Split into ${batches} calls of ${MAX_QUESTIONS} questions each` },
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
        message: `Cannot start research — OpenRouter client failed to initialize: ${err.message}`,
        toolName: 'deep_research',
        howToFix: [
          'Set the OPENROUTER_API_KEY environment variable — get a key at https://openrouter.ai/keys',
          'If the key is set, verify it hasn\'t expired or been revoked',
          'Once fixed, call deep_research again with the same questions',
        ],
        alternatives: [
          'web_search(keywords=["topic best practices", "topic guide", "topic comparison 2025"]) — uses Serper API (completely different service), will work even if OpenRouter is down',
          'search_reddit(queries=["topic recommendations", "topic experience", "topic discussion"]) — uses Serper API, get real community perspective',
          'scrape_links(urls=[...any relevant URLs...], use_llm=false) — scrape without AI extraction (still gets raw content, no OpenRouter needed)',
        ],
      }),
      structuredContent: { error: true, message: `OpenRouter init failed: ${err.message}. Use web_search or search_reddit instead.` },
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
    successful.length > 0 ? 'VERIFY CITATIONS: The research above cites sources — but are they accurate? scrape_links(urls=[...cited URLs from research above...], use_llm=true, what_to_extract="Extract evidence | data | methodology | conclusions") — AI research can hallucinate citations. Verify the actual source content matches what was claimed.' : null,
    successful.length > 0 ? 'REALITY CHECK: search_reddit(queries=["topic real experience", "topic problems", "topic criticism", "topic vs alternatives"]) — research gives you the textbook answer. Reddit gives you what actually happens in production. These often differ dramatically.' : null,
    successful.length > 0 ? 'FOUND GAPS? Research almost always reveals unknowns you didn\'t anticipate. If the answers above mention topics, tradeoffs, or alternatives you hadn\'t considered — run deep_research again with NEW questions targeting those gaps. First-pass research is a starting point, not the final answer.' : null,
    successful.length > 0 ? 'CROSS-CHECK KEY CLAIMS: web_search(keywords=["specific claim from research", "topic latest benchmarks 2025", "topic official docs"]) — independent verification prevents you from building on incorrect assumptions.' : null,
    failed.length > 0 ? `RETRY FAILURES: ${failed.length} question(s) failed. Retry with more specific context, or split complex questions into simpler sub-questions. Each retry gets a fresh token budget.` : null,
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
