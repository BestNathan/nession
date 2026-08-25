import {
  isMarkdownBasename,
  isMarkdownExt,
  isMarkdownMimeType,
  basenameOf,
} from './extensions';
import {
  MAX_CONTENT_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  type LanguageDetection,
  type MarkdownDetection,
} from './types';

/**
 * Multi-signal markdown detection.
 *
 * There is no reliable way to identify markdown from content alone — markdown
 * has no magic bytes, and under CommonMark every plain-text file is valid
 * markdown. `text/markdown` (RFC 7763/7764) is declared by extension or out of
 * band and specifies no sniffing rules; GitHub Linguist and CodeMirror both
 * resolve markdown by filename, not by inspecting the text.
 *
 * So this module ranks signals instead of guessing: extension, MIME type and
 * conventional basenames are trusted; content is scored, and a content-only
 * verdict is capped below the threshold at which callers may change how a file
 * is presented. When the signals are weak the answer is `plaintext`, not
 * markdown.
 */

/** Only the first 4 KiB is scanned — enough for structure, bounded for big files. */
const SCAN_LIMIT = 4096;

/**
 * Content score at which markdown is considered matched.
 *
 * Set so that no single ambiguous signal can clear it. `# comment` in a shell
 * script, Dockerfile or justfile scores 10 and stays below the line; two
 * independent markdown structures are required.
 */
const MATCH_THRESHOLD = 20;

/** Content score that maps to MAX_CONTENT_CONFIDENCE. */
const CONFIDENCE_CEILING_SCORE = 60;

/** Weight applied when the filename or MIME type already settles the question. */
const EXTENSION_SCORE = 100;
const MIME_SCORE = 100;
const BASENAME_SCORE = 80;

/** Applied to formats that are definitively not markdown. */
const EXCLUSION_SCORE = -100;

interface Signal {
  readonly name: string;
  readonly weight: number;
  readonly test: (content: string) => boolean;
}

/** Count non-overlapping matches of a global-flagged pattern, bounded. */
function countMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0;
}

/**
 * Formats that are actively not markdown.
 *
 * Only the *start* of the content is inspected. Markdown legitimately embeds
 * inline HTML, so a `<div>` in the middle of a document proves nothing — but a
 * document that opens with an XML declaration or an HTML doctype is markup.
 */
const EXCLUSIONS: Signal[] = [
  {
    name: 'shebang',
    weight: EXCLUSION_SCORE,
    // An executable script, whatever its `#` comments look like.
    test: (content) => /^#!/.test(content),
  },
  {
    name: 'jsonDocument',
    weight: EXCLUSION_SCORE,
    test: (content) => /^\s*(?:\{\s*"|\[\s*[{"[])/.test(content),
  },
  {
    name: 'xmlDeclaration',
    weight: EXCLUSION_SCORE,
    test: (content) => /^\s*<\?xml[\s?]/i.test(content),
  },
  {
    name: 'htmlDocument',
    weight: EXCLUSION_SCORE,
    test: (content) =>
      /^\s*<!DOCTYPE[\s>]/i.test(content) ||
      /^\s*<(?:html|head|body|svg|rss|feed|urlset)[\s>]/i.test(content),
  },
];

/** Frontmatter is a compact header; anything longer is a document body. */
const FRONTMATTER_MAX_LINES = 30;

/**
 * True when the content opens with a real frontmatter block.
 *
 * Deliberately stricter than "starts and ends with `---`". A licence or a
 * config file bracketed by `---` rules would satisfy that, so the block must
 * also be contiguous (no blank line before the closing delimiter) and contain
 * at least one `key: value` / `key = value` line. That is what separates
 * metadata from prose that happens to sit between two horizontal rules.
 */
function hasFrontmatterBlock(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const opener = lines[0]?.trim();
  if (opener !== '---' && opener !== '+++') {
    return false;
  }

  const assignment = opener === '+++'
    ? /^[A-Za-z0-9_.-]+[ \t]*=/
    : /^[ \t]*[A-Za-z0-9_.-]+[ \t]*:(?:[ \t]|$)/;

  let sawAssignment = false;
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES + 1);
  for (let i = 1; i < limit; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === opener) {
      return sawAssignment;
    }
    if (trimmed === '') {
      return false;
    }
    if (assignment.test(line)) {
      sawAssignment = true;
    }
  }
  return false;
}

