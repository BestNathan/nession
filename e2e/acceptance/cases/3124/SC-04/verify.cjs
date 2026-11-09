'use strict';
// #3124 SC-04: a repeated Enter, a stale generation, a blocked launch, a
// detached client and an exiting sandbox shell cannot leave a falsely active
// Sandbox or orphan owned resources. Return to Native is a focus switch, not a
// teardown; the escaping shell's Pane is cleaned up by Pane identity.
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
  returnToNative,
  focus,
  processes,
  isolationPolicy,
  runSandboxCase,
  sleep,
} = require('../../../shared/sandbox-capability-cases.cjs');

const runtime = runtimeFromEnv();

function recordsDir() {
  return path.join(runtime.home, 'agent', 'sandbox');
}

function recordPath(executionId) {
  return path.join(recordsDir(), executionId + '.json');
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  let client = await openClient(runtime);
  const name = 'acceptance-3124-sc04-' + process.pid;
  const sessionId = await createSession(client, name, runtime.home);
  try {
    const outside = await context(client, sessionId);
    if (!outside.success || !outside.context || !outside.context.enterable) {
      pending(
        'This runner cannot offer a verified Enter, so the failure/duplication obligations cannot be exercised',
        [{
          type: 'blocked',
          value: 'catalog=' + (outside.context ? outside.context.catalog.status : 'none') +
            ' reason=' + (outside.context ? outside.context.reason || outside.context.catalog.reason : outside.error),
        }],
      );
      return;
    }
    const preGeneration = outside.context.generation;
    const checked = await preflight(client, sessionId, preGeneration, isolationPolicy(), runtime.home);
    if (!checked.ok) {
      pending(
        'The real Agent could not preflight the isolation policy on this runner',
        [{ type: 'blocked', value: 'error=' + (checked.error || JSON.stringify(checked.errors)) }],
      );
      return;
    }
    const enterId = 'sc04-enter-' + process.pid;
    const first = await enter(client, sessionId, checked.generation, enterId, isolationPolicy(), runtime.home);
    if (!first.success) {
      pending(
        'The launch barrier refused the requested isolation on this runner',
        [{
          type: 'blocked',
          value: 'error_kind=' + (first.error_kind || 'none') + ' error=' + (first.error || 'none'),
        }],
      );
      return;
    }
    const executionId = first.context.execution.execution_id;
    const sandboxPane = first.context.scope.pane_id;

    // A repeated delivery of the same client attempt replays the same
    // execution instead of launching a second Pane.
    const replay = await enter(client, sessionId, checked.generation, enterId, isolationPolicy(), runtime.home);
    assert.equal(replay.success, true, 'the duplicate delivery replays the completed attempt');
    assert.equal(
      replay.context.execution.execution_id,
      executionId,
      'the duplicate did not create a second execution',
    );
    const afterReplay = await processes(client, sessionId);
    const sandboxPanes = (afterReplay.snapshot ? afterReplay.snapshot.panes : [])
      .filter((pane) => pane.pane_id === sandboxPane);
    assert.equal(sandboxPanes.length, 1, 'exactly one Sandbox Pane exists');

    // A stale generation from before Enter is refused as a conflict.
    const stale = await enter(
      client,
      sessionId,
      preGeneration,
      'sc04-stale-' + process.pid,
      isolationPolicy(),
      runtime.home,
    );
    assert.equal(stale.success, false);
    assert.equal(stale.error_kind, 'conflict');
    const stillInside = await context(client, sessionId);
    assert.equal(stillInside.context.status, 'inside');
    assert.equal(stillInside.context.execution.execution_id, executionId);

    // A blocked launch leaves the Native Pane active and creates nothing: the
    // policy's own working directory is not visible, so preparation refuses.
    const blockedSession = await createSession(client, name + '-blocked', runtime.home);
    try {
      const blockedOutside = await context(client, blockedSession);
      const blockedPolicy = {
        ...isolationPolicy(),
        filesystem: { access: { read: ['/nonexistent-3124-acceptance'], write: [] } },
      };
      const blocked = await enter(
        client,
        blockedSession,
        blockedOutside.context.generation,
        'sc04-blocked-' + process.pid,
        blockedPolicy,
        runtime.home,
      );
      assert.equal(blocked.success, false, 'a refusal must not claim Enter succeeded');
      assert.ok(
        blocked.error_kind === 'invalid' || blocked.error_kind === 'failed',
        'the refusal is typed: ' + JSON.stringify(blocked),
      );
      const blockedAfter = await context(client, blockedSession);
      assert.equal(blockedAfter.context.status, 'outside');
      assert.equal(blockedAfter.context.execution, undefined);
      assert.equal(blockedAfter.context.sandbox_panes.length, 0);
      assert.equal(fs.existsSync(recordsDir()) ? fs.readdirSync(recordsDir()).length : 0, 1,
        'the failed launch left no record of its own');
    } finally {
      await killSession(client, blockedSession);
    }

    // A detached client cannot lose the execution: the Agent owns it.
    client.close();
    client = await openClient(runtime);
    const reconnected = await context(client, sessionId);
    assert.equal(reconnected.context.status, 'inside');
    assert.equal(reconnected.context.execution.execution_id, executionId);

    // Return to Native is a focus switch: the Sandbox Pane survives.
    const returned = await returnToNative(client, sessionId);
    assert.equal(returned.success, true);
    assert.equal(returned.context.status, 'outside');
    assert.ok(returned.context.sandbox_panes.some((pane) => pane.pane_id === sandboxPane));
    const afterReturn = await processes(client, sessionId);
    assert.ok(
      (afterReturn.snapshot ? afterReturn.snapshot.panes : []).some((pane) => pane.pane_id === sandboxPane),
      'the Sandbox Pane is still alive after Return to Native',
    );

    // Returning is reversible.
    const focused = await focus(client, sessionId, sandboxPane);
    assert.equal(focused.success, true);
    assert.equal(focused.context.status, 'inside');

    // The sandboxed shell exits: its Window disappears, retaining the record
    // only until the Pane-keyed reaper releases it.
    const exitPid = focused.context.scope.pane_pid;
    assert.ok(fs.existsSync(recordPath(executionId)), 'the record exists before the shell exits');
    process.kill(exitPid, 'SIGKILL');
    await waitFor(() => !fs.existsSync(recordPath(executionId)), 20_000, 'the removed Pane record cleanup');
    const afterExit = await context(client, sessionId);
    assert.equal(afterExit.context.status, 'outside');
    assert.equal(afterExit.context.execution, undefined);
    assert.equal(afterExit.context.sandbox_panes.length, 0);

    await runSandboxCase(({ evidence }) => {
      evidence.push(
        { type: 'protocol', value: 'a duplicate delivery of enter_id ' + enterId + ' replayed execution ' + executionId + ' and created no second Pane' },
        { type: 'protocol', value: 'a pre-Enter generation with a new attempt id was refused as conflict while the context stayed inside' },
        { type: 'protocol', value: 'a blocked launch left the Native Pane active, created no Pane and wrote no record' },
        { type: 'protocol', value: 'a detached/reconnected client still observed the same durable execution' },
        { type: 'protocol', value: 'Return to Native kept the Sandbox Pane alive; focus returned inside without a new Enter' },
        { type: 'runtime', value: 'the sandboxed shell exit removed the Pane and its durable record within the reaper window' },
      );
      return 'Repeated, stale, blocked and exiting Sandbox transitions fail closed without false state or orphaned resources';
    });
  } finally {
    await killSession(client, sessionId);
    client.close();
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the fail-closed transition obligation was not established' }],
  }) + '\n');
  process.exitCode = 1;
});
