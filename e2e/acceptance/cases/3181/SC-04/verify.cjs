'use strict';
// #3181 SC-04: the Agent observes verified/preparing/absent/failed without
// mutating the cache; the Server relays per-digest status on the authenticated
// Session context.
const { run, crateTests, assertRan, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests(
    'nession-agent',
    ['erofs_cache::tests::status_distinguishes_absent_verified_and_preparing_without_mutating', '--lib'],
    600000,
  );
  assertRan(agent, [
    'erofs_cache::tests::status_distinguishes_absent_verified_and_preparing_without_mutating',
  ]);
  const server = crateTests(
    'nession-server',
    ['server::handler::tests::server_session_sandbox_v1::context_relays_per_digest_cache_statuses', '--lib'],
    600000,
  );
  assertRan(server, [
    'server::handler::tests::server_session_sandbox_v1::context_relays_per_digest_cache_statuses',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent cache reported absent, verified and preparing without ' +
      'downloading or mutating bytes; the Server relayed the per-digest statuses on the ' +
      'authenticated Session context',
  });
  return 'Server Blob readiness and Agent verified-cache readiness remain distinct; an absent/failed cache is never reported as mount-ready';
});
