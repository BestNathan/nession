'use strict';
// #3794 SC-02 (Agent): preparation turns the granted artifacts into the
// pinned composition before the Session exists. Split from the Server target
// so each verifier stays inside the Acceptance process bound.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests::']);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent prepared the composition from the pinned grants and its ' +
      'durable cache before the Session existed',
  });
  return 'The Agent prepared the pinned Managed composition before creating the Session';
});
