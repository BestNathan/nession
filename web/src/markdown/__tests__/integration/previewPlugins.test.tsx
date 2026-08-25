import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import {
  getRehypePlugins,
  getRemarkPlugins,
  getRemarkRehypeOptions,
} from '@/markdown/previewPlugins';

/**
 * These render through the real plugin chain — including `remarkRehypeOptions`,
 * which is what MarkdownPreview passes — rather than asserting on the plugin
 * array: the array shape proves nothing about what reaches the DOM.
 *
 * Frontmatter rendering itself is covered in `frontmatterTable.test.tsx`; what
 * matters here is that adding it did not disturb the rest of the chain.
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

describe('preview plugins — frontmatter', () => {
  it('consumes the delimiters instead of emitting a horizontal rule', () => {
    // The original bug: `---` opened a thematic break and the metadata leaked
    // into the body as a setext heading plus text.
    const { container } = renderMarkdown('---\ntitle: x\n---\n\nBody.\n');
    expect(container.querySelector('hr')).toBeNull();
    expect(screen.getByText('Body.')).toBeInTheDocument();
  });

  it('still renders the document body after a frontmatter block', () => {
    renderMarkdown('---\ntitle: Deploy guide\n---\n\n# Deploy guide\n\nBody text.\n');
    expect(screen.getByText('Deploy guide', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
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
