'use strict';
// #4081 SC-03: through the real Agent P2P route, invalid initial metadata is
// refused before any Session side effect — the same name remains creatable
// immediately afterwards.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST =
  'server::integration_session_create_rejects_invalid_initial_metadata_before_side_effects';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    300000,
    isolatedTmuxEnv('nession-4081-sc03-route'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' + sha + ': an agent.session.create with an ' +
      'over-limit title was answered with invalid_metadata before the Session ' +
      'backend, and the same name was creatable immediately afterwards',
  });
  return 'Invalid input is refused before any Session side effect on the real route';
});
