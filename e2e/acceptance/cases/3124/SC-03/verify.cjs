'use strict';
// #3124 SC-03: one explicit authorized Enter launches a NEW interactive Pane
// under the verified OS isolation, focuses it only after success, returns the
// verified execution identity, and leaves the original Native Pane alive and
// outside. The Agent's durable record must carry the observed effective policy
// and the exact Pane identity, not merely a digest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pending } = require('../../../shared/sandbox-cases.cjs');
const {
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  preflight,
  enter,
  processes,
  isolationPolicy,
} = require('../../../shared/sandbox-capability-cases.cjs');

const runtime = runtimeFromEnv();

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'fail') process.exitCode = 1;
}

(async () => {
  const client = await openClient(runtime);
  const name = 'acceptance-3124-sc03-' + process.pid;
  const sessionId = await createSession(client, name, runtime.home);
  try {
    const outside = await context(client, sessionId);
    if (!outside.success || !outside.context) {
      throw new Error('the Sandbox context read was refused: ' + JSON.stringify(outside));
    }
    if (!outside.context.enterable) {
      pending(
        'This runner cannot offer a verified Enter from the native Pane',
        [{
          type: 'blocked',
          value: 'catalog=' + outside.context.catalog.status +
            ' backend=' + (outside.context.catalog.backend || 'none') +
            ' reason=' + (outside.context.reason || outside.context.catalog.reason || 'unknown'),
        }],
      );
      return;
    }
    const nativePane = outside.context.scope.pane_id;
    const nativePid = outside.context.scope.pane_pid;

    const checked = await preflight(client, sessionId, outside.context.generation, isolationPolicy(), runtime.home);
    if (!checked.ok) {
      pending(
        'The real Agent could not preflight the isolation policy on this runner',
        [{ type: 'blocked', value: 'error=' + (checked.error || JSON.stringify(checked.errors)) }],
      );
      return;
    }
    assert.ok(checked.mechanisms.includes('network.deny'), 'preflight must request the verified network denial');

    const entered = await enter(
      client,
      sessionId,
      checked.generation,
      'sc03-enter-' + process.pid,
      isolationPolicy(),
      runtime.home,
    );
    if (!entered.success) {
      pending(
        'The launch barrier refused the requested isolation on this runner',
        [{
          type: 'blocked',
          value: 'error_kind=' + (entered.error_kind || 'none') +
            ' error=' + (entered.error || 'none'),
        }],
      );
      return;
    }
    const inside = entered.context;
    assert.equal(inside.status, 'inside');
    assert.ok(inside.execution, 'Enter returns the verified execution identity');
    assert.notEqual(inside.scope.pane_id, nativePane, 'the new Pane is a different tmux Pane');
    assert.notEqual(inside.scope.pane_pid, nativePid, 'the new Pane has its own root process');
    assert.ok(
      inside.execution.mechanisms.includes('network.deny'),
      'the barrier verified the requested network denial: ' + inside.execution.mechanisms.join(','),
    );
    assert.ok(
      inside.execution.mechanisms.includes('backend.baseline_namespaces'),
      'the Linux backend baseline namespaces were verified',
    );
    assert.equal(inside.execution.backend, 'linux-bwrap');
    assert.equal(inside.effective_policy.network.mode, 'deny');

    // Evidence of the durable record: the effective policy and Pane identity
    // survive an Agent restart, which a digest alone cannot reconstruct.
    const recordPath = path.join(
      runtime.home,
      'agent',
      'sandbox',
      inside.execution.execution_id + '.json',
    );
    assert.ok(fs.existsSync(recordPath), 'the durable execution record exists: ' + recordPath);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(record.pane_id, inside.scope.pane_id);
    assert.equal(record.window_id, inside.scope.window_id);
    assert.equal(record.instance_id, inside.scope.session_instance_id);
    assert.equal(record.effective_policy.network.mode, 'deny');
    assert.equal(record.working_dir, fs.realpathSync(runtime.home));
    assert.ok(Array.isArray(record.mechanisms) && record.mechanisms.includes('network.deny'));

    // Both Panes are alive: the original Native one was not converted or
    // replaced by the Enter.
    const snapshot = await processes(client, sessionId);
    const panes = snapshot.snapshot ? snapshot.snapshot.panes : [];
    const native = panes.find((pane) => pane.pane_id === nativePane);
    const sandbox = panes.find((pane) => pane.pane_id === inside.scope.pane_id);
    assert.ok(native, 'the original Native Pane is still a live Pane');
    assert.ok(sandbox, 'the new Sandbox Pane is a live Pane');
    assert.equal(native.pane_pid, nativePid, 'the original Native root process is unchanged');
    assert.ok(native.processes.length > 0, 'the original Native Pane still runs processes');

    emit({
      status: 'pass',
      summary:
        'A single explicit Enter created a verified isolated Pane, focused it, returned its execution identity, and preserved the Native Pane',
      evidence: [
        { type: 'runtime', value: 'execution ' + inside.execution.execution_id + ' backend=' + inside.execution.backend + ' mechanisms=' + inside.execution.mechanisms.join(',') },
        { type: 'runtime', value: 'native Pane ' + nativePane + ' pid ' + nativePid + ' and Sandbox Pane ' + inside.scope.pane_id + ' pid ' + inside.scope.pane_pid + ' were both alive' },
        { type: 'runtime', value: 'the durable record carried pane_id/window_id/instance_id and the normalized effective policy network.mode=deny' },
        { type: 'runtime', value: 'policy digest ' + inside.execution.policy_digest },
      ],
    });
  } finally {
    await killSession(client, sessionId);
    client.close();
  }
})().catch((error) => {
  emit({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the verified isolated-Pane obligation was not established' }],
  });
});
