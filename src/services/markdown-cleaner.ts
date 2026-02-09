/**
 * Markdown cleaner service using Turndown for HTML to Markdown conversion
 */
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Remove script, style, nav, footer, aside elements
turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'noscript']);

// ~512K characters (not bytes) - prevents event loop blocking on huge pages
const MAX_HTML_SIZE = 512 * 1024;

/**
 * Remove HTML comments using linear-time indexOf loop.
 * Avoids catastrophic backtracking from /<!--[\s\S]*?-->/g on malformed HTML.
 */
function removeHtmlComments(html: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < html.length) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) { parts.push(html.substring(pos)); break; }
    if (start > pos) parts.push(html.substring(pos, start));
    const end = html.indexOf('-->', start + 4);
    if (end === -1) {
      parts.push(html.substring(start)); // preserve unclosed comment + rest
      break;
    }
    pos = end + 3;
  }
  return parts.join('');
}

export class MarkdownCleaner {
  /**
   * Process HTML content and convert to clean Markdown
   * NEVER throws - returns original content on any error for graceful degradation
   */
  processContent(htmlContent: string): string {
    try {
      // Handle null/undefined/non-string inputs gracefully
      if (!htmlContent || typeof htmlContent !== 'string') {
        return htmlContent || '';
      }

      // If already markdown (no HTML tags), return as-is
      if (!htmlContent.includes('<')) {
        return htmlContent.trim();
      }

      // Truncate oversized HTML to prevent blocking the event loop
      if (htmlContent.length > MAX_HTML_SIZE) {
        htmlContent = htmlContent.substring(0, MAX_HTML_SIZE);
      }

      // Remove HTML comments before conversion (linear-time)
      let content = removeHtmlComments(htmlContent);

      // Convert HTML to Markdown using Turndown
      content = turndown.turndown(content);

      // Clean up whitespace
      content = content.replace(/\n{3,}/g, '\n\n');
      content = content.trim();

      return content;
    } catch (error) {
      // Log error but don't crash - return original content for graceful degradation
      console.error(
        '[MarkdownCleaner] processContent failed:',
        error instanceof Error ? error.message : String(error),
        '| Content length:',
        htmlContent?.length ?? 0
      );
      // Return original content if conversion fails
      return htmlContent || '';
    }
  }
}
