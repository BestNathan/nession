// Issue #4525 SC-02 — fair, bounded and isolated active-lifecycle scan.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { startDevelopment } from '../orchestration/outbox.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState } from '../orchestration/state-store.mjs';
import { scanLifecycleCandidates } from './scan.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const root = mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-scan-'));
function fresh(issue) {
  return createLifecycleState({
    registry, issue, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority: {
      repository: 'BestNathan/nession', event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now: 1000,
  });
}
function write(issue, state) {
  writeIssueWorkflowState(root, state, 0);
}
function directory(issue) {
  const dir = path.join(root, 'workflows', 'issues', String(issue));
  mkdirSync(dir, { recursive: true });
  return dir;
}
try {
  // Malformed candidates sort first.
  writeFileSync(path.join(directory(1), 'head.json'), '{broken');
  writeFileSync(path.join(directory(2), 'head.json'), JSON.stringify({
    version: 1, path: 'workflows/issues/2/states/00000001.json', sha256: 'a'.repeat(64),
  }));
  const corrupt = directory(3);
  writeFileSync(path.join(corrupt, 'head.json'), JSON.stringify({
    version: 1, path: 'workflows/issues/3/states/00000001.json', sha256: 'b'.repeat(64),
  }));
  writeFileSync(path.join(corrupt, 'states.json'), '{}');

  // Terminal and blocked V2 states.
  const done = { ...fresh(10), phase: 'done', substate: 'complete', outbox: [] };
  validateLifecycleState(done);
  write(10, done);
  const cancelled = {
    ...fresh(11), phase: 'cancelled', substate: 'cancelled', outbox: [],
    cancellation: { reason: 'owner stop', fenced_actions: [] },
  };
  validateLifecycleState(cancelled);
  write(11, cancelled);
  const blocked = {
    ...fresh(12), phase: 'blocked', substate: 'blocked', outbox: [],
    blocker: { reason: 'owner_action', evidence_ref: null, owner_action_required: true },
  };
  validateLifecycleState(blocked);
  write(12, blocked);

  // 25 active V2 candidates.
  const active = [];
  for (let issue = 20; issue < 45; issue++) {
    write(issue, fresh(issue));
    active.push(issue);
  }
  // Two legacy V1 candidates.
  const authority = {
    repository: 'BestNathan/nession', event: 'workflow_dispatch',
    permission: 'write', ref: 'refs/heads/main', run_id: 9001,
  };
  for (const issue of [50, 51]) {
    const v1 = startDevelopment(registry, {
      issue, sha: BASE, developer: 'dev-cursor-01',
      reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
    }, authority);
    writeIssueWorkflowState(root, v1, 0);
  }

  const loadState = (issue) => {
    const record = readIssueWorkflowState(root, issue);
    return { state: record.state, version: record.version };
  };

  const seen = new Set();
  let cursor = 0;
  const ticks = [];
  for (let tick = 0; tick < 7; tick++) {
    const result = scanLifecycleCandidates({
      storeRoot: root, loadState, cursor, maxIssues: 5,
    });
    ticks.push(result);
    for (const entry of result.issues) {
      assert.ok(!seen.has(entry.issue), 'duplicate issue within one cycle');
      seen.add(entry.issue);
    }
    assert.ok(result.issues.length <= 5);
    assert.ok(result.malformed.length <= 32);
    cursor = result.next_cursor;
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [...active, 12, 50, 51].sort((a, b) => a - b));
  assert.equal(seen.has(10), false, 'done is not an active candidate');
  assert.equal(seen.has(11), false, 'cancelled is not an active candidate');
  assert.ok(ticks.some((tick) => tick.malformed.length > 0),
    'malformed candidates are isolated and reported');
  assert.ok(ticks.every((tick) => tick.issues.length <= 5),
    'one malformed candidate does not starve the rest');

  // The first tick starts at the malformed heads and does not abort.
  const first = scanLifecycleCandidates({
    storeRoot: root, loadState, cursor: 0, maxIssues: 5,
  });
  assert.equal(first.inspected, 5);
  assert.ok(first.malformed.some((entry) => entry.issue === 1));
  assert.ok(first.malformed.some((entry) => entry.issue === 3));

  // Legacy candidates are marked; V2 states are not.
  const legacy = ticks.flatMap((tick) => tick.issues).find((entry) => entry.issue === 50);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.schema_version, 1);
  const v2 = ticks.flatMap((tick) => tick.issues).find((entry) => entry.issue === 20);
  assert.equal(v2.legacy, false);
  const blockedEntry = ticks.flatMap((tick) => tick.issues)
    .find((entry) => entry.issue === 12);
  assert.equal(blockedEntry.blocked, true);

  // The scan never creates a lifecycle.
  assert.equal(existsSync(path.join(root, 'workflows', 'issues', '999')), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('agent workflow scan selftest: OK');