/**
 * Structures that are distinctive to markdown.
 *
 * Weighted so that two of them clear MATCH_THRESHOLD while one never does.
 * The high-weight entries are near-unambiguous; `atxHeading`, `setextHeading`
 * and `blockquote` are shared with other formats (`#` comments, `---`
 * separators, quoted email) and are weighted below the threshold on purpose.
 */
const STRONG_SIGNALS: Signal[] = [
  {
    name: 'frontmatter',
    weight: 15,
    // A complete metadata block at the very top — YAML (---) or TOML (+++).
    // Distinct from the old `horizontalRule` rule, which fired on any `---`.
    test: hasFrontmatterBlock,
  },
  {
    name: 'fencedCode',
    weight: 15,
    test: (content) => /^(?:`{3,}|~{3,})[^\n`]*$/m.test(content),
  },
  {
    name: 'gfmTable',
    weight: 15,
    // Header row plus the `|---|---|` delimiter row; a bare pipe line is not enough.
    test: (content) => /^[ \t]*\|.+\|[^\n]*\r?\n[ \t]*\|[\s:|-]*-[\s:|-]*\|/m.test(content),
  },
  {
    name: 'taskList',
    weight: 15,
    test: (content) => /^[ \t]*[-*+] \[[ xX]\][ \t]/m.test(content),
  },
  {
    name: 'image',
    weight: 12,
    test: (content) => /!\[[^\]\n]*\]\([^)\n]*\)/.test(content),
  },
  {
    name: 'linkDefinition',
    weight: 12,
    test: (content) => /^[ \t]*\[[^\]\n]+\]:[ \t]*\S+/m.test(content),
  },
  {
    name: 'inlineLink',
    weight: 10,
    test: (content) => /\[[^\]\n]+\]\([^)\n]*\)/.test(content),
  },
  {
    name: 'atxHeading',
    weight: 10,
    // Requires `# ` followed by text, so `#!` and bare `#` dividers miss.
    // Still matches `# comment` in scripts — hence the sub-threshold weight.
    test: (content) => /^#{1,6}[ \t]\S/m.test(content),
  },
  {
    name: 'setextHeading',
    weight: 10,
    // Text line directly underlined by === or ---. The lookahead rejects list,
    // quote and heading lines so config separators do not qualify.
    test: (content) =>
      /^(?![ \t]*$)(?![ \t]*[-=#>|*+])[^\n]+\r?\n(?:={3,}|-{3,})[ \t]*$/m.test(content),
  },
  {
    name: 'blockquote',
    weight: 10,
    test: (content) => /^[ \t]*>[ \t]/m.test(content),
  },
];

/**
 * Structures that appear constantly outside markdown.
 *
 * A single occurrence is worthless — YAML sequences are `- item`, and one
 * backtick pair means nothing — so these only score once they repeat.
 */
const WEAK_SIGNAL_MIN_OCCURRENCES = 2;

const WEAK_SIGNALS: Signal[] = [
  {
    name: 'listItems',
    weight: 6,
    test: (content) =>
      countMatches(content, /^[ \t]*(?:[-*+]|\d+[.)])[ \t]\S/gm) >= WEAK_SIGNAL_MIN_OCCURRENCES,
  },
  {
    name: 'inlineCode',
    weight: 5,
    test: (content) => countMatches(content, /`[^`\n]+`/g) >= WEAK_SIGNAL_MIN_OCCURRENCES,
  },
];

/** True when the content looks like binary rather than text. */
function isBinary(content: string): boolean {
  if (content.length === 0) {
    return false;
  }
  const sample = content.slice(0, SCAN_LIMIT);
  if (sample.includes('\x00')) {
    return true;
  }
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Control characters other than tab, newline and carriage return.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

/** Score the content signals alone, ignoring filename and MIME. */
function scoreContent(content: string): { score: number; reasons: string[] } {
  const scan = content.slice(0, SCAN_LIMIT);
  const reasons: string[] = [];
  let score = 0;

  for (const exclusion of EXCLUSIONS) {
    if (exclusion.test(scan)) {
      reasons.push(`-${exclusion.name}`);
      score += exclusion.weight;
    }
  }

  for (const signal of [...STRONG_SIGNALS, ...WEAK_SIGNALS]) {
    if (signal.test(scan)) {
      reasons.push(signal.name);
      score += signal.weight;
    }
  }

  return { score, reasons };
}

/**
 * Score whether content is markdown, optionally aided by filename and MIME.
 *
 * A markdown extension or `text/markdown` MIME type settles it outright. A
 * conventional basename (`README`, `CHANGELOG`) is nearly as strong. Otherwise
 * the content is scored, and `matched` requires two independent markdown
 * structures — one ambiguous signal such as a `#` comment is never enough.
 */
export function detectMarkdown(
  content: string,
  filename?: string,
  mimeType?: string,
): MarkdownDetection {
  const reasons: string[] = [];
  let score = 0;

  if (mimeType && isMarkdownMimeType(mimeType)) {
    reasons.push('mime');
    score += MIME_SCORE;
  }

  if (filename) {
    const basename = basenameOf(filename);
    const lastDot = basename.lastIndexOf('.');
    const ext = lastDot > 0 ? basename.slice(lastDot + 1) : '';
    if (ext && isMarkdownExt(ext)) {
      reasons.push('extension');
      score += EXTENSION_SCORE;
    }
    if (isMarkdownBasename(basename)) {
      reasons.push('basename');
      score += BASENAME_SCORE;
    }
  }

  // Metadata already settled it; content cannot argue a markdown file out of
  // being markdown, so skip scoring (and skip the exclusion rules, which would
  // otherwise reject a `.md` file that happens to open with an HTML block).
  if (score > 0) {
    return { matched: true, score, reasons };
  }

  if (!content || isBinary(content)) {
    return { matched: false, score: 0, reasons: [] };
  }

  const contentScore = scoreContent(content);
  score += contentScore.score;
  reasons.push(...contentScore.reasons);

  return { matched: score >= MATCH_THRESHOLD, score, reasons };
}

/** Map a content-only score onto the SUGGEST..MAX_CONTENT confidence band. */
function contentConfidence(score: number): number {
  const span = CONFIDENCE_CEILING_SCORE - MATCH_THRESHOLD;
  const ratio = Math.min(Math.max(score - MATCH_THRESHOLD, 0) / span, 1);
  return SUGGEST_CONFIDENCE + ratio * (MAX_CONTENT_CONFIDENCE - SUGGEST_CONFIDENCE);
}

/**
 * Decide whether a file is markdown, returning a `LanguageDetection`.
 *
 * Returns `null` when markdown is not indicated, so callers can fall through to
 * their own language rules. A content-derived result never reaches
 * AUTO_APPLY_CONFIDENCE — that is what stops content sniffing from silently
 * switching a file into markdown preview.
 */
export function detectMarkdownLanguage(
  filename: string,
  content?: string,
  mimeType?: string,
): LanguageDetection | null {
  const basename = basenameOf(filename);
  const lastDot = basename.lastIndexOf('.');
  const ext = lastDot > 0 ? basename.slice(lastDot + 1) : '';

  if (ext && isMarkdownExt(ext)) {
    return {
      language: 'markdown',
      confidence: 0.95,
      source: 'extension',
      reasons: ['extension'],
    };
  }

  if (mimeType && isMarkdownMimeType(mimeType)) {
    return { language: 'markdown', confidence: 0.95, source: 'mime', reasons: ['mime'] };
  }

  if (isMarkdownBasename(basename)) {
    return {
      language: 'markdown',
      confidence: 0.9,
      source: 'filename',
      reasons: ['basename'],
    };
  }

  if (content === undefined) {
    return null;
  }

  const detection = detectMarkdown(content);
  if (!detection.matched) {
    return null;
  }

  return {
    language: 'markdown',
    confidence: contentConfidence(detection.score),
    source: 'content',
    reasons: detection.reasons,
  };
}
