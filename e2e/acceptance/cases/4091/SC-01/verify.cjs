'use strict';
// #4091 SC-01 (SCN-03): an isolated trusted Server + two-Agent fixture. Agent A
// mounts the opted-in read-only OCI Registry (#4090) over its verified cache;
// Agent B resolves/authorizes the pinned Manifest digest first, then fetches the
// complete immutable EROFS closure from Agent A through the shared discovery
// control plane and the normal verified local-cache/Sandbox preparation path. The
// Server is the policy/discovery authority and serves zero Blob bytes; Agent B
// then mounts its own read-only Registry and serves the same pinned digest onward.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'peer_registry::tests::sc01_two_authorized_agents_peer_fetch_server_serves_no_blob_bytes';
const MEASURED = /^#4091 SC-01 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-agent', ['--lib', TEST], 600000);
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-01 two-Agent peer-fetch measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-01: with two reachable authorized Agents, Agent B fetches a complete immutable EROFS Image from Agent A read-only Registry into its normal local-cache mount identity (Server policy/discovery only, zero Blob bytes) and propagates the same pinned digest onward';
});
