/**
 * Comprehensive Markdown test corpus for Chat rendering verification.
 *
 * This corpus covers all Markdown features used in Chat messages, including
 * edge cases like CJK text, environment variables, open fences, and nested
 * structures. Used by fixture tests and Playwright E2E tests.
 */

export interface MarkdownTestCase {
  name: string;
  markdown: string;
  description?: string;
}

/**
 * Basic Markdown elements: paragraphs, headings, emphasis, links.
 */
export const basicCases: MarkdownTestCase[] = [
  {
    name: 'simple-paragraph',
    markdown: 'Hello, world!',
    description: 'Simple paragraph with no formatting',
  },
  {
    name: 'multiple-paragraphs',
    markdown: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
    description: 'Multiple paragraphs separated by blank lines',
  },
  {
    name: 'headings-all-levels',
    markdown: '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6',
    description: 'All six heading levels',
  },
  {
    name: 'emphasis-variations',
    markdown: '*italic* and **bold** and ***bold italic*** and ~~strikethrough~~',
    description: 'Various emphasis styles',
  },
  {
    name: 'links-basic',
    markdown: '[Example](https://example.com) and [relative](/path/to/page)',
    description: 'Basic links with absolute and relative URLs',
  },
];

/**
 * Code blocks: inline code, fenced blocks with languages, empty blocks.
 */
export const codeCases: MarkdownTestCase[] = [
  {
    name: 'inline-code',
    markdown: 'Use `console.log()` for debugging.',
    description: 'Inline code with backticks',
  },
  {
    name: 'fenced-code-javascript',
    markdown: '```javascript\nfunction hello() {\n  console.log("Hello, world!");\n}\n```',
    description: 'Fenced code block with JavaScript',
  },
  {
    name: 'fenced-code-python',
    markdown: '```python\ndef hello():\n    print("Hello, world!")\n```',
    description: 'Fenced code block with Python',
  },
  {
    name: 'fenced-code-rust',
    markdown: '```rust\nfn main() {\n    println!("Hello, world!");\n}\n```',
    description: 'Fenced code block with Rust',
  },
  {
    name: 'fenced-code-no-language',
    markdown: '```\nplain text\n```\n',
    description: 'Fenced code block without language',
  },
  {
    name: 'fenced-code-empty',
    markdown: '```javascript\n```',
    description: 'Empty fenced code block',
  },
];

/**
 * Lists: ordered, unordered, nested, task lists.
 */
export const listCases: MarkdownTestCase[] = [
  {
    name: 'unordered-list',
    markdown: '- Item 1\n- Item 2\n- Item 3',
    description: 'Simple unordered list',
  },
  {
    name: 'ordered-list',
    markdown: '1. First\n2. Second\n3. Third',
    description: 'Simple ordered list',
  },
  {
    name: 'nested-list',
    markdown: '- Parent 1\n  - Child 1\n  - Child 2\n- Parent 2',
    description: 'Nested unordered list',
  },
  {
    name: 'task-list',
    markdown: '- [x] Completed\n- [ ] Not completed\n- [ ] Another task',
    description: 'Task list with checkboxes',
  },
];

/**
 * Blockquotes and horizontal rules.
 */
export const blockCases: MarkdownTestCase[] = [
  {
    name: 'blockquote',
    markdown: '> This is a quote.\n> It can span multiple lines.',
    description: 'Blockquote with multiple lines',
  },
  {
    name: 'nested-blockquote',
    markdown: '> Outer quote\n> > Inner quote\n> Back to outer',
    description: 'Nested blockquotes',
  },
  {
    name: 'horizontal-rule',
    markdown: 'Before\n\n---\n\nAfter',
    description: 'Horizontal rule between paragraphs',
  },
];

/**
 * Tables: basic, with alignment, complex content.
 */
export const tableCases: MarkdownTestCase[] = [
  {
    name: 'simple-table',
    markdown: '| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |',
    description: 'Simple 2x2 table',
  },
  {
    name: 'table-with-alignment',
    markdown: '| Left | Center | Right |\n|:-----|:------:|------:|\n| L    | C      | R     |',
    description: 'Table with column alignment',
  },
  {
    name: 'table-with-code',
    markdown: '| Code | Description |\n|------|-------------|\n| `fn` | Function    |',
    description: 'Table with inline code',
  },
];

/**
 * Math: inline and display math with KaTeX.
 */
