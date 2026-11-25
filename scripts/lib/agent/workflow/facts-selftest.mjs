// Issue #4525 SC-01 — authenticated fact-observer identity binding.
//
// Controlled ports prove every role fact is bound to the exact action, Run,
// Attempt, source and HEAD. Unknown, stale, denied and un-ingested facts never
// become a lifecycle observation.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createLifecycleState, activeAction } from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import { createFactObserver, createProductionObserverPorts } from './facts.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const REPO = 'BestNathan/nession';
const BASE = 'a'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
const REVIEW_DIGEST = '1'.repeat(64);
const ACCEPT_DIGEST = '2'.repeat(64);
let clock = 1000;

function fresh() {
  return createLifecycleState({
    registry, issue: 4525, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority: {
      repository: REPO, event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now: 1000,
  });
}
function observation(state, patch = {}) {
  return {
    issue: state.issue, state_version: state.version, observed_at: clock++,
    wake: { source: 'github_event', reason: 'fixture', correlation_id: 'c1' },
    pr: null, developer: null, publisher: null, ci: null,
    reviewer: null, acceptance: null, merge: null, ...patch,
  };
}
function step(state, patch = {}) {
  return decideLifecycle(state, observation(state, patch));
}
function apply(decision) {
  assert.ok(decision.nextState, decision.reason);
  return decision.nextState;
}
function dispatch(state, action, runId) {
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: {
      status: 'prepared', dispatch_id: action.id, issuer_run_id: runId,
      ticket_sha256: 'a'.repeat(64),
    },
    attempts: action.attempts + 1,
  }, clock++);
  return updateExecutionState(dispatching, action.id, {
    status: 'dispatched', run: { id: runId, attempt: 1, verified: true },
  }, clock++);
}
function checkpoint(version) {
  return {
    version, commit_sha: '3'.repeat(40),
    ciphertext_sha256: '4'.repeat(64), native_session_id: 'native-' + version,
  };
}
function developerEvent(action, runId, patch) {
  return {
    action_id: action.id, run_id: runId, attempt: 1, status: 'completed',
    outcome: null, target_sha: null, failure: null, checkpoint: null,
    verified: true, ...patch,
  };
}
function runRecord(runId, patch = {}) {
  return {
    id: runId, run_attempt: 1, status: 'completed', conclusion: 'success',
    path: '.github/workflows/agent-develop.yml', name: 'Agent / Development',
    event: 'workflow_dispatch', head_branch: 'main', head_sha: BASE,
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:01:00Z',
    ...patch,
  };
}
function resultReceipt(action, runId, patch = {}) {
  return {
    schema_version: 1,
    kind: 'authenticated_agent_task_result',
    issue: 4525,
    action_id: action.id,
    result: {
      kind: 'developer', issue: 4525, run_id: runId, run_attempt: 1,
      target_sha: CANDIDATE, outcome: 'implementation_ready',
      task_id: action.id,
    },
    source: {
      repository: REPO, path: '.github/workflows/agent-develop.yml',
      name: 'Agent / Development', run_id: runId, attempt: 1,
      event: 'workflow_dispatch', ref: 'refs/heads/main',
      issue: 4525, task_id: action.id, agent_id: 'dev-cursor-01',
      input_sha: BASE, output_sha: CANDIDATE, verified: true,
    },
    artifact: {
      id: 1, digest: 'sha256:' + '5'.repeat(64), json_sha256: '6'.repeat(64),
      source_run_id: runId, source_run_attempt: 1,
    },
    acceptance_result: null,
    ...patch,
  };
}
function reviewerReceipt(action, runId, outcome) {
  return {
    ...resultReceipt(action, runId, {
      result: {
        kind: 'reviewer', issue: 4525, run_id: runId, run_attempt: 1,
        target_sha: CANDIDATE, outcome, task_id: action.id,
      },
      source: {
        repository: REPO, path: '.github/workflows/agent-review.yml',
        name: 'Agent / Review', run_id: runId, attempt: 1,
        event: 'workflow_dispatch', ref: 'refs/heads/main',
        issue: 4525, task_id: action.id, agent_id: 'review-cursor-01',
        input_sha: CANDIDATE, output_sha: CANDIDATE, verified: true,
      },
    }),
    artifact: {
      id: 2, digest: 'sha256:' + '7'.repeat(64), json_sha256: '8'.repeat(64),
      source_run_id: runId, source_run_attempt: 1,
    },
  };
}
function finding(id) {
  return {
    id, severity: 'blocking', category: 'correctness',
    message: 'finding ' + id, file: 'x.mjs', sc: 'SC-01',
  };
}

