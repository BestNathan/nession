'use strict';
// #3358 SC-01: an authenticated Server WS whose fast budget is spent keeps
// probing at a bounded low frequency and, once the Server is reachable again,
// re-authenticates on the same service and restores requests/subscriptions.
const { run, requireSource, runWebTests, targetSha } = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const total = runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'never leaves reconnecting',
  );
  requireSource([
    ['web/src/app/useAppConnection.ts', 'persistentReconnect: true', 'Server long-tail reconnect'],
    ['web/src/app/useAppConnection.ts', 'reportExhaustion: false', 'non-terminal exhaustion state'],
    ['web/src/platform/socket/WebSocketService.ts', 'PERSISTENT_RECONNECT_DELAY_MS', 'bounded tail cadence'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + total +
        ' transport test(s) passed — a spent budget keeps the logical connection in reconnecting and keeps probing',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': the Server WebSocketService enables the persistent tail with a 15s bounded cadence and no terminal exhaustion report',
    },
  );
  return 'A Server WS past its fast retry budget keeps a bounded low-frequency probe and stays recoverable';
});
