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
        // Verify KaTeX elements are present
        expect(container.querySelector('.katex')).toBeInTheDocument();
      });
    }
  });

  describe('CJK text', () => {
    for (const testCase of cjkCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Verify CJK text is rendered
        expect(container.textContent).toBeTruthy();
        // Verify emphasis and code are present
        if (testCase.markdown.includes('**')) {
          expect(container.querySelector('strong')).toBeInTheDocument();
        }
        if (testCase.markdown.includes('`')) {
          expect(container.querySelector('code')).toBeInTheDocument();
        }
      });
    }
  });

  describe('environment variables', () => {
    for (const testCase of envVarCases) {
      it(testCase.name, () => {
        const container = renderCase(testCase);
        // Note: Single $ is currently parsed as math (known limitation).
        // This will be fixed in a future phase to treat $HOME, $PATH, $100 as plain text.
        // For now, we just verify the content renders without errors.
        expect(container.querySelector('.markdown')).toBeInTheDocument();

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
