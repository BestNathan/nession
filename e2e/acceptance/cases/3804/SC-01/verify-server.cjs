'use strict';
// #3804 SC-01 (server half): the verified level reaches the shared Session
// projection that backs both `server.session.list` and the push, lifecycle and
// recency stay independent, and a legacy Agent's missing Activity is absent
// (unknown), not idle.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'an_activity_level_reaches_the_shared_session_projection',
  'a_legacy_agent_session_lists_activity_as_absent',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-server',
    ['--lib', 'server_agent_session_activity'],
    90000,
  );
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: an Agent's verified level appeared in the same ` +
      'Session projection used by the list and push; status stayed detached ' +
      'and last_activity was unchanged; a Session with no reported Activity ' +
      'projected it as absent, not idle',
  });
  return 'A verified Activity level reaches the shared Server projection without touching lifecycle or recency';
});
