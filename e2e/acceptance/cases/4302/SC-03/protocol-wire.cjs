'use strict';
// #4302 SC-03: the kill reply's typed classification is part of the canonical
// wire, so an indeterminate/failed guarded kill is reported as such rather
// than as a silent success that a caller could retry blindly.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

const TESTS = [
  'contracts::session::tests::agent_session_kill_payload_carries_an_optional_incarnation_precondition',
  'contracts::session::tests::web_session_kill_response_classifies_a_guarded_refusal',
];

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests('nession-protocol', ['--lib', 'contracts::session::tests::'], 110000);
  assertRan(out, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the canonical kill reply carries an optional classified error_kind ' +
      'for guarded refusals while a legacy success or refusal carries none, and the payload keeps ' +
      'the caller\'s precondition optional',
  });
  return 'The Protocol declares the guarded kill refusal classification that makes an indeterminate outcome explicit';
});