// ── drive a lifecycle to the role action under test ─────────────────────
function toDeveloper() {
  let state = fresh();
  const action = activeAction(state);
  return { state: dispatch(state, action, 101), action };
}
function toPublisher() {
  let state = fresh();
  let action = activeAction(state);
  state = dispatch(state, action, 101);
  state = apply(step(state, {
    developer: developerEvent(action, 101, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1),
    }),
  }));
  action = activeAction(state);
  return { state: dispatch(state, action, 102), action };
}
function toReviewer() {
  let state = fresh();
  let action = activeAction(state);
  state = dispatch(state, action, 101);
  state = apply(step(state, {
    developer: developerEvent(action, 101, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1),
    }),
  }));
  action = activeAction(state);
  state = dispatch(state, action, 102);
  state = apply(step(state, {
    publisher: {
      action_id: action.id, run_id: 102, attempt: 1, status: 'completed',
      outcome: 'published',
      pr: {
        number: 4525, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  }));
  state = apply(step(state, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: 'pass',
      digest: CI_DIGEST,
      checks: [{
        name: 'quality', workflow: 'ci-quality', conclusion: 'success',
        applicability: 'applicable', evidence_ref: null,
      }],
      observed_at: clock++, verified: true,
    },
  }));
  action = activeAction(state);
  return { state: dispatch(state, action, 103), action };
}
function toAcceptor() {
  let { state, action } = toReviewer();
  state = apply(step(state, {
    reviewer: {
      action_id: action.id, run_id: 103, attempt: 1, status: 'completed',
      outcome: 'approved', head_sha: CANDIDATE,
      evidence_generation: action.evidence_generation,
      digest: REVIEW_DIGEST, findings: [], verified: true,
    },
  }));
  state = apply(step(state));
  action = activeAction(state);
  return { state: dispatch(state, action, 104), action };
}
function toWaitingMerge() {
  let { state, action } = toAcceptor();
  state = apply(step(state, {
    acceptance: {
      action_id: action.id, run_id: 104, attempt: 1, stage: 'pr',
      head_sha: CANDIDATE, outcome: 'passed', digest: ACCEPT_DIGEST,
      failed_criteria: [], verified: true,
    },
  }));
  return state;
}

function observer(ports) {
  return createFactObserver({ ports, now: () => clock++ });
}
function basePorts(overrides = {}) {
  return {
    readPull: async () => ({
      number: 4525, state: 'open', head_sha: CANDIDATE,
      base_sha: PR_BASE, merged_sha: null,
    }),
    readRun: async ({ runId }) => runRecord(runId),
    readRunJobs: async () => ({ jobs: [] }),
    readClaim: async () => null,
    readResultReceipt: async () => null,
    readReviewVerdict: async () => null,
    readPublication: async () => null,
    readAcceptance: async () => null,
    readCheckpoint: async () => checkpoint(1),
    readLegacyPr: async () => null,
    ...overrides,
  };
}

