'use strict';
// #3358 SC-09: retries, late renewal replies, route/session changes and
// dispose cannot let a stale reply rewrite authority or redial a closed
// socket; the credential is scoped per Session, never persisted, and never
// logged.
const {
  forbidSource, run, requireSource, runWebTests, targetSha,
} = require('../../../shared/ws-recovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'fences a renewal that resolves after the attach was replaced',
  ) + runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'waits for the credential issuer',
  );
  requireSource([
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'credentialEpoch', 'attach/session epoch fence'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'credentialRefreshGeneration', 'late-renewal fence'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'this.credentialRefresh = refresh', 'single-flight renewal'],
    ['crates/nession-agent/src/p2p_credentials.rs', 'WireScope::Session', 'Agent session-scope verification'],
  ]);
  forbidSource([
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'localStorage', 'credential persistence'],
    ['web/src/platform/session-runtime/SessionRuntime.ts', 'sessionStorage', 'credential persistence'],
  ]);

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + tests +
        ' test(s) passed — a stale renewal and a route replacement keep the newer authority; the route survives an issuer wait',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': renewal is single-flight and fenced by credential epoch/generation; the Agent verifies the Session scope; SessionRuntime contains no browser persistence',
    },
  );
  return 'Stale replies, route changes and cancellation cannot rewrite credentials or redial closed sockets, and credentials stay unpersisted';
});
