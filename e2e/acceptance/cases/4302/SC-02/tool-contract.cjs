'use strict';
// #4302 SC-02: the AI-facing `nession_agent_kill_session` Tool requires a
// non-empty `expected_instance_id` in its schema, forwards it to the named
// Agent, and refuses a missing or empty identity as `invalid_argument` without
// reaching the backend.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

const TESTS = [
  'tools::nession_agent_kill_session::tests::it_kills_on_the_named_agent_with_the_observed_instance',
  'tools::nession_agent_kill_session::tests::its_schema_requires_every_identity_field',
  'tools::nession_agent_kill_session::tests::a_missing_expected_instance_is_refused',
  'tools::nession_agent_kill_session::tests::an_empty_expected_instance_is_refused',
];

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--lib', 'tools::nession_agent_kill_session::tests::'],
    110000,
  );
  assertRan(out, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the kill Tool schema requires agent_id, name and ' +
      'expected_instance_id; a present identity is forwarded with the named Agent; a missing or ' +
      'empty identity fails as invalid_argument with no backend call',
  });
  return 'The AI-facing kill Tool requires and forwards the caller-observed instance and refuses a missing one explicitly';
});
