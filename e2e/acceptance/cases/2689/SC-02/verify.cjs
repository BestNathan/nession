'use strict';
// #2689 SC-02: sibling worktrees of one repository share the main working
// copy's Memory; a different repository never exposes it.
const { verifyClaudeMemoryCase } = require('../../../shared/claude-memory-cases.cjs');

verifyClaudeMemoryCase({
  summary:
    'Linked worktrees resolve to the main working copy\'s Auto Memory while a separate repository resolves to its own directory and cannot see the first repository\'s files.',
  rust: [
    'memory::tests::linked_worktrees_share_the_main_working_copy_identity',
    'memory::tests::a_submodule_keeps_its_own_working_root_as_identity',
    'memory::tests::two_repositories_do_not_share_a_key',
    'agent::tests::worktrees_share_memory_and_another_repository_cannot_see_it',
  ],
});
