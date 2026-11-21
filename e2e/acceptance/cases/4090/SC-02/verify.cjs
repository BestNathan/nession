'use strict';
// #4090 SC-02 (SCN-03): a Session-authorized Agent obtains the correct immutable
// Image from a Server-hosted standard OCI /v2/ Registry through the unified
// SDK/cache fetch (fetch_manifest_image_v2) with no proprietary download URL,
// locally caches/consumes it; an unauthorized repository is denied while the
// cache is cold; and an active Session pin survives a Server tag move. The proof
// runs the real Server RegistryService on a loopback TCP ingress against a real
// Agent EROFS cache.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc02_agent_fetches_via_server_v2_and_pin_survives_tag_move';
const MEASURED = /^#4090 SC-02 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-erofs',
    ['--lib', '--features', 'cache,registry,mount', TEST],
    600000,
  );
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-02 Agent /v2/ fetch measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-02: a Session-authorized Agent fetches the immutable Image via Server /v2/ through the unified SDK/cache (no proprietary URL), caches/consumes it, denies an unauthorized repository, and its Session pin survives a tag move';
});