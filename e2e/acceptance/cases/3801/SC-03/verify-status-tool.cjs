'use strict';
// #3801 SC-03: the source-owned #3779 MCP status Tool keeps its typed contract
// and verified answer; the Activity adapter consumes it rather than replacing
// it with a second status engine.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'it_returns_the_typed_verified_status',
  'the_output_contract_names_every_state_and_identity_field',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-claude-code',
    ['--lib', 'nession_claude_status'],
    110000,
  );
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: nession_claude_status still returns its typed, ` +
      'verified output contract with process/activity/conversation identity, ' +
      'so the Activity adapter reused the source owner instead of adding a ' +
      'second Claude status engine',
  });
  return 'The #3779 Claude status Tool remains the typed source owner consumed by the Activity adapter';
});