export const mathCases: MarkdownTestCase[] = [
  {
    name: 'inline-math',
    markdown: 'The formula \\(E=mc^2\\) is famous.',
    description: 'Inline math with \\(\\) delimiters',
  },
  {
    name: 'display-math',
    markdown: 'The equation:\n\n\\[x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\]',
    description: 'Display math with \\[\\] delimiters',
  },
  {
    name: 'display-math-dollars',
    markdown: '$$\nx^2 + y^2 = z^2\n$$',
    description: 'Display math with $$ delimiters',
  },
];

/**
 * CJK text: Chinese, Japanese, Korean characters with emphasis and code.
 */
export const cjkCases: MarkdownTestCase[] = [
  {
    name: 'cjk-chinese',
    markdown: '这是一段**中文**文本，包含`代码`。',
    description: 'Chinese text with emphasis and code',
  },
  {
    name: 'cjk-japanese',
    markdown: 'これは**日本語**のテキストです。`コード`を含みます。',
    description: 'Japanese text with emphasis and code',
  },
  {
    name: 'cjk-korean',
    markdown: '이것은 **한국어** 텍스트입니다. `코드`가 포함되어 있습니다.',
    description: 'Korean text with emphasis and code',
  },
  {
    name: 'cjk-mixed',
    markdown: 'Mixed: English and 中文 and 日本語 and 한국어',
    description: 'Mixed CJK and Latin text',
  },
];

/**
 * Environment variables and shell-like content: $HOME, $PATH, $100.
 */
export const envVarCases: MarkdownTestCase[] = [
  {
    name: 'env-var-home',
    markdown: 'Set `$HOME` to your home directory.',
    description: 'Environment variable $HOME in code',
  },
  {
    name: 'env-var-path',
    markdown: 'Add to `$PATH`: `export PATH=$HOME/bin:$PATH`',
    description: 'Multiple environment variables',
  },
  {
    name: 'env-var-dollar-amount',
    markdown: 'The cost is $100 and $200.',
    description: 'Dollar amounts (not math)',
  },
  {
    name: 'shell-command',
    markdown: '```bash\necho "Hello $USER"\nexport PATH=$HOME/bin:$PATH\n```',
    description: 'Shell script with environment variables',
  },
];

/**
 * Open fences: code blocks that are not yet closed (streaming state).
 */
export const openFenceCases: MarkdownTestCase[] = [
  {
    name: 'open-fence-javascript',
    markdown: '```javascript\nfunction hello() {\n  console.log("Hello");\n',
    description: 'Open JavaScript code fence (no closing)',
  },
  {
    name: 'open-fence-partial',
    markdown: '```python\ndef hello():\n    pri',
    description: 'Open Python code fence with partial content',
  },
  {
    name: 'open-fence-empty',
    markdown: '```rust\n',
    description: 'Open Rust code fence with no content',
  },
];

/**
 * Nested structures: lists with code blocks, blockquotes with lists.
 */
export const nestedCases: MarkdownTestCase[] = [
  {
    name: 'list-with-code',
    markdown: '- Item with code:\n\n  ```javascript\n  console.log("hello");\n  ```\n\n- Next item',
    description: 'List item containing code block',
  },
  {
    name: 'blockquote-with-list',
    markdown: '> Quote with list:\n> - Item 1\n> - Item 2',
    description: 'Blockquote containing list',
  },
  {
    name: 'complex-nesting',
    markdown: '# Heading\n\n- List with **bold** and `code`\n  - Nested list\n  - Another item\n\n> Quote with *emphasis*\n>\n> And a paragraph.\n\n```javascript\nconst x = 42;\n```',
    description: 'Complex nested structure',
  },
];

/**
 * Edge cases: special characters, long lines, empty content.
 */
export const edgeCases: MarkdownTestCase[] = [
  {
    name: 'special-characters',
    markdown: 'Special: <>&"\' and symbols: ©®™',
    description: 'Special characters and symbols',
  },
  {
    name: 'long-line',
    markdown: 'This is a very long line that should wrap properly in the rendered output without causing layout issues or horizontal scrollbars in the chat interface.',
    description: 'Long line that needs wrapping',
  },
  {
    name: 'empty-content',
    markdown: '',
    description: 'Empty content',
  },
  {
    name: 'whitespace-only',
    markdown: '   \n\n   ',
    description: 'Whitespace-only content',
  },
];

/**
 * All test cases combined.
 */
export const allCases: MarkdownTestCase[] = [
  ...basicCases,
  ...codeCases,
  ...listCases,
  ...blockCases,
  ...tableCases,
  ...mathCases,
  ...cjkCases,
  ...envVarCases,
  ...openFenceCases,
  ...nestedCases,
  ...edgeCases,
];
