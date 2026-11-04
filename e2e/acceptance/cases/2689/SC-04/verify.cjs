'use strict';
// #2689 SC-04: missing Session/cwd, absent Memory, disabled Memory, an
// unverifiable override and read failures are distinct answers; unresolved
// identity never falls back to a global scan or a guessed directory.
const { verifyClaudeMemoryCase } = require('../../../shared/claude-memory-cases.cjs');

verifyClaudeMemoryCase({
  summary:
    'Every resolver outcome has its own state: unavailable, no_memory, disabled, unsupported_override and error; the non-Git fallback is the project root and an unverifiable override never becomes the default directory.',
  rust: [
    'agent::tests::memory_states_stay_distinct',
    'memory::tests::a_non_git_directory_falls_back_to_its_own_root',
    'memory::tests::auto_memory_directory_is_reported_as_unverifiable',
    'memory::tests::auto_memory_disabled_is_a_distinct_state',
    'memory::tests::conflicting_auto_memory_settings_are_unverifiable',
    'memory::tests::a_policy_override_also_makes_the_location_unverifiable',
    'agent::tests::a_malformed_memory_request_is_answered_rather_than_dropped',
  ],
  web: {
    files: [
      'src/capabilities/claude-code/components/__tests__/integration/MemoryView.test.tsx',
      'src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx',
    ],
    names: [
      'keeps every provider state as its own sentence',
      'renders an unverifiable memory location as its own state, not a default list',
    ],
  },
});
