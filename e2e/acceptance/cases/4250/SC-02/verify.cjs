'use strict';
// #4250 SC-02 (SCN-03): the migrated production path. The Server derives the
// repository whose Tags reach the resolved Manifest (v2_repository_for_manifest)
// and issues repository-scoped standard OCI /v2/ grants; the Agent fetches the
// verified EROFS Manifest closure through the unified SDK/cache with cold/warm
// reuse, restart-safe adoption, tag-move pin stability and lease-protected
// eviction. No proprietary /images/blobs/ URL appears in the authorized closure.
// The proof runs the real Server RegistryService on a loopback TCP ingress against
// a real Agent EROFS cache.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc02_migrated_grants_fetch_via_v2_with_warm_restart_and_lease';
const MEASURED = /^#4250 SC-02 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-erofs',
    ['--lib', '--features', 'cache,registry,mount', TEST],
    600000,
  );
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-02 migrated /v2/ parity measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-02: the Server issues repository-scoped /v2/ grants for a Tag-reachable Manifest and the Agent fetches the verified closure via the unified SDK/cache with cold/warm reuse, restart adoption, tag-move pin stability and lease-protected eviction (no proprietary URL)';
});
