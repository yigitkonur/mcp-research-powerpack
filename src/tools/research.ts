/**
 * Deep Research Tool Handler - Batch processing with dynamic token allocation
 * Implements robust error handling that NEVER crashes
 */

import type { DeepResearchParams } from '../schemas/deep-research.js';
import { ResearchClient, type ResearchResponse } from '../clients/research.js';
import { FileAttachmentService } from '../services/file-attachment.js';
import { RESEARCH } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';

// Constants
const TOTAL_TOKEN_BUDGET = 32000;
const MIN_QUESTIONS = 1; // Allow single question for flexibility
const MAX_QUESTIONS = 10;

interface ResearchOptions {
  sessionId?: string;
  logger?: (level: 'info' | 'error' | 'debug', message: string, sessionId: string) => Promise<void>;
}

interface QuestionResult {
  question: string;
  content: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
}

function calculateTokenAllocation(questionCount: number): number {
  if (questionCount <= 0) return TOTAL_TOKEN_BUDGET;
  return Math.floor(TOTAL_TOKEN_BUDGET / questionCount);
}

/**
 * Safe logger wrapper - NEVER throws
 */
async function safeLog(
  logger: ResearchOptions['logger'],
  sessionId: string | undefined,
  level: 'info' | 'error' | 'debug',
  message: string
): Promise<void> {
  if (!logger || !sessionId) return;
  try {
    await logger(level, message, sessionId);
  } catch {
    console.error(`[Research Tool] Logger failed: ${message}`);
  }
}

const SYSTEM_PROMPT = `You are an expert research consultant. Provide evidence-based, multi-perspective analysis.

METHODOLOGY:
- SOURCE DIVERSITY: Official docs, papers, blogs, case studies
- CURRENT + HISTORICAL: Latest developments AND context
- MULTIPLE PERSPECTIVES: Different approaches with pros/cons
- EVIDENCE-BASED: Claims backed by citations

FORMAT (high info density):
- CURRENT STATE: Status quo, what we know
- KEY INSIGHTS: Most important findings with evidence
- TRADE-OFFS: Competing priorities honestly analyzed
- PRACTICAL IMPLICATIONS: Real-world application
- WHAT'S CHANGING: Recent developments

Be dense with insights, light on filler. Use examples and citations.`;

/**
 * Handle deep research request
 * NEVER throws - always returns a valid response
 */
export async function handleDeepResearch(
  params: DeepResearchParams,
  options: ResearchOptions = {}
): Promise<{ content: string; structuredContent: object }> {
  const { sessionId, logger } = options;
  const questions = params.questions || [];

  // Validation
  if (questions.length < MIN_QUESTIONS) {
    return {
      content: `# ❌ Error\n\nMinimum ${MIN_QUESTIONS} research question(s) required. Received: ${questions.length}`,
      structuredContent: { error: true, message: `Minimum ${MIN_QUESTIONS} question(s) required` },
    };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      content: `# ❌ Error\n\nMaximum ${MAX_QUESTIONS} research questions allowed. Received: ${questions.length}`,
      structuredContent: { error: true, message: `Maximum ${MAX_QUESTIONS} questions allowed` },
    };
  }

  const tokensPerQuestion = calculateTokenAllocation(questions.length);

  await safeLog(logger, sessionId, 'info', `Starting batch research: ${questions.length} questions, ${tokensPerQuestion.toLocaleString()} tokens/question`);

  // Initialize client safely
  let client: ResearchClient;
  try {
    client = new ResearchClient();
  } catch (error) {
    const err = classifyError(error);
    return {
      content: `# ❌ Error\n\nFailed to initialize research client: ${err.message}`,
      structuredContent: { error: true, message: `Failed to initialize: ${err.message}` },
    };
  }

  const fileService = new FileAttachmentService();
  const results: QuestionResult[] = [];

  // Process questions with bounded concurrency (max 3 concurrent LLM calls)
  // Each research call involves web search + LLM processing, so unbounded parallelism
  // causes CPU spikes and potential rate limiting on the LLM provider.
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
          console.error(`[Research] Failed to process attachments for question ${index + 1}`);
        }
      }

      // ResearchClient.research() now returns error in response instead of throwing
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
      // This catch is a safety net - ResearchClient should not throw
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

  let markdown = `# Deep Research Results (${questions.length} questions)\n\n`;
  markdown += `**Token Allocation:** ${tokensPerQuestion.toLocaleString()} tokens/question (${questions.length} questions, ${TOTAL_TOKEN_BUDGET.toLocaleString()} total budget)\n`;
  markdown += `**Status:** ✅ ${successful.length} successful | ❌ ${failed.length} failed | 📊 ${totalTokens.toLocaleString()} tokens used\n\n`;
  markdown += `---\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    markdown += `## Question ${i + 1}: ${r.question.substring(0, 100)}${r.question.length > 100 ? '...' : ''}\n\n`;

    if (r.success) {
      markdown += r.content + '\n\n';
      if (r.tokensUsed) {
        markdown += `_Tokens used: ${r.tokensUsed.toLocaleString()}_\n\n`;
      }
    } else {
      markdown += `**❌ Error:** ${r.error}\n\n`;
    }

    markdown += `---\n\n`;
  }

  await safeLog(logger, sessionId, 'info', `Research completed: ${successful.length}/${questions.length} successful, ${totalTokens.toLocaleString()} tokens`);

  return {
    content: markdown.trim(),
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
