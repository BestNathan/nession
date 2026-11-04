'use strict';
// #2689 SC-01: the current Session resolves its containing repository without
// a picker; a nested directory resolves to the same root and the Workspace
// opens this repository's Memory.
const { verifyClaudeMemoryCase } = require('../../../shared/claude-memory-cases.cjs');

verifyClaudeMemoryCase({
  summary:
    'A Session in a nested repository directory resolves to the repository root with no project input; the Workspace opens that repository\'s Memory.',
  rust: [
    'memory::tests::a_nested_directory_resolves_to_the_repository_root',
    'memory::tests::the_project_key_matches_claudes_sanitization',
    'agent::tests::memory_resolves_the_session_repository_without_a_picker',
  ],
  web: {
    files: [
      'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx',
    ],
    names: ['opens the Session repository memory with no repository picker'],
  },
});
