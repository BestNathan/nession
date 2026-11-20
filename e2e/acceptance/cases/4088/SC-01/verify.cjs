'use strict';
// #4088 SC-01 (SCN-03): the mountable /v2/ Registry service, served on a real
// loopback TCP ingress, answers a standard OCI pull (manifest by tag, HEAD,
// blob Range, Accept negotiation) and the product's own #3498 RegistryClient /
// pull_image import resolves the same immutable identity and preserves every
// original digest and exact byte sequence into a second catalog.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc01_loopback_pull_and_oci_client_readback';
const MEASURED = /^#4088 SC-01 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-erofs',
    ['--lib', '--features', 'cache,registry', TEST],
    600000,
  );
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-01 loopback readback measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-01: a standard OCI client and the product RegistryClient/pull_image import read the loopback Registry back to the original manifest/config/layer digests and exact bytes';
});