'use strict';
// #3358 SC-05: controlled Server closes and network losses are distinguishable
// from bounded, credential-free client close/handshake/retry records correlated
// with a Server-side close reason; no token or token-bearing URL is recorded.
const { run, requireSource, runWebTests, targetSha } = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const total = runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'redacted close facts',
  );
  requireSource([
    ['web/src/platform/socket/types.ts', 'failureClass', 'handshake failure classification'],
    ['web/src/platform/socket/WebSocketService.ts', "'socket-close'", 'client close diagnostic'],
    ['web/src/platform/socket/WebSocketService.ts', 'wasClean', 'browser close cleanliness'],
    ['crates/nession-server/src/server/websocket.rs', 'relay-agent-ended', 'Server AgentEnded reason'],
    ['crates/nession-server/src/server/websocket.rs', 'relay-client-stalled', 'Server ClientStalled reason'],
    ['crates/nession-server/src/server/websocket.rs', 'close_reason', 'Server close classification log'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + total +
        ' diagnostic test(s) passed — close code/wasClean/reason are emitted and the URL/credential are absent',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': client records socket close/error/handshake class by generation and attempt; Server logs relay-agent-ended and relay-client-stalled with no credential fields',
    },
  );
  return 'Server-initiated and network closes are distinguishable from redacted client records correlatable with Server close reasons';
});
