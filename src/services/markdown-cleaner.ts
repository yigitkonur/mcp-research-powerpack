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

export class MarkdownCleaner {
  processContent(htmlContent: string): string {
    if (!htmlContent || typeof htmlContent !== 'string') {
      return htmlContent;
    }

    // If already markdown (no HTML tags), return as-is
    if (!htmlContent.includes('<')) {
      return htmlContent.trim();
    }

    // Remove HTML comments before conversion
    let content = htmlContent.replace(/<!--[\s\S]*?-->/g, '');

    // Convert HTML to Markdown using Turndown
    content = turndown.turndown(content);

    // Clean up whitespace
    content = content.replace(/\n{3,}/g, '\n\n');
    content = content.trim();

    return content;
  }
}
