'use strict';
// #3358 SC-03: an always-visible client whose socket is OPEN but whose peer is
// silent is noticed by a bounded, low-frequency, single-flight server.info
// round trip; a healthy socket is untouched and a late result is fenced by
// physical generation.
const { run, requireSource, runWebTests, targetSha } = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tests = runWebTests(
    ['src/app/__tests__/integration/useVisibilityReconnect.test.ts'],
    'always-visible half-open',
  ) + runWebTests(
    ['src/app/__tests__/integration/useVisibilityReconnect.test.ts'],
    'does not probe while the page is hidden',
  ) + runWebTests(
    ['src/platform/socket/__tests__/unit/WebSocketService.test.ts'],
    'reportUnresponsive',
  );
  requireSource([
    ['web/src/app/useVisibilityReconnect.ts', 'SERVER_LIVENESS_INTERVAL_MS', 'low-frequency visible probe'],
    ['web/src/app/useVisibilityReconnect.ts', 'physicalGeneration', 'generation fence'],
    ['web/src/app/useVisibilityReconnect.ts', 'reportUnresponsive(generation)', 'loss report owner'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + tests +
        ' test(s) passed — a visible half-open peer is probed, the hidden page is not, and stale generations are ignored',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': the app probes the connected Server every 30s only while visible, single-flight, and reports an unanswered probe through the existing loss path',
    },
  );
  return 'A half-open Server socket on a continuously visible page is detected by a bounded generation-fenced probe';
});
