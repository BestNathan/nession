'use strict';
// #3358 SC-02: an initial dial failure and an OPEN-but-unanswered server.auth
// handshake are recoverable losses; an explicit invalid token stays terminal
// and returns the user to Login.
const { run, requireSource, runWebTests, targetSha } = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tests = runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'recoverable loss when the caller classifies',
  ) + runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'reconnectOnInitialFailure is set',
  ) + runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'explicit handshake refusal terminal',
  ) + runWebTests(
    ['src/app/__tests__/integration/useAppConnection.test.ts'],
    'keeps retrying after a network connect failure',
  );
  requireSource([
    ['web/src/app/useAppConnection.ts', 'reconnectOnInitialFailure: true', 'cold-start recovery'],
    ['web/src/app/useAppConnection.ts', 'isHandshakeRefusal', 'refusal/loss classification'],
    ['web/src/app/useAppConnection.ts', 'AuthenticationRejectedError', 'explicit auth refusal owner'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + tests +
        ' test(s) passed — initial network failure and handshake timeout recover; an explicit refusal does not retry',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': the Server transport retries a first-dial failure, classifies only AuthenticationRejectedError as terminal, and keeps server.auth timeouts on the loss path',
    },
  );
  return 'First-dial and handshake-timeout failures recover, while an explicitly invalid token terminates at Login';
});
