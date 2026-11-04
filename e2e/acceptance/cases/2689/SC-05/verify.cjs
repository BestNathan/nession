'use strict';
// #2689 SC-05: a Session switch or a repository/configuration change between
// list and read cannot display the old or another repository's Memory.
const { verifyClaudeMemoryCase } = require('../../../shared/claude-memory-cases.cjs');

verifyClaudeMemoryCase({
  summary:
    'A read carrying the previous snapshot\'s directory is refused as stale_memory, and the Workspace drops pending snapshot/read answers across Session and repository changes.',
  rust: [
    'agent::tests::a_read_from_a_moved_repository_is_stale_memory',
  ],
  web: {
    files: [
      'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx',
    ],
    names: [
      're-lists when the provider reports the repository moved',
      'drops a pending memory answer from the previous Session',
      'drops a pending file read when the memory directory changes',
    ],
  },
});
