import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview, MarkdownErrorBoundary } from '@/components/MarkdownPreview';

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
    const { container } = render(<MarkdownPreview content={content} filename="test.md" />);
    // highlight.js tokenizes the source into multiple <span>s, so assert on the
    // <pre> block's text content rather than a single contiguous text node.
    const pre = container.querySelector('pre');
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toContain('const x = 1');
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

describe('MarkdownErrorBoundary', () => {
  it('renders children when no error', () => {
    const { container } = render(
      <MarkdownErrorBoundary onFallback={() => {}}>
        <p>Safe content</p>
      </MarkdownErrorBoundary>
    );
    expect(container.textContent).toContain('Safe content');
  });

  it('shows fallback UI on render error', () => {
    // Suppress React's error log for this test
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handleFallback = vi.fn();
    const Thrower = () => {
      throw new Error('Test render error');
    };

    render(
      <MarkdownErrorBoundary onFallback={handleFallback}>
        <Thrower />
      </MarkdownErrorBoundary>
    );

    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getByText('Show raw')).toBeInTheDocument();

    spy.mockRestore();
  });
});
