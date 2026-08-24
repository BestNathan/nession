import { describe, expect, it } from 'vitest';
import { detectMarkdown, detectMarkdownLanguage } from '@/markdown/detect';
import {
  AUTO_APPLY_CONFIDENCE,
  MAX_CONTENT_CONFIDENCE,
  SUGGEST_CONFIDENCE,
} from '@/markdown/types';

/**
 * The cases that matter here are the *negatives*. Detecting a README as
 * markdown was never the hard part; not detecting a Dockerfile as markdown is.
 */

describe('detectMarkdown — files that must NOT be markdown', () => {
  it('rejects a Dockerfile', () => {
    const content = `FROM node:20
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

CMD ["node", "index.js"]
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects a justfile', () => {
    const content = `# Run the test suite
test:
    cargo test

# Lint everything
lint:
    cargo clippy --workspace
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects a Makefile', () => {
    const content = `.PHONY: all build test

# Build the project
all: build test

build:
\tcargo build --release
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects a shell script with # comments', () => {
    const content = `#!/bin/bash
# This is a comment
# Another comment
echo "hello"
# One more comment
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects a comment-only file with no shebang', () => {
    // No shebang to lean on: the verdict has to come from the weight of `#`
    // alone, which is deliberately below the threshold.
    const content = `# Configuration
# Edit values below

timeout = 30
retries = 3
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects source code with snake_case and pointer syntax', () => {
    // The old heuristic had a `boldItalic` pattern that fired on `__init__`
    // and `*ptr`, making it near-true for any source file.
    const content = `def __init__(self, *args, **kwargs):
    self._value = None
    my_var = other_var * 2
    return _internal_helper(*args)
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(false);
    expect(result.reasons).not.toContain('boldItalic');
  });

  it('rejects plain prose', () => {
    const content = `This is just some plain text.
It has no markdown formatting at all.
Just regular sentences and paragraphs.
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
  });

  it('rejects empty content', () => {
    const result = detectMarkdown('');
    expect(result.matched).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('rejects a YAML config whose sequences look like list items', () => {
    const content = `version: 3
services:
  - name: alpha
  - name: beta
  - name: gamma
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });

  it('rejects a licence body full of numbered clauses and rules', () => {
    const content = `---

1. Redistribution and use in source form is permitted.
2. Neither the name of the copyright holder nor the names
3. THIS SOFTWARE IS PROVIDED "AS IS".

---
`;
    expect(detectMarkdown(content).matched).toBe(false);
  });
});

describe('detectMarkdown — excluded formats', () => {
  it('excludes a JSON object', () => {
    const content = `{
  "name": "nession",
  "items": ["a", "b"]
}
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('-jsonDocument');
  });

  it('excludes a JSON array', () => {
    const result = detectMarkdown('[\n  {"id": 1},\n  {"id": 2}\n]\n');
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('-jsonDocument');
  });

  it('excludes an HTML document', () => {
    const content = `<!DOCTYPE html>
<html>
<body>
  <h1># Not a heading</h1>
  <p>See <a href="https://example.com">docs</a></p>
</body>
</html>
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('-htmlDocument');
  });

  it('excludes an XML document', () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <item># value</item>
</config>
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('-xmlDeclaration');
  });

  it('excludes binary content with null bytes', () => {
    expect(detectMarkdown('\x00\x00\x00# Heading\n\n- a\n- b').matched).toBe(false);
  });

  it('excludes content that is mostly control characters', () => {
    const content = '\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f'.repeat(100);
    expect(detectMarkdown(content).matched).toBe(false);
  });
});

