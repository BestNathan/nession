'use strict';
// #3499 SC-04 (agent): a manifest grant mounts the layer identity and shares
// one payload through the existing authorized blob route.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests(
    'nession-agent',
    ['managed_session::tests::a_manifest_grant_mounts_the_layer_identity_and_shares_one_payload'],
    600_000,
  );
  assertRan(agent, [
    'managed_session::tests::a_manifest_grant_mounts_the_layer_identity_and_shares_one_payload',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent consumed a Manifest grant through the existing ' +
      'authorized blob route, mounted by EROFS layer identity and shared one payload',
  });
  return 'A manifest grant mounts the layer identity and shares one payload';
});
