'use strict';
// #3358 SC-07: a compound outage longer than the P2P lease and the Server fast
// budget keeps the Session/route active while the issuer is unavailable, then
// resumes automatically from the Server authenticated-ready event without
// exhausting candidates, forcing Relay, reloading or re-authenticating.
const {
  run, renderedP2pLeaseSeconds, requireSource, runWebTests, targetSha,
} = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lease = renderedP2pLeaseSeconds();
  const tests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'waits for the credential issuer',
  ) + runWebTests(
    ['src/app/__tests__/integration/useAppConnection.test.ts'],
    'signals authenticated-ready',
  );
  requireSource([
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'awaitingCredentialIssuer', 'issuer-wait state'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'resumeAfterServerAuthenticated', 'authenticated-ready wake'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'scheduleCredentialIssuerRetry', 'bounded fallback'],
    ['web/src/platform/session-runtime/SessionRuntimeRegistry.ts', 'resumeServerAuthenticated', 'registry fan-out'],
    ['web/src/app/useAppConnection.ts', 'resumeServerAuthenticated', 'Server connected signal'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + tests +
        ' test(s) passed at the rendered ' + lease +
        's lease — an unavailable issuer keeps the same candidate and re-dials with the fresh credential on authenticated-ready',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': one Server authenticated-ready signal wakes each waiting SessionRuntime; the runtime never spends candidates or forces Relay while the issuer is unavailable',
    },
  );
  return 'A compound outage past the credential TTL resumes automatically without exhausting P2P candidates or forcing Relay';
});
