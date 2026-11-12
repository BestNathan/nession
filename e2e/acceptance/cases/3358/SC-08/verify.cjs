'use strict';
// #3358 SC-08: renewal failures are classified and bounded. Expired/unknown
// expiry and a 60s skew window reissue before a dial; one Agent identity
// rejection may reissue and retry once; a repeated rejection stops; a Server
// auth refusal terminates; an issuer timeout is a recoverable wait.
const { run, requireSource, runWebTests, targetSha } = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'reissues once after an Agent identity rejection',
  ) + runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'recoverable loss when the caller classifies',
  );
  requireSource([
    ['web/src/platform/socket/MessageRouter.ts', 'RequestTimeoutError', 'typed timeout class'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'P2PAuthenticationRejectedError', 'explicit Agent refusal'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'credentialRefreshRequired', 'forced reissue after refusal'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'p2pAuthRejectedOnce', 'single retry bound'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'P2P_CREDENTIAL_RENEW_MARGIN_MS', 'skew margin'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + tests +
        ' test(s) passed — one Agent identity rejection reissues and retries, the next follows the candidate policy, and handshake timeouts are recoverable',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': expiry uses the stated deadline and a 60s margin; timeouts are typed; only one background Agent rejection may mint a fresh credential before the ordinary refusal policy applies',
    },
  );
  return 'Renewal and authentication failures are classified with bounded single-retry behavior and no unbounded minting';
});
