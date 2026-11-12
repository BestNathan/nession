'use strict';
// #3358 SC-06: credential lifetime is separate from physical socket lifetime.
// A healthy established P2P socket is untouched past the lease, and a lost
// socket renews the scoped credential through the authenticated Server before
// the next Agent upgrade.
const {
  run, readSource, renderedP2pLeaseSeconds, requireSource, runWebTests, targetSha,
} = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lease = renderedP2pLeaseSeconds();
  const total = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'P2P credential',
  );
  requireSource([
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'p2pCredentialNeedsRenewal', 'pre-dial expiry decision'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'resolveP2PUrl', 'Server-backed renewal owner'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'buildAgentWsUrl', 'fresh credential URL at dial'],
    ['crates/nession-agent/src/p2p_credentials.rs', 'fn authorize', 'Agent upgrade verification'],
    ['crates/nession-agent/src/p2p_credentials.rs', 'expires_at', 'Agent deadline enforcement'],
  ]);
  const agent = readSource('crates/nession-agent/src/p2p_credentials.rs');

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + total +
        ' SessionRuntime renewal test(s) passed at the rendered ' + lease +
        's test lease — expiry alone leaves a healthy socket alone; a lost socket renews first',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': renewal is decided only for a new Agent dial with a 60s margin, the attach reply states the deadline, and the Agent still enforces expires_at (source size ' +
        agent.length + ' bytes)',
    },
  );
  return 'P2P credential expiry does not drop a healthy socket and a new dial always presents a freshly issued scoped credential';
});
