'use strict';
// #4091 SC-03 (SCN-03): when the peer Agent is unavailable/unauthorized/loses a
// Blob/disconnects, Agent B falls back only to another authorized Server OCI source
// for the SAME pinned digest. The fixture revokes Agent A's repository projection
// and proves Agent B falls back to the authoritative Server Registry, maintaining
// complete verified CAS state with no partial bytes consumed (the distribution
// engine publishes nothing Ready until exact bytes hash to the requested digest).
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'peer_registry::tests::sc03_peer_failure_falls_back_to_authorized_server_same_pinned_digest';
const MEASURED = /^#4091 SC-03 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-agent', ['--lib', TEST], 600000);
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-03 resilient-fallback measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-03: a revoked/unavailable peer falls back only to an authorized Server OCI source for the same pinned digest; complete verified CAS state is maintained (EROFS Ready, exact bytes) and no session consumes partial bytes';
});
