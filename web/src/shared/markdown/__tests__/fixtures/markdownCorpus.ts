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
  {
    name: 'table-partial-header',
    markdown: '| Header 1 | Header 2 |\n|---',
    description: 'A table whose delimiter row is still arriving renders literally',
  },
];

/**
 * Math: inline and display math with KaTeX, plus the malformed shapes that
 * must stay literal rather than flashing a KaTeX error.
 */
export const mathCases: MarkdownTestCase[] = [
  {
    name: 'inline-math',
    markdown: 'The formula \\(E=mc^2\\) is famous.',
    description: 'Inline math with \\(\\) delimiters',
  },
  {
    name: 'display-math',
    // Multi-line on purpose: the delimiters on their own lines are the
    // canonical display form, and they are what walks the flow tokenizer's
    // line-continuation arm (`\[ ... \]` on one line never reaches it).
    markdown: 'The equation:\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n\\]',
    description: 'Display math with \\[\\] delimiters on their own lines',
  },
  {
    name: 'display-math-inline-block',
    markdown: 'The equation:\n\n\\[x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\]',
    description: 'Display math with \\[\\] delimiters on one line',
  },
  {
    name: 'display-math-dollars',
    markdown: '$$\nx^2 + y^2 = z^2\n$$',
    description: 'Display math with $$ delimiters',
  },
  {
    name: 'unclosed-inline-math',
    markdown: 'This \\(a + b never closes.',
    description: 'Unclosed \\( — stays literal text, never a KaTeX error',
  },
  {
    name: 'display-math-unterminated-at-eof',
    markdown: '$$\nx^2 + y^2 = z^2\n',
    description: 'An unterminated $$ closes at end of document (fence semantics)',
  },
];

/**
 * Tilde in prose: shell paths, durations and ranges are not strikethrough.
 * Only the explicit double tilde is (#1184 SC-09).
 */
export const tildeCases: MarkdownTestCase[] = [
  {
    name: 'tilde-dotfile-paths',
    markdown: 'The settings live in ~/.claude and ~/.config on this machine.',
    description: 'Dotfile paths with a single tilde are not strikethrough',
  },
  {
    name: 'tilde-duration-and-range',
    markdown: 'It finished in ~10ms, and 60~70% of the runs passed.',
    description: 'Approximation and range tildes are not strikethrough',
  },
  {
    name: 'tilde-explicit-strikethrough',
    markdown: 'This sentence is ~~struck through~~ on purpose.',
    description: 'The explicit double tilde still strikes through',
  },
];

/**
 * Raw HTML: assistant-authored tags are literal text, never executed and
 * never silently dropped (#1184 SC-10, decision 7).
 */
export const htmlCases: MarkdownTestCase[] = [
  {
    name: 'html-tool-call',
    markdown: '<tool_call>\n{"name": "Read", "path": "web/src/App.tsx"}\n</tool_call>',
    description: 'XML-like tool tag stays literal text',
  },
  {
    name: 'html-analysis-details',
    markdown: '<analysis>thinking out loud</analysis>\n\n<details>more</details>',
    description: 'Reasoning-style tags stay literal text',
  },
  {
    name: 'html-raw-table',
    markdown: '<table><tr><td>cell</td></tr></table>',
    description: 'A raw HTML table stays literal, not a rendered table',
  },
  {
    name: 'html-script',
    markdown: 'Before <script>alert(1)</script> after.',
    description: 'Script tags render as text and never execute',
  },
];

/**
 * Reference links and footnotes: settled rendering resolves the definitions
 * the document declares (#1184 SC-14).
 */
export const referenceCases: MarkdownTestCase[] = [
  {
    name: 'link-reference-resolved',
    markdown: 'See the [stream replay notes][notes] for the shape.\n\n[notes]: https://example.com/nession',
    description: 'A defined reference renders as its link',
  },
  {
    name: 'link-reference-missing',
    markdown: 'See the [stream replay notes][missing] for the shape.',
    description: 'An undefined reference stays literal text, not an anchor',
  },
  {
    name: 'footnote-resolved',
    markdown: 'The observer path has no test.[^observer]\n\n[^observer]: Only the attach path is covered.',
    description: 'A footnote renders a reference and a trailing section',
  },
  {
    name: 'footnote-missing-definition',
    markdown: 'The observer path has no test.[^missing]',
    description: 'A footnote call with no definition anywhere stays literal text',
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
  {
    name: 'cjk-strong-after-punctuation',
    markdown: '中文**重点。**下一句',
    description: '#1184 corpus: strong closes after a full-width period',
  },
  {
    name: 'cjk-strong-mid-sentence',
    markdown: '中文**重点**继续',
    description: '#1184 corpus: strong between CJK with no surrounding whitespace',
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
  ...tildeCases,
  ...htmlCases,
  ...referenceCases,
  ...cjkCases,
  ...envVarCases,
  ...openFenceCases,
  ...nestedCases,
  ...edgeCases,
];
