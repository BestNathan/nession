'use strict';
// #2689 SC-03: MEMORY.md and topic Markdown are readable through the existing
// bounded read boundary; unrelated files and escapes are refused.
const { verifyClaudeMemoryCase } = require('../../../shared/claude-memory-cases.cjs');

verifyClaudeMemoryCase({
  summary:
    'The selected repository\'s MEMORY.md and topic Markdown are listed and read with canonical-root containment, Markdown-only validation and bounded pages; unrelated or escaping paths are refused.',
  rust: [
    'memory::tests::the_index_is_listed_first_and_only_markdown_is_listed',
    'memory::tests::a_symlink_is_never_listed',
    'security::tests::memory_reads_are_markdown_only',
    'agent::tests::memory_reads_are_bounded_and_cannot_escape_the_memory_directory',
  ],
  web: {
    files: [
      'src/capabilities/claude-code/components/__tests__/integration/MemoryView.test.tsx',
    ],
    names: ['shows the resolved source and opens the selected file'],
  },
});
