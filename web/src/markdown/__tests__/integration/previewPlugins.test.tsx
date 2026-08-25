import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { getRehypePlugins, getRemarkPlugins } from '@/markdown/previewPlugins';

/**
 * These render through the real plugin chain rather than asserting on the plugin
 * array: the array shape proves nothing about whether frontmatter is actually
 * stripped or a table actually becomes a table.
 */
function renderMarkdown(content: string) {
  return render(
    <ReactMarkdown remarkPlugins={getRemarkPlugins()} rehypePlugins={getRehypePlugins()}>
      {content}
    </ReactMarkdown>,
  );
}

describe('preview plugins — frontmatter', () => {
  it('strips a YAML frontmatter block from the rendered output', () => {
    const { container } = renderMarkdown(`---
title: Deploy guide
tags: [ops, deploy]
---

# Deploy guide

Body text.
`);
    expect(screen.getByText('Deploy guide', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
    expect(container.textContent).not.toContain('title:');
    expect(container.textContent).not.toContain('tags:');
  });

  it('strips a TOML frontmatter block from the rendered output', () => {
    const { container } = renderMarkdown(`+++
title = "Notes"
draft = true
+++

# Notes
`);
    expect(screen.getByText('Notes', { selector: 'h1' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('title =');
    expect(container.textContent).not.toContain('draft');
  });

  it('does not render frontmatter as a horizontal rule', () => {
    // The old chain had no frontmatter plugin, so `---` opened a thematic break
    // and the metadata leaked into the body as a setext heading plus text.
    const { container } = renderMarkdown('---\ntitle: x\n---\n\nBody.\n');
    expect(container.querySelector('hr')).toBeNull();
  });

  it('still treats a mid-document --- as a horizontal rule', () => {
    const { container } = renderMarkdown('Intro.\n\n---\n\nOutro.\n');
    expect(container.querySelector('hr')).not.toBeNull();
  });
});

describe('preview plugins — GFM', () => {
  it('renders tables', () => {
    const { container } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders task lists as checkboxes', () => {
    const { container } = renderMarkdown('- [x] done\n- [ ] pending\n');
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
  });

  it('renders strikethrough', () => {
    const { container } = renderMarkdown('~~gone~~\n');
    expect(container.querySelector('del')).not.toBeNull();
  });
});

describe('preview plugins — sanitization', () => {
  it('strips script tags', () => {
    const { container } = renderMarkdown('Hi\n\n<script>window.x = 1</script>\n');
    expect(container.querySelector('script')).toBeNull();
  });

  it('keeps language class names on code blocks for highlighting', () => {
    const { container } = renderMarkdown('```js\nconst a = 1;\n```\n');
    const code = container.querySelector('code');
    expect(code?.className).toContain('language-js');
  });
});
