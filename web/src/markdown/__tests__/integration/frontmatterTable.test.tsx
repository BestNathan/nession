import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import {
  getRehypePlugins,
  getRemarkPlugins,
  getRemarkRehypeOptions,
  markdownSanitizeSchema,
} from '@/markdown/previewPlugins';
import { FRONTMATTER_TABLE_CLASS } from '@/markdown/frontmatterTable';

/**
 * Renders through the real plugin chain — the point is what reaches the DOM, not
 * the shape of the plugin arrays.
 */
function renderMarkdown(content: string) {
  return render(
    <ReactMarkdown
      remarkPlugins={getRemarkPlugins()}
      rehypePlugins={getRehypePlugins()}
      remarkRehypeOptions={getRemarkRehypeOptions()}
    >
      {content}
    </ReactMarkdown>,
  );
}

/** The frontmatter table is the only table with a `th[scope=row]`. */
function frontmatterTable(container: HTMLElement): HTMLTableElement | null {
  const th = container.querySelector('th[scope="row"]');
  return th ? th.closest('table') : null;
}

function rowsOf(table: HTMLTableElement): Array<[string, string]> {
  return [...table.querySelectorAll('tr')].map((tr) => [
    tr.querySelector('th')?.textContent ?? '',
    tr.querySelector('td')?.textContent ?? '',
  ]);
}

describe('frontmatter rendering — YAML', () => {
  it('renders the block as a key/value table', () => {
    const { container } = renderMarkdown(`---
title: Deploy guide
tags: [ops, deploy]
draft: false
---

# Deploy guide

Body text.
`);
    const table = frontmatterTable(container);
    expect(table).not.toBeNull();
    expect(rowsOf(table as HTMLTableElement)).toEqual([
      ['title', 'Deploy guide'],
      ['tags', '[ops, deploy]'],
      ['draft', 'false'],
    ]);
  });

  it('still renders the document body after the table', () => {
    const { container } = renderMarkdown('---\ntitle: x\n---\n\n# Heading\n\nBody text.\n');
    expect(screen.getByText('Heading', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
    // Table precedes the heading in document order.
    const table = frontmatterTable(container);
    const heading = container.querySelector('h1');
    expect(table?.compareDocumentPosition(heading as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('does not emit a horizontal rule for the delimiters', () => {
    // The original bug: `---` opened a thematic break and the metadata leaked
    // into the body as text.
    const { container } = renderMarkdown('---\ntitle: x\n---\n\nBody.\n');
    expect(container.querySelector('hr')).toBeNull();
  });

  it('shows a nested block verbatim rather than dropping it', () => {
    const { container } = renderMarkdown(`---
title: Notes
tags:
  - ops
  - deploy
---

Body.
`);
    const rows = rowsOf(frontmatterTable(container) as HTMLTableElement);
    expect(rows[0]).toEqual(['title', 'Notes']);
    expect(rows[1][0]).toBe('tags');
    // Continuation lines are appended verbatim — no invented structure.
    expect(rows[1][1]).toContain('- ops');
    expect(rows[1][1]).toContain('- deploy');
  });

  it('skips comments and blank lines', () => {
    const { container } = renderMarkdown(`---
# a comment
title: x

draft: true
---

Body.
`);
    expect(rowsOf(frontmatterTable(container) as HTMLTableElement)).toEqual([
      ['title', 'x'],
      ['draft', 'true'],
    ]);
  });

  it('renders an empty value as an empty cell, not a missing row', () => {
    const { container } = renderMarkdown('---\ntitle:\ndraft: true\n---\n\nBody.\n');
    expect(rowsOf(frontmatterTable(container) as HTMLTableElement)).toEqual([
      ['title', ''],
      ['draft', 'true'],
    ]);
  });

  it('renders nothing for a frontmatter block with no recognisable keys', () => {
    const { container } = renderMarkdown('---\njust prose, no keys\n---\n\nBody.\n');
    expect(frontmatterTable(container)).toBeNull();
    expect(screen.getByText('Body.')).toBeInTheDocument();
  });
});

describe('frontmatter rendering — TOML', () => {
  it('renders the block as a key/value table', () => {
    const { container } = renderMarkdown(`+++
title = "Notes"
draft = true
+++

# Notes
`);
    expect(rowsOf(frontmatterTable(container) as HTMLTableElement)).toEqual([
      ['title', '"Notes"'],
      ['draft', 'true'],
    ]);
  });

  it('scopes keys under their section', () => {
    const { container } = renderMarkdown(`+++
title = "Notes"

[author]
name = "Nathan"
+++

Body.
`);
    expect(rowsOf(frontmatterTable(container) as HTMLTableElement)).toEqual([
      ['title', '"Notes"'],
      ['author.name', '"Nathan"'],
    ]);
  });
});

describe('frontmatter rendering — not confused with content', () => {
  it('leaves a mid-document --- as a horizontal rule', () => {
    const { container } = renderMarkdown('Intro.\n\n---\n\nOutro.\n');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(frontmatterTable(container)).toBeNull();
  });

  it('does not turn a normal GFM table into a frontmatter table', () => {
    const { container } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(container.querySelector('table')).not.toBeNull();
    expect(frontmatterTable(container)).toBeNull();
  });

  it('escapes HTML in frontmatter values instead of injecting it', () => {
    const { container } = renderMarkdown(
      '---\ntitle: <img src=x onerror=alert(1)>\n---\n\nBody.\n',
    );
    const rows = rowsOf(frontmatterTable(container) as HTMLTableElement);
    expect(rows[0][1]).toContain('<img');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('frontmatter panel — styling hook', () => {
  it('carries the frontmatter class through sanitization', () => {
    const { container } = renderMarkdown('---\ntitle: x\n---\n\nBody.\n');
    const table = container.querySelector('table');
    expect(table?.classList.contains(FRONTMATTER_TABLE_CLASS)).toBe(true);
  });

  it('labels the panel with a caption', () => {
    const { container } = renderMarkdown('---\ntitle: x\n---\n\nBody.\n');
    expect(container.querySelector('table > caption')?.textContent).toBe('Frontmatter');
  });

  it('does not put the class on a normal content table', () => {
    const { container } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.classList.contains(FRONTMATTER_TABLE_CLASS)).toBe(false);
  });

  it('drops a raw HTML table from a document entirely', () => {
    // Measured: this chain has no rehype-raw, so `raw` nodes never become
    // elements and raw HTML renders as nothing. That — not the className
    // restriction — is what stops a document from reaching the panel styling.
    // The restriction is defence in depth if raw HTML is ever enabled.
    const { container } = renderMarkdown(
      '<table class="fixed inset-0 z-50"><tbody><tr><td>x</td></tr></tbody></table>\n',
    );
    expect(container.querySelector('table')).toBeNull();
  });

  it('keeps the frontmatter class as the only permitted table class', () => {
    // Guards the schema entry itself: the frontmatter value survives, and the
    // arbitrary one does not. Asserted against the schema rather than through
    // markdown, since markdown cannot deliver either.
    const tableRule = markdownSanitizeSchema.attributes.table;
    expect(tableRule).toEqual([['className', FRONTMATTER_TABLE_CLASS]]);
  });
});
