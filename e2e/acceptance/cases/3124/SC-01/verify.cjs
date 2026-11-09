'use strict';
// #3124 SC-01: the authenticated context read follows the selected Session's
// *active Pane*. A host-capability probe alone is never `inside`; Enter moves
// the active Pane to the new verified Window; Return moves it back; and a
// deleted-then-recreated Session with the same name never inherits the old
// execution's report.
const assert = require('node:assert/strict');
const { pending } = require('../../../shared/sandbox-cases.cjs');
const { crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  preflight,
  enter,
  returnToNative,
  isolationPolicy,
  runSandboxCase,
  sleep,
} = require('../../../shared/sandbox-capability-cases.cjs');

const runtime = runtimeFromEnv();

(async () => {
  const client = await openClient(runtime);
  const name = 'acceptance-3124-sc01-' + process.pid;
  try {
    const sessionId = await createSession(client, name, runtime.home);
    // Retained after the inner block so the final evidence still names the
    // original Native Pane (block-scoped `const` is not visible below).
    let nativePane = null;
    try {
      const outside = await context(client, sessionId);
      if (!outside.success || !outside.context) {
        throw new Error('the Sandbox context read was refused: ' + JSON.stringify(outside));
      }
      // A measured host probe is not containment: before any Enter the active
      // Pane is outside even when the backend is available.
      assert.equal(outside.context.status, 'outside');
      assert.equal(outside.context.execution, undefined);
      if (!outside.context.catalog.backend) {
        pending(
          'This runner measured no Sandbox backend for the real Agent; the active-Pane transition cannot be proven',
          [{
            type: 'blocked',
            value: 'catalog status=' + outside.context.catalog.status +
              ' reason=' + (outside.context.catalog.reason || 'unknown'),
          }],
        );
        return;
      }
      nativePane = outside.context.scope.pane_id;
      assert.ok(nativePane, 'the outside context names its active Pane');
      if (!outside.context.enterable) {
        pending(
          'The real Agent measured the backend but cannot offer Enter from this Pane',
          [{
            type: 'blocked',
            value: 'reason=' + (outside.context.reason || 'unspecified'),
          }],
        );
        return;
      }

      const checked = await preflight(client, sessionId, outside.context.generation, isolationPolicy(), runtime.home);
      if (!checked.ok) {
        pending(
          'The real Agent could not preflight the isolation policy on this runner',
          [{ type: 'blocked', value: 'error=' + (checked.error || JSON.stringify(checked.errors)) }],
        );
        return;
      }

      const entered = await enter(
        client,
        sessionId,
        checked.generation,
        'sc01-enter-' + process.pid,
        isolationPolicy(),
        runtime.home,
      );
      if (!entered.success || !entered.context) {
        pending(
          'The real launch barrier refused the requested isolation on this runner',
          [{
            type: 'blocked',
            value: 'error_kind=' + (entered.error_kind || 'none') +
              ' error=' + (entered.error || 'none'),
          }],
        );
        return;
      }
      assert.equal(entered.context.status, 'inside');
      const sandboxPane = entered.context.scope.pane_id;
      assert.notEqual(sandboxPane, nativePane, 'Enter focuses a different Pane');

      // Re-read: the durable execution is still the active Pane's.
      const again = await context(client, sessionId);
      assert.equal(again.context.status, 'inside');
      assert.equal(again.context.execution.execution_id, entered.context.execution.execution_id);

      // Return to Native moves the active Pane back; the Sandbox Pane still
      // runs and is reachable.
      const returned = await returnToNative(client, sessionId);
      assert.equal(returned.success, true, 'Return to Native must succeed: ' + JSON.stringify(returned));
      assert.equal(returned.context.status, 'outside');
      assert.equal(returned.context.scope.pane_id, nativePane);
      assert.ok(
        returned.context.sandbox_panes.some((pane) => pane.pane_id === sandboxPane),
        'the preserved Sandbox Pane remains listed',
      );
    } finally {
      await killSession(client, sessionId);
    }

    // Deletion + same-name recreation: the context is outside again, never
    // carrying the previous execution's identity.
    const recreated = await createSession(client, name, runtime.home);
    try {
      await sleep(250);
      const fresh = await context(client, recreated);
      assert.equal(fresh.success, true);
      assert.equal(fresh.context.status, 'outside');
      assert.equal(fresh.context.execution, undefined);
      assert.equal(fresh.context.sandbox_panes.length, 0);
    } finally {
      await killSession(client, recreated);
    }

    // Source-owned restart reconciliation: a record whose Pane vanished is
    // cleaned even while the Session name lives; a record with no Pane id
    // falls back to Session liveness.
    const reconcile = crateTests(
      'nession-sandbox',
      ['--lib', 'exec::tests::'],
      600_000,
    );
    assertRan(reconcile, [
      'reconciliation_keeps_live_sessions_and_cleans_dead_ones',
      'a_record_whose_pane_is_gone_is_cleaned_even_when_the_session_lives',
    ]);

    await runSandboxCase(({ evidence }) => {
      evidence.push(
        { type: 'protocol', value: 'the initial active Pane ' + nativePane + ' was outside despite an available backend' },
        { type: 'protocol', value: 'Enter moved the active Pane to the verified sandbox Pane and the durable execution id was stable across reads' },
        { type: 'protocol', value: 'Return to Native restored the original Pane and kept the Sandbox Pane listed' },
        { type: 'protocol', value: 'a deleted/recreated same-name Session resolved outside with no execution and no listed Sandbox Panes' },
        { type: 'runtime', value: 'Agent restart reconciliation is Pane-keyed: a vanished Pane is cleaned while its Session name lives (exact named sandbox tests)' },
      );
      return 'The authenticated context follows the active Pane, not host support or a Session name';
    });
  } finally {
    client.close();
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the active-Pane context obligation was not established' }],
  }) + '\n');
  process.exitCode = 1;
});
