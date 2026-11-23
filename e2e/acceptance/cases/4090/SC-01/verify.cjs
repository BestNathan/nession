'use strict';
// #4090 SC-01 (SCN-04): the Server host adapter mounts the shared /v2/ Registry
// over its own CAS/Catalog/Token authority, imports an approved external OCI
// image into its authoritative CAS/Catalog through the common SDK adapter, serves
// it via the standard /v2/ endpoint, and rejects denied imports before any
// network request or catalog write. Trusted isolated loopback fixtures stand in
// for the external provider; no production registry secret is used.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'image::registry::tests::sc01_server_mount_serves_verified_objects_and_fails_closed',
  'image::registry::tests::sc01_server_import_persists_immutable_identity_and_denies_before_network',
  'image::registry::tests::sc01_no_auth_mode_parity_with_proprietary_route',
];
const MEASURED = /^#4090 SC-01 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-server', ['--lib', 'image::registry::tests'], 600000);
  assertRan(output, TESTS);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-01 Server import/mount measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-01: Server imports an approved external OCI image into its CAS/Catalog, serves it via /v2/, fails closed on identity and repository scope, and denies unapproved imports before secrets or writes';
});