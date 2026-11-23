'use strict';
// #4302 SC-02: the canonical Protocol carries the optional incarnation
// precondition on the Agent, Client and Server kill payloads without changing
// legacy name-only wire bytes, and the reply declares the guarded refusal
// classification.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

const TESTS = [
  'contracts::session::tests::agent_session_kill_payload_carries_an_optional_incarnation_precondition',
  'contracts::session::tests::test_client_session_kill_payload',
  'contracts::session::tests::test_server_session_kill_payload',
  'contracts::session::tests::web_session_kill_response_classifies_a_guarded_refusal',
];

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests('nession-protocol', ['--lib', 'contracts::session::tests::'], 110000);
  assertRan(out, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the canonical Session kill payloads accept and emit the optional ' +
      'expected_instance_id while legacy name-only payload bytes stay unchanged, and the kill ' +
      'reply declares its error_kind classification',
  });
  return 'The Protocol kernel owns the optional kill incarnation precondition and the typed refusal reply';
});
