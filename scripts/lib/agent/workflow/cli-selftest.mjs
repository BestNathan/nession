// Issue #4482 SC-01/SC-07 fixture: the trusted-main Reconcile entrypoint
// performs a bounded, read-only plan and refuses unauthorized effect execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifecycleState } from './contract.mjs';
import { writeIssueWorkflowState } from '../orchestration/state-store.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const root = mkdtempSync(path.join(os.tmpdir(), 'agent-reconcile-cli-'));
try {
  const state = createLifecycleState({
    registry, issue: 4482, base_sha: 'a'.repeat(40),
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: 'a'.repeat(40),
    authority: {
      repository: 'BestNathan/nession', event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now: Date.now(),
  });
  writeIssueWorkflowState(root, state, 0);
  const env = { ...process.env, GITHUB_TOKEN: 'read-only-test-token' };
  const plan = JSON.parse(execFileSync('node', [
    'scripts/reconcile-agent-workflows.mjs', '--plan',
    '--issue', '4482', '--store-root', root, '--wake-source', 'manual',
  ], { encoding: 'utf8', env }));
  assert.equal(plan.kind, 'agent_workflow_v2_reconcile_plan');
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.processes, 1);
  assert.equal(plan.results[0].issue, 4482);
  assert.equal(plan.results[0].decision, 'plan');
  assert.deepEqual(plan.results[0].pending_intents, ['dispatch']);
  assert.equal(plan.results[0].phase, 'authorized');
  assert.equal(plan.telemetry.length, 1);
  assert.equal(plan.telemetry[0].phase, 'authorized');
  assert.equal(plan.telemetry[0].pending_actions, 1);
  assert.equal(plan.telemetry[0].store_version, 1);

  // The Store was not written in plan mode.
  const after = JSON.parse(readFileSync(
    path.join(root, 'workflows/issues/4482/head.json'), 'utf8'));
  assert.equal(after.version, 1);

  // Effect execution is the separately authorized SC-06 canary.
  assert.throws(() => execFileSync('node', [
    'scripts/reconcile-agent-workflows.mjs', '--apply',
  ], { encoding: 'utf8', env, stdio: 'pipe' }), (error) => {
    return String(error.stderr).includes('separately authorized SC-06 canary');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('agent workflow cli selftest: OK');
