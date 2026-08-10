export type Confidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
  confidence: Confidence;
  found: string[];
}

interface PatternRule {
  name: string;
  regex: RegExp;
}

const PATTERNS: PatternRule[] = [
  { name: 'heading', regex: /^#{1,6}\s/m },
  { name: 'heading', regex: /^(?:=+|-+)\s*$/m },
  { name: 'unorderedList', regex: /^[*\-+]\s/m },
  { name: 'orderedList', regex: /^\d+\.\s/m },
  { name: 'fencedCodeBlock', regex: /^```/m },
  { name: 'link', regex: /\[.*?\]\(.*?\)/ },
  { name: 'boldItalic', regex: /(?:\*\*|__|\*[^*\s]|_[^_\s])/ },
  { name: 'blockquote', regex: /^>\s/m },
  { name: 'table', regex: /^\|.*\|.*\|$/m },
  { name: 'horizontalRule', regex: /^(?:-{3,}|\*{3,}|_{3,})\s*$/m },
];

const SCAN_LIMIT = 4096;
const HIGH_THRESHOLD = 3;
const MEDIUM_THRESHOLD = 1;

/** Check if content appears to be binary/non-text. */
function isBinary(content: string): boolean {
  if (content.length === 0) {
    return false;
  }
  // Check for null bytes
  if (content.includes('\x00')) {
    return true;
  }
  // Count non-printable characters (excluding common whitespace)
  let nonPrintable = 0;
  const sample = content.slice(0, SCAN_LIMIT);
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow: tab(9), newline(10), carriage return(13), space(32) through ~(126)
    // Also allow common UTF-8 multi-byte sequences (code > 127)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

/**
 * Detect whether text content looks like markdown.
 * Scans the first 4096 bytes for structural markdown patterns.
 * Returns confidence level and list of matched pattern names.
 */
export function detectMarkdown(content: string): DetectionResult {
  if (!content || content.length === 0) {
    return { confidence: 'low', found: [] };
  }

  if (isBinary(content)) {
    return { confidence: 'low', found: [] };
  }

  const scanContent = content.slice(0, SCAN_LIMIT);
  const found = new Set<string>();

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(scanContent)) {
      found.add(pattern.name);
    }
  }

  const count = found.size;

  let confidence: Confidence;
  if (count >= HIGH_THRESHOLD) {
    confidence = 'high';
  } else if (count >= MEDIUM_THRESHOLD) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { confidence, found: Array.from(found) };
}
