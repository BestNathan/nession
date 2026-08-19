import { describe, it, expect } from 'vitest';
import { detectMarkdown } from '@/lib/contentDetector';

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
