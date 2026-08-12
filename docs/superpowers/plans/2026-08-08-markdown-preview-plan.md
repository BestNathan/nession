# Markdown File Preview & Content-Based Format Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add rendered markdown preview with Preview/Raw toggle to the file viewer, plus content-based format detection for extensionless files.

**Architecture:** A new `MarkdownPreview` component renders via `react-markdown` + `rehype-highlight` (Catppuccin Mocha theme). A new `contentDetector` module scans first 4KB for markdown patterns (3-tier confidence). `FileViewer` gains a `'markdown'` viewer type with its own content branch and a Preview/Raw toggle in the toolbar. Non-markdown files are untouched.

**Tech Stack:** React 19, TypeScript, `react-markdown` ^9.0, `remark-gfm` ^4.0, `rehype-highlight` ^7.0, `rehype-sanitize` ^6.0, `remark-math` ^6.0, `rehype-katex` ^7.0, Vitest, CodeMirror

**Spec:** `docs/superpowers/specs/2026-08-10-markdown-preview-design.md`
**Requirements:** [#195](https://github.com/BestNathan/nession/issues/195)

---

### Task 1: Expand viewerRegistry with markdown type

**Files:**
- Modify: `web/src/lib/viewerRegistry.ts`
- Modify: `web/src/lib/__tests__/viewerRegistry.test.ts`

- [ ] **Step 1: Add 'markdown' to ViewerType and add isMarkdownExt()**

In `web/src/lib/viewerRegistry.ts`, line 1, change:

```typescript
export type ViewerType = 'image' | 'video' | 'audio' | 'pdf' | 'markdown';
```

After `parseExt()`, add:

```typescript
/** Return true if the extension indicates a markdown file. */
export function isMarkdownExt(ext: string): boolean {
  const key = ext.toLowerCase();
  return key === 'md' || key === 'markdown';
}
```

- [ ] **Step 2: Write tests for isMarkdownExt**

In `web/src/lib/__tests__/viewerRegistry.test.ts`, add after the `parseExt` describe block:

```typescript
describe('isMarkdownExt', () => {
  it('returns true for .md', () => {
    expect(isMarkdownExt('md')).toBe(true);
  });

  it('returns true for .markdown', () => {
    expect(isMarkdownExt('markdown')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMarkdownExt('MD')).toBe(true);
    expect(isMarkdownExt('Markdown')).toBe(true);
  });

  it('returns false for other extensions', () => {
    expect(isMarkdownExt('js')).toBe(false);
    expect(isMarkdownExt('txt')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMarkdownExt('')).toBe(false);
  });
});
```

Add `isMarkdownExt` to the import at line 2:

```typescript
import { getViewerType, getLangKey, preloadExtensions, isViewable, parseExt, isMarkdownExt } from '../viewerRegistry';
```

- [ ] **Step 3: Run tests**

```bash
cd web && npx vitest run src/lib/__tests__/viewerRegistry.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/viewerRegistry.ts web/src/lib/__tests__/viewerRegistry.test.ts
git commit -m "feat: add markdown viewer type and isMarkdownExt to viewerRegistry"
```

---

### Task 2: Install markdown rendering dependencies

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json` (auto-generated)

- [ ] **Step 1: Install dependencies**

```bash
cd web && npm install react-markdown@^9.0 remark-gfm@^4.0 rehype-highlight@^7.0 rehype-sanitize@^6.0 remark-math@^6.0 rehype-katex@^7.0
```

- [ ] **Step 2: Install dev type dependency (if needed)**

```bash
cd web && npm install --save-dev @types/hast
```

- [ ] **Step 3: Verify install — check package.json**

```bash
cd web && node -e "const p = require('./package.json'); ['react-markdown','remark-gfm','rehype-highlight','rehype-sanitize','remark-math','rehype-katex'].forEach(d => console.log(d, p.dependencies[d] ? 'OK' : 'MISSING'))"
```

Expected: all six show "OK".

- [ ] **Step 4: Verify build doesn't break on new deps**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors from new dependencies.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore: add markdown rendering dependencies"
```

---

### Task 3: Content detector module

**Files:**
- Create: `web/src/lib/contentDetector.ts`
- Create: `web/src/lib/__tests__/contentDetector.test.ts`

- [ ] **Step 1: Write tests for contentDetector**

Create `web/src/lib/__tests__/contentDetector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectMarkdown } from '../contentDetector';

describe('detectMarkdown', () => {
  it('returns high confidence for README-style markdown', () => {
    const content = `# Project Title

## Installation

\`\`\`bash
npm install
\`\`\`

- [x] Feature one
- [ ] Feature two

See the [docs](https://example.com) for more info.
`;
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('high');
    expect(result.found.length).toBeGreaterThanOrEqual(3);
  });

  it('returns high confidence for content with headings, lists, and links', () => {
    const content = `# Header

- item 1
- item 2

[link text](https://example.com)
`;
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('high');
  });

  it('returns medium confidence for content with only one pattern type', () => {
    const content = `# Just a heading

Some plain text here.

No other markdown patterns.
`;
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('medium');
  });

  it('returns medium confidence for shell script with # comments', () => {
    const content = `#!/bin/bash
# This is a comment
# Another comment
echo "hello"
# One more comment
`;
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('medium');
    expect(result.found).toContain('heading');
  });

  it('returns low confidence for plain text', () => {
    const content = `This is just some plain text.
It has no markdown formatting at all.
Just regular sentences and paragraphs.
`;
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('low');
    expect(result.found).toEqual([]);
  });

  it('returns low confidence for empty content', () => {
    const result = detectMarkdown('');
    expect(result.confidence).toBe('low');
    expect(result.found).toEqual([]);
  });

  it('detects fenced code blocks', () => {
    const content = `Some text

\`\`\`
code here
\`\`\`

More text.
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('fencedCodeBlock');
  });

  it('detects tables', () => {
    const content = `| Col1 | Col2 |
|------|------|
| a    | b    |
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('table');
  });

  it('detects blockquotes', () => {
    const content = `> This is a quote
> spanning multiple lines
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('blockquote');
  });

  it('detects setext headings', () => {
    const content = `Title
=====

Section
-------
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('heading');
  });

  it('returns low confidence for binary-like content (null bytes)', () => {
    const content = '\x00\x00\x00Some text';
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('low');
  });

  it('returns low confidence for content with mostly non-printable chars', () => {
    const content = '\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0b\x0c\x0e\x0f'.repeat(100);
    const result = detectMarkdown(content);
    expect(result.confidence).toBe('low');
  });

  it('only scans first 4096 bytes', () => {
    // Build a string with no markdown in first 4096, then markdown after
    const prefix = 'A'.repeat(4096);
    const suffix = `# Heading

- list item
- another

[link](https://example.com)
`;
    const result = detectMarkdown(prefix + suffix);
    expect(result.confidence).toBe('low');
  });

  it('detects horizontal rules', () => {
    const content = `---
Some text
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('horizontalRule');
  });

  it('detects bold/italic', () => {
    const content = `This is **bold** and *italic* and __bold__ and _italic_ text.`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('boldItalic');
  });

  it('detects ordered lists', () => {
    const content = `1. First
2. Second
3. Third
`;
    const result = detectMarkdown(content);
    expect(result.found).toContain('orderedList');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd web && npx vitest run src/lib/__tests__/contentDetector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement contentDetector.ts**

Create `web/src/lib/contentDetector.ts`:

```typescript
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
  { name: 'heading', regex: /^(?:=+|-+)\s*$/m },  // setext heading too
  { name: 'unorderedList', regex: /^[\*\-\+]\s/m },
  { name: 'orderedList', regex: /^\d+\.\s/m },
  { name: 'fencedCodeBlock', regex: /^```/m },
  { name: 'link', regex: /\[.*?\]\(.*?\)/ },
  { name: 'boldItalic', regex: /(?:\*\*|__|\*[^*\s]|_[^_\s])/ },
  { name: 'blockquote', regex: /^>\s/m },
  { name: 'table', regex: /^\|.*\|.*\|$/m },
  { name: 'horizontalRule', regex: /^(?:\-{3,}|\*{3,}|\_{3,})\s*$/m },
];

const SCAN_LIMIT = 4096;
const HIGH_THRESHOLD = 3;
const MEDIUM_THRESHOLD = 1;

/** Check if content appears to be binary/non-text. */
function isBinary(content: string): boolean {
  if (content.length === 0) return false;
  // Check for null bytes
  if (content.includes('\x00')) return true;
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

  // Combine heading patterns (ATX + setext) into one pattern type
  const headingRegexes = [/^#{1,6}\s/m, /^(?:=+|-+)\s*$/m];
  const hasHeading = headingRegexes.some(r => r.test(scanContent));

  for (const pattern of PATTERNS) {
    // Skip the individual heading entries since we handle them combined
    if (pattern.name === 'heading') continue;
    if (pattern.regex.test(scanContent)) {
      found.add(pattern.name);
    }
  }

  if (hasHeading) {
    found.add('heading');
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
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd web && npx vitest run src/lib/__tests__/contentDetector.test.ts
```

Expected: all 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/contentDetector.ts web/src/lib/__tests__/contentDetector.test.ts
git commit -m "feat: add content-based markdown detection module"
```

---

### Task 4: MarkdownPreview component

**Files:**
- Create: `web/src/components/MarkdownPreview.tsx`
- Create: `web/src/components/__tests__/MarkdownPreview.test.tsx`

- [ ] **Step 1: Write tests for MarkdownPreview**

Create `web/src/components/__tests__/MarkdownPreview.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview } from '../MarkdownPreview';

describe('MarkdownPreview', () => {
  it('renders headings', () => {
    const content = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(screen.getByText('Heading 1')).toBeInTheDocument();
    expect(screen.getByText('Heading 2')).toBeInTheDocument();
    expect(screen.getByText('Heading 3')).toBeInTheDocument();
  });

  it('renders paragraphs', () => {
    const content = 'This is a paragraph.\n\nAnother paragraph.';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(screen.getByText('This is a paragraph.')).toBeInTheDocument();
    expect(screen.getByText('Another paragraph.')).toBeInTheDocument();
  });

  it('renders bold and italic text', () => {
    const content = 'This is **bold** and *italic* text.';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const bold = screen.getByText('bold');
    expect(bold.tagName).toBe('STRONG');
    const italic = screen.getByText('italic');
    expect(italic.tagName).toBe('EM');
  });

  it('renders fenced code blocks', () => {
    const content = '```javascript\nconst x = 1;\n```';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const code = screen.getByText(/const x = 1/);
    expect(code.closest('pre')).toBeInTheDocument();
  });

  it('renders tables', () => {
    const content = '| A | B |\n|---|---|\n| 1 | 2 |';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders task lists', () => {
    const content = '- [x] Done\n- [ ] Not done';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it('renders links', () => {
    const content = '[Click here](https://example.com)';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const link = screen.getByText('Click here');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com');
  });

  it('renders blockquotes', () => {
    const content = '> This is a quote';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const quote = screen.getByText(/This is a quote/);
    expect(quote.closest('blockquote')).toBeInTheDocument();
  });

  it('renders inline code', () => {
    const content = 'Use `console.log()` to debug.';
    render(<MarkdownPreview content={content} filename="test.md" />);
    const code = screen.getByText('console.log()');
    expect(code.tagName).toBe('CODE');
  });

  it('renders horizontal rules', () => {
    const content = 'Above\n\n---\n\nBelow';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(document.querySelector('hr')).toBeInTheDocument();
  });

  it('sanitizes HTML in markdown', () => {
    const content = '<script>alert("xss")</script>\n\nSafe text.';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(screen.queryByText('alert("xss")')).not.toBeInTheDocument();
    expect(screen.getByText('Safe text.')).toBeInTheDocument();
  });

  it('renders LaTeX inline math', () => {
    const content = 'The formula is $E = mc^2$ inline.';
    render(<MarkdownPreview content={content} filename="test.md" />);
    // KaTeX renders math as span.katex
    expect(document.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders LaTeX block math', () => {
    const content = '$$\nE = mc^2\n$$';
    render(<MarkdownPreview content={content} filename="test.md" />);
    expect(document.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('shows large file banner for content >1MB', () => {
    const content = '# Heading\n\n' + 'A'.repeat(1_048_577);
    render(<MarkdownPreview content={content} filename="large.md" />);
    expect(screen.getByText(/Large file/)).toBeInTheDocument();
  });

  it('renders empty content without error', () => {
    render(<MarkdownPreview content="" filename="empty.md" />);
    expect(document.body.contains(document.querySelector('[class*="markdown"]'))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd web && npx vitest run src/components/__tests__/MarkdownPreview.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement MarkdownPreview component**

Create `web/src/components/MarkdownPreview.tsx`:

```tsx
import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import { Info } from 'lucide-react';

/** Props for MarkdownPreview */
interface MarkdownPreviewProps {
  content: string;
  filename: string;
}

/** Props for MarkdownErrorBoundary */
interface ErrorBoundaryProps {
  children: ReactNode;
  onFallback: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** Catches rendering errors and shows a fallback UI. */
class MarkdownErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-sm text-muted-foreground">
          <p>Preview unavailable</p>
          <button
            onClick={this.props.onFallback}
            className="px-3 py-1.5 text-xs rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground"
          >
            Show raw
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const LARGE_FILE_THRESHOLD = 1_048_576; // 1MB

/**
 * Renders markdown content with GFM, LaTeX math, and syntax highlighting.
 * Uses Catppuccin Mocha theme for code blocks.
 */
export function MarkdownPreview({ content, filename }: MarkdownPreviewProps) {
  const isLargeFile = content.length > LARGE_FILE_THRESHOLD;

  const handleErrorFallback = () => {
    // Dispatch a custom event that FileViewer listens to
    window.dispatchEvent(new CustomEvent('markdown-preview-error', { detail: { filename } }));
  };

  return (
    <MarkdownErrorBoundary onFallback={handleErrorFallback}>
      <div className="markdown-preview overflow-y-auto h-full p-4 text-sm leading-relaxed">
        {isLargeFile && (
          <div className="flex items-center gap-2 px-3 py-2 mb-3 text-xs rounded border bg-blue-950/50 border-blue-800 text-blue-200">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>Large file — rendering may be slow</span>
          </div>
        )}
        <div className="prose prose-sm max-w-none dark:prose-invert
          prose-headings:text-foreground prose-p:text-foreground
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
          prose-code:text-amber-300 prose-code:bg-muted/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
          prose-pre:bg-muted prose-pre:border prose-pre:border-border
          prose-blockquote:border-l-2 prose-blockquote:border-blue-500 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground
          prose-table:border prose-table:border-border
          prose-th:border prose-th:border-border prose-th:bg-muted/50 prose-th:px-3 prose-th:py-1
          prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1
          prose-hr:border-border
          prose-img:rounded
          prose-li:marker:text-muted-foreground
        ">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeHighlight, rehypeKatex, rehypeSanitize]}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </MarkdownErrorBoundary>
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd web && npx vitest run src/components/__tests__/MarkdownPreview.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript compilation**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/MarkdownPreview.tsx web/src/components/__tests__/MarkdownPreview.test.tsx
git commit -m "feat: add MarkdownPreview component with GFM, math, and syntax highlighting"
```

---

### Task 5: Integrate markdown preview into FileViewer

**Files:**
- Modify: `web/src/components/FileViewer.tsx`
- Create: `web/src/components/__tests__/FileViewer.test.tsx`

- [ ] **Step 1: Write tests for FileViewer markdown integration**

Create `web/src/components/__tests__/FileViewer.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileViewer } from '../FileViewer';
import type { FileOps } from '../../services/fileOps';

function mockFileOps(overrides: Partial<FileOps> = {}): FileOps {
  return {
    readFile: vi.fn().mockResolvedValue({
      path: '/test/readme.md',
      content: btoa('# Hello\n\nThis is markdown.\n\n- item 1\n- item 2'),
      mime_type: 'text/markdown',
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    base64Decode: (b64: string) => atob(b64),
    ...overrides,
  } as unknown as FileOps;
}

describe('FileViewer markdown integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Preview button for .md files', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
  });

  it('renders markdown content in preview mode by default for .md files', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeInTheDocument();
      expect(screen.getByText('This is markdown.')).toBeInTheDocument();
    });
  });

  it('toggles between Preview and Raw mode', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });

    // Click Raw
    await userEvent.click(screen.getByText('Raw'));

    await waitFor(() => {
      // Preview button should now be visible (switched to raw mode)
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
  });

  it('does NOT show Preview button for .txt files', async () => {
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/notes.txt',
        content: btoa('Just some text.'),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/notes.txt" filename="notes.txt" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.queryByText('Preview')).not.toBeInTheDocument();
      expect(screen.queryByText('Raw')).not.toBeInTheDocument();
    });
  });

  it('auto-detects markdown in extensionless files with high confidence', async () => {
    const content = `# Project Title

## Getting Started

- Step one
- Step two

See the [docs](https://example.com).

\`\`\`bash
npm start
\`\`\`
`;
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/README',
        content: btoa(content),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/README" filename="README" onClose={onClose} />);

    await waitFor(() => {
      // Should auto-detect and show preview
      expect(screen.getByText('Project Title')).toBeInTheDocument();
    });
  });

  it('shows suggestion banner for medium confidence detection', async () => {
    const content = `# Just a comment

echo "hello world"

# Another comment
`;
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/script',
        content: btoa(content),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/script" filename="script" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/looks like Markdown/i)).toBeInTheDocument();
    });
  });

  it('hides Edit button when in preview mode', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
    // Edit button should not be visible in preview mode
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd web && npx vitest run src/components/__tests__/FileViewer.test.tsx
```

Expected: FAIL — markdown-related props/behavior not yet implemented.

- [ ] **Step 3: Modify FileViewer.tsx — imports and state**

Replace the imports at the top of `web/src/components/FileViewer.tsx` (lines 1-23):

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { Edit3, Save, Eye, Code, Info } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { AudioViewer } from './AudioViewer';
import { PdfViewer } from './PdfViewer';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';
import { getViewerType, parseExt, isMarkdownExt, type ViewerType } from '@/lib/viewerRegistry';
import { detectMarkdown } from '@/lib/contentDetector';
import type { FileOps } from '../services/fileOps';
```

- [ ] **Step 4: Modify FileViewerToolbar — add Preview/Raw button**

Replace `FileViewerToolbar` (lines 44-78) with:

```typescript
interface FileViewerToolbarProps {
  filename: string;
  isDirty: boolean;
  isText: boolean;
  isReadOnly: boolean;
  saving: boolean;
  isMarkdown: boolean;
  viewMode: 'preview' | 'raw';
  onSave: () => void;
  onEditToggle: () => void;
  onPreviewToggle: () => void;
  onCloseClick: () => void;
}

function FileViewerToolbar({
  filename, isDirty, isText, isReadOnly, saving, isMarkdown, viewMode, onSave, onEditToggle, onPreviewToggle, onCloseClick,
}: FileViewerToolbarProps) {
  const showPreviewToggle = isMarkdown;
  const showEditToggle = isText && (!isMarkdown || viewMode === 'raw');

  return (
    <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground truncate max-w-[200px]">{filename}</span>
        {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
      </div>
      <div className="flex items-center gap-1">
        {isText && !isReadOnly && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onSave} disabled={!isDirty || saving}>
            <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
          </Button>
        )}
        {showPreviewToggle && viewMode === 'preview' && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onPreviewToggle}>
            <Code className="h-3 w-3 mr-1" />Raw
          </Button>
        )}
        {showPreviewToggle && viewMode === 'raw' && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onPreviewToggle}>
            <Eye className="h-3 w-3 mr-1" />Preview
          </Button>
        )}
        {showEditToggle && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onEditToggle}>
            <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive" onClick={onCloseClick} aria-label="Close file" title="Close file">✕</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Modify FileViewerContent — add markdown branch**

Replace `FileViewerContentProps` and `FileViewerContent` (lines 81-125) with:

```typescript
interface FileViewerContentProps {
  loading: boolean;
  error: string | null;
  viewerType: ViewerType | null;
  mediaBlobUrl: string | null;
  filename: string;
  originalContent: string;
  content: string;
  isReadOnly: boolean;
  isDirty: boolean;
  isMarkdown: boolean;
  viewMode: 'preview' | 'raw';
  showSuggestion: boolean;
  onRetry: () => void;
  onChange: (value: string) => void;
  onSuggestionPreview: () => void;
  onSuggestionDismiss: () => void;
}

function FileViewerContent({
  loading, error, viewerType, mediaBlobUrl, filename, originalContent, content,
  isReadOnly, isDirty, isMarkdown, viewMode, showSuggestion,
  onRetry, onChange, onSuggestionPreview, onSuggestionDismiss,
}: FileViewerContentProps) {
  // Media viewers
  if (viewerType && viewerType !== 'markdown') {
    const MediaViewerComponent = (
      { image: ImageViewer, video: VideoViewer, audio: AudioViewer, pdf: PdfViewer } as Record<string, React.ComponentType<{ blobUrl: string; filename: string }>>
    )[viewerType];

    return (
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : MediaViewerComponent && mediaBlobUrl ? (
          <MediaViewerComponent blobUrl={mediaBlobUrl} filename={filename} />
        ) : null}
      </div>
    );
  }

  // Markdown preview mode
  if (isMarkdown && viewMode === 'preview') {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {isDirty && originalContent !== content && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-amber-950/30 border-amber-800 text-amber-200">
            <Info className="h-3 w-3 shrink-0" />
            <span>Preview shows the saved version. Save to update preview.</span>
          </div>
        )}
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex flex-col p-3 gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
              <p className="text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
            </div>
          ) : (
            <MarkdownPreview content={originalContent} filename={filename} />
          )}
        </div>
      </div>
    );
  }

  // Raw text mode (CodeMirror)
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {showSuggestion && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-blue-950/50 border-blue-800 text-blue-200">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>This file looks like Markdown</span>
          <button
            onClick={onSuggestionPreview}
            className="ml-auto px-2 py-0.5 rounded text-xs bg-blue-800 hover:bg-blue-700 text-blue-100"
          >
            Preview
          </button>
          <button
            onClick={onSuggestionDismiss}
            className="px-1 py-0.5 text-blue-400 hover:text-blue-200"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          <CodeMirrorEditor
            value={content}
            onChange={onChange}
            readOnly={isReadOnly}
            filename={filename}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Modify FileViewer main component — add state and detection logic**

Replace the `FileViewer` component body (from line 127 onwards). The existing state variables stay, with additions:

```typescript
export function FileViewer({ fileOps, path, filename, onClose, onDirtyChange }: FileViewerProps) {
  const ext = parseExt(path);
  const viewerType: ViewerType | null = ext ? getViewerType(ext) : null;

  // Markdown detection — extension-based wins, content-based is fallback
  const isMarkdownByExt = ext ? isMarkdownExt(ext) : false;
  const [isMarkdown, setIsMarkdown] = useState(isMarkdownByExt);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>(isMarkdownByExt ? 'preview' : 'raw');
  const [showSuggestion, setShowSuggestion] = useState(false);

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const blobUrlRef = useRef<string | null>(null);
  const suggestionDismissedRef = useRef(false);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // Listen for MarkdownPreview error events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail.filename === filename) {
        setViewMode('raw');
      }
    };
    window.addEventListener('markdown-preview-error', handler);
    return () => window.removeEventListener('markdown-preview-error', handler);
  }, [filename]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fileOps.readFile(path);

      // Media files (existing logic, unchanged)
      if (viewerType && viewerType !== 'markdown') {
        const newBlobUrl = base64ToBlobUrl(data.content, data.mime_type);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = newBlobUrl;
        setMediaBlobUrl(newBlobUrl);
        return;
      }

      // Text content — decode and detect if needed
      const decoded = fileOps.base64Decode(data.content);
      setContent(decoded);
      setOriginalContent(decoded);

      // Content-based markdown detection for extensionless files
      if (!isMarkdownByExt && !ext && !suggestionDismissedRef.current) {
        const detection = detectMarkdown(decoded);

        if (detection.confidence === 'high') {
          setIsMarkdown(true);
          setViewMode('preview');
        } else if (detection.confidence === 'medium') {
          setIsMarkdown(true);
          setViewMode('raw');
          setShowSuggestion(true);
        }
        // low → do nothing, stays as plain text
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps, viewerType, isMarkdownByExt, ext]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const handleEditToggle = () => { setIsReadOnly((prev) => !prev); };

  const handlePreviewToggle = () => {
    setViewMode((prev) => {
      if (prev === 'preview') {
        // Switching to raw: always start in view mode
        setIsReadOnly(true);
        return 'raw';
      }
      return 'preview';
    });
  };

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const dirty = newContent !== originalContent;
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fileOps.writeFile(path, content);
      setOriginalContent(content);
      setIsDirty(false);
      onDirtyChange?.(false);
      toast.success(`Saved ${filename}`);
    } catch (err) {
      toastError(err, 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange]);

  const handleCloseClick = () => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  };

  const handleConfirmClose = () => {
    setShowUnsavedDialog(false);
    onClose();
  };

  const handleSuggestionPreview = () => {
    setViewMode('preview');
    setShowSuggestion(false);
  };

  const handleSuggestionDismiss = () => {
    setShowSuggestion(false);
    suggestionDismissedRef.current = true;
  };

  // Determine if this is a non-markdown text file (for toolbar logic)
  const isMedia = viewerType !== null && viewerType !== 'markdown';
  const isText = !isMedia;

  return (
    <div className="flex flex-col h-full">
      <FileViewerToolbar
        filename={filename}
        isDirty={isDirty}
        isText={isText}
        isReadOnly={isReadOnly}
        saving={saving}
        isMarkdown={isMarkdown}
        viewMode={viewMode}
        onSave={handleSave}
        onEditToggle={handleEditToggle}
        onPreviewToggle={handlePreviewToggle}
        onCloseClick={handleCloseClick}
      />
      <FileViewerContent
        loading={loading}
        error={error}
        viewerType={viewerType}
        mediaBlobUrl={mediaBlobUrl}
        filename={filename}
        originalContent={originalContent}
        content={content}
        isReadOnly={isReadOnly}
        isDirty={isDirty}
        isMarkdown={isMarkdown}
        viewMode={viewMode}
        showSuggestion={showSuggestion}
        onRetry={loadFile}
        onChange={handleContentChange}
        onSuggestionPreview={handleSuggestionPreview}
        onSuggestionDismiss={handleSuggestionDismiss}
      />

      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Close anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Close without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 7: Run tests — verify they pass**

```bash
cd web && npx vitest run src/components/__tests__/FileViewer.test.tsx
```

Expected: all tests pass.

- [ ] **Step 8: Compile check**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Run full lint**

```bash
cd web && npm run lint
```

Expected: no warnings, no errors.

- [ ] **Step 10: Run all tests**

```bash
cd web && npx vitest run
```

Expected: all existing tests + all new tests pass.

- [ ] **Step 11: Commit**

```bash
git add web/src/components/FileViewer.tsx web/src/components/__tests__/FileViewer.test.tsx
git commit -m "feat: integrate markdown preview into FileViewer with Preview/Raw toggle"
```

---

### Task 6: Integration verification & cleanup

**Files:** None created/modified (verification only)

- [ ] **Step 1: Full build**

```bash
cd web && npm run build
```

Expected: build succeeds. No warnings.

- [ ] **Step 2: Full test suite with coverage**

```bash
cd web && npm run coverage
```

Expected: coverage ≥ 80% threshold met.

- [ ] **Step 3: ESLint check**

```bash
cd web && npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Verify file types untouched**

Check that `viewerRegistry.test.ts` still passes unchanged tests for non-markdown types:

```bash
cd web && npx vitest run src/lib/__tests__/viewerRegistry.test.ts
```

Expected: all tests pass (including pre-existing ones).

- [ ] **Step 5: Commit any final adjustments**

```bash
git add -A
git diff --cached --stat
```

If any snapshot updates or formatting changes needed, commit them:

```bash
git commit -m "chore: integration verification pass"
```