// ── developer: terminal result and its observation ─────────────────────
{
  const { state, action } = toDeveloper();
  const receipt = resultReceipt(action, 101);
  const facts = await observer(basePorts({
    readResultReceipt: async () => receipt,
  })).inspect({ issue: 4525, state });
  assert.equal(facts.developer.kind, 'terminal_result');
  assert.equal(facts.developer.outcome, 'implementation_ready');
  assert.equal(facts.developer.target_sha, CANDIDATE);
  assert.equal(facts.developer.checkpoint.version, 1);
  const observed = await observer(basePorts({
    readResultReceipt: async () => receipt,
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(observed.developer.action_id, action.id);
  assert.equal(observed.developer.outcome, 'implementation_ready');
  assert.equal(observed.developer.checkpoint.native_session_id, 'native-1');
  assert.equal(observed.developer.verified, true);
  assert.equal(observed.fencing_generation, state.thread.fencing_generation);
}

// ── developer: wrong Run/source/receipt never progresses ─────────────
{
  const { state, action } = toDeveloper();
  const receipt = resultReceipt(action, 101);
  const cases = [
    ['run_binding_mismatch', basePorts({
      readRun: async () => runRecord(999),
      readResultReceipt: async () => receipt,
    })],
    ['run_source_mismatch', basePorts({
      readRun: async () => runRecord(101, {
        path: '.github/workflows/agent-review.yml', name: 'Agent / Review',
      }),
      readResultReceipt: async () => receipt,
    })],
    ['result_receipt_mismatch', basePorts({
      readResultReceipt: async () => resultReceipt({ ...action, id: '9'.repeat(64) }, 101),
    })],
  ];
  for (const [reason, ports] of cases) {
    const facts = await observer(ports).inspect({ issue: 4525, state });
    assert.equal(facts.developer.kind, 'denied', reason);
    assert.equal(facts.developer.reason, reason);
    const observed = await observer(ports).observe({
      issue: 4525, state, wake: { source: 'manual', reason: 'x' },
    });
    assert.equal(observed.developer, null, reason + ' must not progress');
  }
}

// ── running/claimed/executing differentiation ─────────────────────────
{
  const { state, action } = toDeveloper();
  const running = await observer(basePorts({
    readRun: async () => runRecord(101, {
      status: 'in_progress', conclusion: null,
    }),
    readClaim: async () => ({
      action_id: action.id, run_id: 101, run_attempt: 1,
      fencing_generation: state.thread.fencing_generation,
    }),
    readRunJobs: async () => ({
      jobs: [{ status: 'in_progress', name: 'developer' }],
    }),
  })).inspect({ issue: 4525, state });
  assert.equal(running.developer.kind, 'running');
  assert.equal(running.developer.claimed, true);
  assert.equal(running.developer.executing, true);
  assert.equal(running.developer.jobs, 1);

  const wrongClaim = await observer(basePorts({
    readRun: async () => runRecord(101, {
      status: 'in_progress', conclusion: null,
    }),
    readClaim: async () => ({
      action_id: '9'.repeat(64), run_id: 101, run_attempt: 1,
      fencing_generation: state.thread.fencing_generation,
    }),
  })).inspect({ issue: 4525, state });
  assert.equal(wrongClaim.developer.kind, 'denied');
  assert.equal(wrongClaim.developer.reason, 'claim_mismatch');
}

// ── completed-but-uningested and unavailable are not terminal success ──
{
  const { state } = toDeveloper();
  const facts = await observer(basePorts()).inspect({ issue: 4525, state });
  assert.equal(facts.developer.kind, 'completed_uningested');
  const observed = await observer(basePorts()).observe({
    issue: 4525, state, wake: { source: 'manual', reason: 'x' },
  });
  assert.equal(observed.developer.outcome, 'uningested');
  assert.equal(observed.developer.status, 'completed');

  const unavailableFacts = await observer(basePorts({
    readRun: async () => { throw new Error('GitHub 503'); },
  })).inspect({ issue: 4525, state });
  assert.equal(unavailableFacts.developer.kind, 'unavailable');
}

// ── terminal failure without a receipt is a typed failure ──────────────
{
  const { state } = toDeveloper();
  const failed = await observer(basePorts({
    readRun: async () => runRecord(101, {
      status: 'completed', conclusion: 'timed_out',
    }),
  })).inspect({ issue: 4525, state });
  assert.equal(failed.developer.kind, 'terminal_failure');
  assert.equal(failed.developer.category, 'infrastructure');
  assert.equal(failed.developer.outcome, 'timeout');
  const observed = await observer(basePorts({
    readRun: async () => runRecord(101, {
      status: 'completed', conclusion: 'timed_out',
    }),
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(observed.developer.outcome, 'timeout');
  assert.equal(observed.developer.failure.category, 'infrastructure');
}

// ── reviewer: approved and changes_requested bind the exact HEAD ──────
{
  const { state, action } = toReviewer();
  const approved = await observer(basePorts({
    readRun: async () => runRecord(103, {
      path: '.github/workflows/agent-review.yml', name: 'Agent / Review',
    }),
    readResultReceipt: async () => reviewerReceipt(action, 103, 'approved'),
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(approved.reviewer.outcome, 'approved');
  assert.equal(approved.reviewer.head_sha, CANDIDATE);
  assert.equal(approved.reviewer.evidence_generation, action.evidence_generation);

  const changes = reviewerReceipt(action, 103, 'changes_requested');
  const changed = await observer(basePorts({
    readRun: async () => runRecord(103, {
      path: '.github/workflows/agent-review.yml', name: 'Agent / Review',
    }),
    readResultReceipt: async () => changes,
    readReviewVerdict: async () => ({
      kind: 'agent_review_verdict', outcome: 'changes_requested',
      head_sha: CANDIDATE, findings: [finding('R-1')],
    }),
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(changed.reviewer.outcome, 'changes_requested');
  assert.deepEqual(changed.reviewer.findings, [finding('R-1')]);
}

// ── publisher: publication readback is the effect receipt ─────────────
{
  const { state, action } = toPublisher();
  const observed = await observer(basePorts({
    readRun: async () => runRecord(102, {
      path: '.github/workflows/store-qwen-publisher.yml',
      name: 'Store / Qwen Publisher',
    }),
    readPublication: async () => ({
      issue: 4525, action_id: action.id, run_id: 102, run_attempt: 1,
      head_sha: CANDIDATE,
      pr: {
        number: 4525, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
    }),
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(observed.publisher.outcome, 'published');
  assert.equal(observed.publisher.pr.head_sha, CANDIDATE);
}

// ── acceptance and merge facts ────────────────────────────────────────
{
  const { state, action } = toAcceptor();
  const observed = await observer(basePorts({
    readRun: async () => runRecord(104, {
      path: '.github/workflows/agent-sc-acceptance.yml',
      name: 'Agent / SC Acceptance',
    }),
    readAcceptance: async () => ({
      issue: 4525, action_id: action.id, run_id: 104, run_attempt: 1,
      head_sha: CANDIDATE, outcome: 'passed', digest: ACCEPT_DIGEST,
      failed_criteria: [],
    }),
  })).observe({ issue: 4525, state, wake: { source: 'manual', reason: 'x' } });
  assert.equal(observed.acceptance.outcome, 'passed');
  assert.equal(observed.acceptance.stage, 'pr');
}
{
  const state = toWaitingMerge();
  const facts = await observer(basePorts({
    readPull: async () => ({
      number: 4525, state: 'merged', head_sha: CANDIDATE,
      base_sha: PR_BASE, merged_sha: 'd'.repeat(40),
    }),
  })).inspect({ issue: 4525, state });
  assert.equal(facts.merge.kind, 'merged');
  assert.equal(facts.merge.merged_sha, 'd'.repeat(40));
}

// ── legacy PR readback comes only from an authenticated publisher fact ─
{
  const ports = basePorts({
    readLegacyPr: async () => ({
      issue: 4525, number: 4525, head_sha: CANDIDATE,
      base_sha: PR_BASE, state: 'open', merged_sha: null,
    }),
  });
  const pr = await observer(ports).legacyPr({ issue: 4525, state: fresh() });
  assert.equal(pr.number, 4525);
  const wrong = await observer(basePorts({
    readLegacyPr: async () => ({
      issue: 9999, number: 4525, head_sha: CANDIDATE,
      base_sha: PR_BASE, state: 'open', merged_sha: null,
    }),
  })).legacyPr({ issue: 4525, state: fresh() });
  assert.equal(wrong, null);
}

// ── production composition exposes real scoped bindings ────────────────
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-facts-prod-'));
  try {
    const ports = createProductionObserverPorts({
      token: 'test-read-token', storeRoot: root,
    });
    for (const name of ['readPull', 'readRun', 'readResultReceipt',
      'readReviewVerdict', 'readPublication', 'readAcceptance',
      'readCheckpoint', 'readLegacyPr']) {
      assert.equal(typeof ports[name], 'function', name + ' binding');
    }
    const { state, action } = toDeveloper();
    const receipt = resultReceipt(action, 101);
    const dir = path.join(root, 'workflows', 'issues', '4525', 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '101-1-' + action.id + '.json'),
      JSON.stringify(receipt, null, 2) + '\n');
    const loaded = await ports.readResultReceipt({
      issue: 4525, actionId: action.id, runId: 101, attempt: 1,
    });
    assert.equal(loaded.action_id, action.id);
    const wrong = await ports.readResultReceipt({
      issue: 4525, actionId: '0'.repeat(64), runId: 101, attempt: 1,
    });
    assert.equal(wrong, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('agent workflow facts selftest: OK');