describe('detectMarkdown — files that must be markdown', () => {
  it('accepts a README-style document', () => {
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
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('fencedCode');
    expect(result.reasons).toContain('taskList');
  });

  it('accepts a document with YAML frontmatter', () => {
    const content = `---
title: Deploy guide
tags: [ops, deploy]
---

# Deploy guide

Run the script.
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('frontmatter');
  });

  it('accepts a document with TOML frontmatter', () => {
    const content = `+++
title = "Notes"
+++

# Notes

Body text.
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('frontmatter');
  });

  it('accepts a GFM table plus prose structure', () => {
    const content = `## Comparison

| Option | Default | Notes |
|--------|---------|-------|
| retries | 3 | per request |

See the [reference](https://example.com).
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('gfmTable');
  });

  it('accepts a document with headings, lists and links', () => {
    const content = `# Header

- item 1
- item 2

[link text](https://example.com)
`;
    expect(detectMarkdown(content).matched).toBe(true);
  });

  it('accepts setext headings with body structure', () => {
    const content = `Title
=====

Section
-------

- one
- two

See \`config\` and \`flags\`.
`;
    const result = detectMarkdown(content);
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('setextHeading');
  });
});

describe('detectMarkdown — individual signals', () => {
  it('scores a complete frontmatter block but not a bare --- line', () => {
    const withBlock = detectMarkdown('---\ntitle: x\n---\n\nbody\n');
    expect(withBlock.reasons).toContain('frontmatter');

    // The old `horizontalRule` pattern fired on any `---`, which is how
    // frontmatter and config separators became markdown evidence.
    const bareRule = detectMarkdown('Some text\n\n---\n\nMore text\n');
    expect(bareRule.reasons).not.toContain('frontmatter');
  });

  it('requires a fence opener, not just backticks', () => {
    expect(detectMarkdown('```\ncode\n```\n').reasons).toContain('fencedCode');
    expect(detectMarkdown('use `x` inline\n').reasons).not.toContain('fencedCode');
  });

  it('requires a delimiter row for tables', () => {
    const withDelimiter = 'a | b\n';
    expect(detectMarkdown(`| h1 | h2 |\n|----|----|\n| ${withDelimiter}`).reasons)
      .toContain('gfmTable');
    // Pipes without a delimiter row — a log line or a shell pipeline.
    expect(detectMarkdown('| field | value |\n| other | thing |\n').reasons)
      .not.toContain('gfmTable');
  });

  it('requires text after the hashes for a heading', () => {
    expect(detectMarkdown('# Title\n').reasons).toContain('atxHeading');
    expect(detectMarkdown('#!/bin/sh\n').reasons).not.toContain('atxHeading');
    expect(detectMarkdown('#\n#\n#\n').reasons).not.toContain('atxHeading');
  });

  it('needs two occurrences before weak signals score', () => {
    expect(detectMarkdown('- only one item\n').reasons).not.toContain('listItems');
    expect(detectMarkdown('- one\n- two\n').reasons).toContain('listItems');
    expect(detectMarkdown('a `single` span\n').reasons).not.toContain('inlineCode');
    expect(detectMarkdown('a `first` and `second` span\n').reasons).toContain('inlineCode');
  });

  it('only scans the first 4096 characters', () => {
    const prefix = 'A'.repeat(4096);
    const suffix = '# Heading\n\n- list item\n- another\n\n[link](https://example.com)\n';
    expect(detectMarkdown(prefix + suffix).matched).toBe(false);
  });
});

describe('detectMarkdown — filename and MIME signals', () => {
  it('trusts a markdown extension over unstructured content', () => {
    const result = detectMarkdown('plain prose, nothing structural', 'notes.md');
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('extension');
  });

  it('accepts every known markdown extension', () => {
    for (const name of ['a.md', 'a.markdown', 'a.mkd', 'a.mdown', 'a.mkdn', 'a.mdx']) {
      expect(detectMarkdown('', name).matched).toBe(true);
    }
  });

  it('trusts text/markdown MIME type', () => {
    const result = detectMarkdown('plain prose', 'mystery', 'text/markdown');
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('mime');
  });

  it('ignores MIME parameters', () => {
    expect(detectMarkdown('x', 'f', 'text/markdown; charset=utf-8').matched).toBe(true);
  });

  it('does not trust text/plain', () => {
    expect(detectMarkdown('plain prose', 'mystery', 'text/plain').matched).toBe(false);
  });

  it('trusts conventional markdown basenames', () => {
    for (const name of ['README', 'CHANGELOG', 'CONTRIBUTING', 'readme.md']) {
      const result = detectMarkdown('plain prose', name);
      expect(result.matched, name).toBe(true);
    }
  });

  it('does not treat LICENSE or AUTHORS as markdown', () => {
    expect(detectMarkdown('plain prose', 'LICENSE').matched).toBe(false);
    expect(detectMarkdown('plain prose', 'AUTHORS').matched).toBe(false);
  });

  it('keeps a markdown file markdown even when it opens with HTML', () => {
    // Metadata settles it, so the HTML exclusion never gets a vote.
    const content = '<div align="center">\n  <h1>Title</h1>\n</div>\n';
    expect(detectMarkdown(content, 'README.md').matched).toBe(true);
  });
});

describe('detectMarkdownLanguage', () => {
  it('reports extension detections above the auto-apply band', () => {
    const detection = detectMarkdownLanguage('notes.md');
    expect(detection?.language).toBe('markdown');
    expect(detection?.source).toBe('extension');
    expect(detection?.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
  });

  it('reports MIME detections above the auto-apply band', () => {
    const detection = detectMarkdownLanguage('notes', undefined, 'text/markdown');
    expect(detection?.source).toBe('mime');
    expect(detection?.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
  });

  it('reports basename detections above the auto-apply band', () => {
    const detection = detectMarkdownLanguage('CHANGELOG');
    expect(detection?.source).toBe('filename');
    expect(detection?.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
  });

  it('caps content detections below the auto-apply band', () => {
    const content = `# Notes

- first
- second

See the [docs](https://example.com).
`;
    const detection = detectMarkdownLanguage('mystery', content);
    expect(detection?.language).toBe('markdown');
    expect(detection?.source).toBe('content');
    expect(detection?.confidence).toBeGreaterThanOrEqual(SUGGEST_CONFIDENCE);
    expect(detection?.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
  });

  it('never exceeds MAX_CONTENT_CONFIDENCE however strong the content', () => {
    const content = `---
title: everything
---

# Heading

## Another

\`\`\`bash
echo hi
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

- [x] task
- [ ] task

> quote

![img](a.png)

[ref]: https://example.com

See [docs](https://example.com) and \`this\` and \`that\`.
`;
    const detection = detectMarkdownLanguage('mystery', content);
    expect(detection?.confidence).toBeLessThanOrEqual(MAX_CONTENT_CONFIDENCE);
    expect(detection?.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
  });

  it('returns null when markdown is not indicated', () => {
    expect(detectMarkdownLanguage('script', 'echo hi\n')).toBeNull();
  });

  it('returns null without content and without filename signals', () => {
    expect(detectMarkdownLanguage('mystery')).toBeNull();
  });
});
