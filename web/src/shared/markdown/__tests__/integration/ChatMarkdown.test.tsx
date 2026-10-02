/**
 * Fixture tests for ChatMarkdown rendering.
 *
 * Verifies that all Markdown corpus cases render without errors and produce
 * the expected DOM structure. These tests ensure the incremental parser and
 * renderer handle all supported Markdown features correctly.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChatMarkdown } from '../../ChatMarkdown';
import {
  allCases,
  basicCases,
  codeCases,
  listCases,
  blockCases,
  tableCases,
  mathCases,
  tildeCases,
  htmlCases,
  referenceCases,
  cjkCases,
  envVarCases,
  openFenceCases,
  nestedCases,
  edgeCases,
  type MarkdownTestCase,
} from '../fixtures/markdownCorpus';

/**
 * Render a test case and verify it produces output without errors.
 */
function renderCase(testCase: MarkdownTestCase) {
  const { container } = render(<ChatMarkdown text={testCase.markdown} />);
  return container;
}

describe('ChatMarkdown fixture tests', () => {
  describe('all corpus cases render without errors', () => {
    for (const testCase of allCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify something was rendered (even empty content renders a wrapper)
        expect(container.querySelector('.markdown')).toBeInTheDocument();
      });
    }
  });

  describe('basic elements', () => {
    for (const testCase of basicCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify basic elements are present
        if (testCase.name.includes('heading')) {
          // headings-all-levels has 6 headings
          const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
          expect(headings.length).toBeGreaterThan(0);
        }
        if (testCase.name.includes('paragraph')) {
          // multiple-paragraphs has multiple paragraphs
          const paragraphs = container.querySelectorAll('p');
          expect(paragraphs.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe('code blocks', () => {
    for (const testCase of codeCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify code elements are present
        if (testCase.name.includes('inline')) {
          expect(container.querySelector('code')).toBeInTheDocument();
        }
        if (testCase.name.includes('fenced')) {
          expect(container.querySelector('pre')).toBeInTheDocument();
          // Code blocks with a language should have the language testid
          if (!testCase.name.includes('no-language') && !testCase.name.includes('empty')) {
            expect(container.querySelector('[data-testid="code-block-language"]')).toBeInTheDocument();
          }
        }
      });
    }
  });

  describe('lists', () => {
    for (const testCase of listCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify list elements are present
        const hasList = container.querySelector('ul') || container.querySelector('ol');
        expect(hasList).toBeInTheDocument();
        if (testCase.name.includes('task')) {
          expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
        }
      });
    }
  });

  describe('block elements', () => {
    for (const testCase of blockCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify block elements are present
        if (testCase.name.includes('blockquote')) {
          expect(container.querySelector('blockquote')).toBeInTheDocument();
        }
        if (testCase.name.includes('horizontal')) {
          expect(container.querySelector('hr')).toBeInTheDocument();
        }
      });
    }
  });

  describe('tables', () => {
    for (const testCase of tableCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        if (testCase.name === 'table-partial-header') {
          // The delimiter row has not arrived: not a table yet, and not an
          // error either — the source stays visible until it completes.
          expect(container.querySelector('table')).not.toBeInTheDocument();
          expect(container.textContent).toContain('| Header 1 | Header 2 |');
          return;
        }
        // Verify table elements are present
        expect(container.querySelector('table')).toBeInTheDocument();
        expect(container.querySelectorAll('th').length).toBeGreaterThan(0);
        expect(container.querySelectorAll('td').length).toBeGreaterThan(0);
      });
    }
  });

  describe('math', () => {
    for (const testCase of mathCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // A complete construct renders through KaTeX; an unterminated inline
        // `\(` stays literal rather than flashing anything. A `$$` block
        // unterminated at end of document closes there — fence semantics, and
        // the settled result is authoritative.
        const literalOnly = testCase.name === 'unclosed-inline-math';
        expect(container.querySelectorAll('.katex').length > 0).toBe(!literalOnly);
        expect(container.querySelector('.katex-error')).not.toBeInTheDocument();
      });
    }
  });

  describe('tilde in prose (#1184 SC-09)', () => {
    for (const testCase of tildeCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        const struckThrough = testCase.markdown.includes('~~');
        // ~/.claude, ~10ms and 60~70% must never become struck-through text;
        // the explicit double tilde still does.
        expect(container.querySelectorAll('del').length > 0).toBe(struckThrough);
      });
    }
  });

  describe('raw HTML is literal text (#1184 SC-10)', () => {
    for (const testCase of htmlCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // The tag's own markup is visible as text …
        expect(container.textContent).toContain('<');
        // … and no element was created for it, so nothing executed.
        expect(container.querySelector('script')).not.toBeInTheDocument();
        expect(container.querySelector('details')).not.toBeInTheDocument();
        expect(container.querySelector('tool_call')).not.toBeInTheDocument();
        // A raw <table> is not the GFM table renderer's output either.
        if (testCase.name === 'html-raw-table') {
          expect(container.querySelector('table')).not.toBeInTheDocument();
        }
      });
    }
  });

  describe('references and footnotes (#1184 SC-14)', () => {
    for (const testCase of referenceCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        if (testCase.name === 'link-reference-resolved') {
          const anchor = container.querySelector('a[href="https://example.com/nession"]');
          expect(anchor).toBeInTheDocument();
          expect(anchor).toHaveTextContent('stream replay notes');
        }
        if (testCase.name === 'link-reference-missing') {
          // Unresolved: literal bracketed source text, and nothing clickable.
          expect(container.querySelector('a')).not.toBeInTheDocument();
          expect(container.textContent).toContain('[stream replay notes][missing]');
        }
        if (testCase.name === 'footnote-resolved') {
          const reference = container.querySelector('sup a');
          expect(reference).toHaveTextContent('[1]');
          const section = container.querySelector('[data-footnotes]');
          expect(section).toBeInTheDocument();
          expect(section).toHaveTextContent('Only the attach path is covered.');
        }
        if (testCase.name === 'footnote-missing-definition') {
          // The grammar only emits a footnote call when the document defines
          // it, so an undefined one never becomes a number or a section.
          expect(container.querySelector('sup')).not.toBeInTheDocument();
          expect(container.textContent).toContain('[^missing]');
          expect(container.querySelector('[data-footnotes]')).not.toBeInTheDocument();
        }
      });
    }
  });

  describe('links degrade rather than promise (#1184 security)', () => {
    it('renders a relative destination as text, not an empty-href anchor', () => {
      const container = renderCase({ name: 'relative', markdown: 'See [the page](/path/to/page) for more.' });
      expect(container.textContent).toContain('the page');
      expect(container.querySelector('a')).not.toBeInTheDocument();
    });

    it('renders a local file destination as text', () => {
      const container = renderCase({ name: 'local', markdown: 'Open [the module](web/src/App.tsx) please.' });
      expect(container.textContent).toContain('the module');
      expect(container.querySelector('a')).not.toBeInTheDocument();
    });

    it('keeps http(s) destinations clickable', () => {
      const container = renderCase({ name: 'external', markdown: 'Read [the docs](https://example.com/docs).' });
      const anchor = container.querySelector('a[href="https://example.com/docs"]');
      expect(anchor).toBeInTheDocument();
      expect(anchor).toHaveAttribute('target', '_blank');
    });
  });

  describe('CJK text (#1184 SC-07)', () => {
    for (const testCase of cjkCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify CJK text is rendered
        expect(container.textContent).toBeTruthy();
        // Verify emphasis and code are present
        if (testCase.markdown.includes('**')) {
          const strong = container.querySelector('strong');
          expect(strong).toBeInTheDocument();
          // The strong run must close where the author closed it — a
          // CJK-friendly grammar that swallowed the following sentence would
          // still produce a <strong> element.
          if (testCase.name === 'cjk-strong-after-punctuation') {
            expect(strong).toHaveTextContent('重点。');
            expect(container.textContent).not.toContain('**');
          }
          if (testCase.name === 'cjk-strong-mid-sentence') {
            expect(strong).toHaveTextContent('重点');
            expect(container.textContent).not.toContain('**');
          }
        }
        if (testCase.markdown.includes('`')) {
          expect(container.querySelector('code')).toBeInTheDocument();
        }
      });
    }
  });

  describe('environment variables (#1184 SC-08)', () => {
    for (const testCase of envVarCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Single dollars are prose, never formulae — the whole point of
        // turning single-dollar text math off in the Chat profile.
        expect(container.querySelector('.katex')).not.toBeInTheDocument();

        if (testCase.name === 'env-var-dollar-amount') {
          expect(container.textContent).toContain('The cost is $100 and $200.');
        }
        if (testCase.name === 'env-var-home') {
          expect(container.textContent).toContain('$HOME');
        }

        // Shell commands with code blocks should render the code block
        if (testCase.name.includes('shell-command')) {
          expect(container.querySelector('pre')).toBeInTheDocument();
        }
      });
    }
  });

  describe('open fences (streaming state)', () => {
    for (const testCase of openFenceCases) {
      it(testCase.name, () => {
        // Render with streaming=true to test incremental parser
        const { container } = render(<ChatMarkdown text={testCase.markdown} streaming />);
        // Verify the markdown wrapper is present
        expect(container.querySelector('.markdown')).toBeInTheDocument();
        // Open fences with content should render code blocks
        // Empty fences might not render until content is added
        if (testCase.markdown.trim().length > testCase.markdown.indexOf('```') + 3) {
          // Has content after the opening fence
          expect(container.querySelector('pre')).toBeInTheDocument();
        }
      });
    }
  });

  describe('nested structures', () => {
    for (const testCase of nestedCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify nested elements are present
        if (testCase.name.includes('list-with-code')) {
          expect(container.querySelector('ul')).toBeInTheDocument();
          expect(container.querySelector('pre')).toBeInTheDocument();
        }
        if (testCase.name.includes('blockquote-with-list')) {
          expect(container.querySelector('blockquote')).toBeInTheDocument();
          expect(container.querySelector('ul')).toBeInTheDocument();
        }
      });
    }
  });

  describe('edge cases', () => {
    for (const testCase of edgeCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify wrapper is present even for empty content
        expect(container.querySelector('.markdown')).toBeInTheDocument();
      });
    }
  });

  describe('streaming vs settled rendering', () => {
    it('renders the same content in streaming and settled modes', () => {
      const markdown = '# Heading\n\nParagraph with **bold** and `code`.\n\n```javascript\nconst x = 42;\n```';

      const { container: streamingContainer } = render(
        <ChatMarkdown text={markdown} streaming />
      );
      const { container: settledContainer } = render(
        <ChatMarkdown text={markdown} streaming={false} />
      );

      // Both should have the same structure
      expect(streamingContainer.querySelector('h2')).toBeInTheDocument();
      expect(settledContainer.querySelector('h2')).toBeInTheDocument();
      expect(streamingContainer.querySelector('strong')).toBeInTheDocument();
      expect(settledContainer.querySelector('strong')).toBeInTheDocument();
      expect(streamingContainer.querySelector('code')).toBeInTheDocument();
      expect(settledContainer.querySelector('code')).toBeInTheDocument();
    });
  });
});
