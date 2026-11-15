'use strict';
// #3499 SC-04 (server): scoped Manifest grants keep authorization independent
// across two consumers sharing one layer, record/release the resolved Manifest
// pin, serve only verified catalog bytes, and mint reachable-object grants.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests(
    'nession-server',
    ['image::tests::manifest_resolution_shares_one_layer_but_not_authorization'],
    600_000,
  );
  assertRan(server, [
    'image::tests::manifest_resolution_shares_one_layer_but_not_authorization',
  ]);

  const binding = crateTests(
    'nession-server',
    ['image::tests::a_session_binding_records_and_releases_the_resolved_manifest_pin'],
    600_000,
  );
  assertRan(binding, [
    'image::tests::a_session_binding_records_and_releases_the_resolved_manifest_pin',
  ]);

  const served = crateTests(
    'nession-server',
    ['image::tests::catalog_metadata_is_served_only_after_digest_and_size_verification'],
    600_000,
  );
  assertRan(served, [
    'image::tests::catalog_metadata_is_served_only_after_digest_and_size_verification',
  ]);

  const handler = crateTests(
    'nession-server',
    ['a_manifest_create_mints_reachable_object_grants_and_records_the_binding'],
    600_000,
  );
  assertRan(handler, [
    'a_manifest_create_mints_reachable_object_grants_and_records_the_binding',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two authorized consumers shared one EROFS layer without ' +
      'sharing authorization, a Session binding recorded and released its resolved Manifest ' +
      'pin, catalog bytes were served only after digest/size verification, and a Manifest ' +
      'create minted reachable-object grants',
  });
  return 'Server grants stay Manifest-scoped and reachability-checked while layers are shared';
});
