/**
 * File attachment service for reading and formatting file contents
 */

import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pMap } from '../utils/concurrency.js';

interface FileAttachment {
  path: string;
  start_line?: number | undefined;
  end_line?: number | undefined;
  description?: string | undefined;
}

interface FormattedFileResult {
  success: boolean;
  path: string;
  content: string;
  error?: string | undefined;
}

export class FileAttachmentService {
  /**
   * Format multiple file attachments into a markdown section
   */
  async formatAttachments(attachments: FileAttachment[]): Promise<string> {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const results = await pMap(attachments, (attachment) => this.formatSingleFile(attachment), 5);

    // Build the attachments section
    const parts: string[] = ['\n\n---\n\n# 📎 ATTACHED FILES\n\n'];
    parts.push(`*${results.length} file${results.length > 1 ? 's' : ''} attached for context*\n\n`);
    for (const result of results) {
      parts.push(result.content);
      parts.push('\n\n');
    }
    return parts.join('');
  }

  /**
   * Format a single file attachment
   */
  private async formatSingleFile(attachment: FileAttachment): Promise<FormattedFileResult> {
    const { path, start_line, end_line, description } = attachment;

    // Check if file exists
    try {
      await access(path);
    } catch {
      return {
        success: false,
        path,
        content: `## ❌ ${path}\n\n**FILE NOT FOUND**\n${description ? `\n*Description:* ${description}\n` : ''}`,
        error: 'File not found',
      };
    }

    try {
      // Read file content
      const content = await readFile(path, 'utf-8');
      const lines = content.split('\n');
      const language = this.detectLanguage(path);

      // Validate line ranges
      const validatedRange = this.validateLineRange(start_line, end_line, lines.length);
      if (!validatedRange.valid) {
        return {
          success: false,
          path,
          content: `## ⚠️ ${path}\n\n**INVALID LINE RANGE**: ${validatedRange.error}\n${description ? `\n*Description:* ${description}\n` : ''}`,
          error: validatedRange.error,
        };
      }

      // Extract relevant lines
      const startIdx = validatedRange.start - 1;
      const endIdx = validatedRange.end - 1;
      const selectedLines = lines.slice(startIdx, endIdx + 1);

      // Build formatted output
      let formatted = `## 📄 ${path}\n\n`;

      // Add metadata
      const isPartial = start_line !== undefined || end_line !== undefined;
      formatted += `**Language:** ${language} | `;
      formatted += `**Lines:** ${isPartial ? `${validatedRange.start}-${validatedRange.end}` : lines.length} | `;
      formatted += `**Size:** ${(content.length / 1024).toFixed(2)} KB\n`;

      if (description) {
        formatted += `\n*${description}*\n`;
      }

      formatted += '\n';

      // Add file content with line numbers
      formatted += this.formatCodeBlock(selectedLines, language, startIdx);

      return {
        success: true,
        path,
        content: formatted,
      };
    } catch (error) {
      return {
        success: false,
        path,
        content: `## ❌ ${path}\n\n**ERROR READING FILE**: ${error instanceof Error ? error.message : String(error)}\n${description ? `\n*Description:* ${description}\n` : ''}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Format code block with line numbers and smart truncation
   */
  private formatCodeBlock(lines: string[], language: string, startIdx: number): string {
    const parts: string[] = [`\`\`\`${language.toLowerCase()}\n`];

    // Smart truncation for very large files (keep first 500 lines + last 100 lines)
    if (lines.length > 600) {
      // First 500 lines
      const firstLines = lines.slice(0, 500);
      for (let idx = 0; idx < firstLines.length; idx++) {
        const lineNumber = startIdx + idx + 1;
        parts.push(`${lineNumber.toString().padStart(4, ' ')}: ${firstLines[idx]}\n`);
      }

      // Truncation marker
      parts.push(`\n... [${lines.length - 600} lines truncated for brevity] ...\n\n`);

      // Last 100 lines
      const lastLines = lines.slice(-100);
      for (let idx = 0; idx < lastLines.length; idx++) {
        const lineNumber = startIdx + lines.length - 100 + idx + 1;
        parts.push(`${lineNumber.toString().padStart(4, ' ')}: ${lastLines[idx]}\n`);
      }
    } else {
      // Show all lines with numbers
      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = startIdx + idx + 1;
        parts.push(`${lineNumber.toString().padStart(4, ' ')}: ${lines[idx]}\n`);
      }
    }

    parts.push('```');
    return parts.join('');
  }

  /**
   * Validate line range and return corrected values
   */
  private validateLineRange(
    start_line: number | undefined,
    end_line: number | undefined,
    totalLines: number
  ): { valid: boolean; start: number; end: number; error?: string } {
    // No range specified - return full file
    if (start_line === undefined && end_line === undefined) {
      return { valid: true, start: 1, end: totalLines };
    }

    // Only start_line specified
    if (start_line !== undefined && end_line === undefined) {
      if (start_line < 1 || start_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} out of range (1-${totalLines})`,
        };
      }
      return { valid: true, start: start_line, end: totalLines };
    }

    // Only end_line specified
    if (start_line === undefined && end_line !== undefined) {
      if (end_line < 1 || end_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `end_line ${end_line} out of range (1-${totalLines})`,
        };
      }
      return { valid: true, start: 1, end: end_line };
    }

    // Both specified
    if (start_line !== undefined && end_line !== undefined) {
      if (start_line < 1 || start_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} out of range (1-${totalLines})`,
        };
      }
      if (end_line < 1 || end_line > totalLines) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `end_line ${end_line} out of range (1-${totalLines})`,
        };
      }
      if (start_line > end_line) {
        return {
          valid: false,
          start: 1,
          end: totalLines,
          error: `start_line ${start_line} cannot be greater than end_line ${end_line}`,
        };
      }
      return { valid: true, start: start_line, end: end_line };
    }

    return { valid: true, start: 1, end: totalLines };
  }

  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript',
      '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
      '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
      '.md': 'markdown', '.html': 'html', '.css': 'css', '.sql': 'sql',
      '.sh': 'bash', '.xml': 'xml',
    };
    if (filePath.endsWith('Dockerfile')) return 'dockerfile';
    return map[ext] || 'text';
  }
}
