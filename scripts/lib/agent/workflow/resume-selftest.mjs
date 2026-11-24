// Issue #4482 SC-04/SC-05 fixtures: committed native checkpoint identity
// survives retries and repair, uncommitted progress may be lost, the first
// attempt without a checkpoint restarts the same logical Thread, incompatible
// checkpoints block, stale fences cannot publish, and merge/SC policy cannot be
// bypassed (merge receipt required; post-merge failure never rewrites the PR).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { decideLifecycle, fenceGeneration, updateExecutionState } from './lifecycle.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const CANDIDATE2 = 'd'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
const REVIEW_DIGEST = '1'.repeat(64);
const ACCEPT_DIGEST = '2'.repeat(64);
let clock = 1000;

function freshState() {
  return createLifecycleState({
    registry, issue: 4482, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority: {
      repository: 'BestNathan/nession', event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now: 1000,
  });
}
function active(state) {
  return state.outbox.find((entry) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(entry.status));
}
function observation(state, patch = {}, wakeSource = 'github_event') {
  return {
    issue: state.issue, state_version: state.version, observed_at: clock++,
    wake: { source: wakeSource, reason: 'fixture', correlation_id: 'c1' },
    pr: null, developer: null, publisher: null, ci: null,
    reviewer: null, acceptance: null, merge: null,
    ...patch,
  };
}
function step(state, patch = {}, config = {}) {
  return decideLifecycle(state, observation(state, patch), config);
}
function apply(decision) {
  assert.ok(decision.nextState, decision.reason);
  return decision.nextState;
}
function checkpoint(version) {
  return {
    version, commit_sha: '3'.repeat(40),
    ciphertext_sha256: '4'.repeat(64), native_session_id: 'native-' + version,
  };
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
function developerEvent(action, runId, patch) {
  return {
    action_id: action.id, run_id: runId, attempt: 1, status: 'completed',
    outcome: null, target_sha: null, failure: null, checkpoint: null,
    verified: true, ...patch,
  };
}
function failure(action, runId, code, category, checkpointBinding = null) {
  return developerEvent(action, runId, {
    outcome: 'failed',
    failure: { category, code },
    checkpoint: checkpointBinding,
  });
}

// ── committed checkpoint survives a retry; the Thread does not change ───
{
  let state = freshState();
  const firstThread = state.thread.id;
  let action = active(state);
  state = dispatch(state, action, 101);
  const retried = step(state, {
    developer: failure(action, 101, 'provider_crash', 'model', checkpoint(2)),
  });
  state = apply(retried);
  assert.equal(state.phase, 'developing');
  assert.equal(state.thread.id, firstThread, 'a retry is not a new Thread');
  assert.equal(state.thread.attempt, 2);
  assert.deepEqual(state.thread.checkpoint, checkpoint(2),
    'the last committed checkpoint is retained');
  const successor = active(state);
  assert.equal(successor.resume, true);
  assert.equal(successor.predecessor, action.id);
  assert.equal(state.outbox.find((entry) => entry.id === action.id).status, 'failed');
}

// ── first attempt failed before any checkpoint: same Thread, no checkpoint ─
{
  let state = freshState();
  const firstThread = state.thread.id;
  const action = active(state);
  state = dispatch(state, action, 102);
  state = apply(step(state, {
    developer: failure(action, 102, 'no_checkpoint_yet', 'model', null),
  }));
  assert.equal(state.thread.id, firstThread);
  assert.equal(state.thread.checkpoint, null,
    'uncommitted attempt progress is allowed to be lost');
  assert.equal(active(state).resume, true);
}

// ── an incompatible committed checkpoint blocks instead of forking ──────
{
  let state = freshState();
  const action = active(state);
  state = dispatch(state, action, 103);
  const blocked = step(state, {
    developer: failure(action, 103, 'checkpoint_incompatible', 'business', checkpoint(3)),
  });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.reason, 'checkpoint_incompatible');
  assert.equal(blocked.nextState.phase, 'blocked');
  assert.equal(blocked.nextState.blocker.owner_action_required, true);
}

// ── plaintext native bytes and writer credentials never enter V2 state ──
{
  const state = freshState();
  assert.throws(() => validateLifecycleState({
    ...state,
    thread: {
      ...state.thread,
      checkpoint: { ...checkpoint(1), native_bytes: Buffer.from('private session') },
    },
  }), /checkpoint binding/);
  assert.throws(() => decideLifecycle(state, observation(state, {
    developer: developerEvent(active(state), 104, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: { ...checkpoint(1), native_bytes: 'plaintext' },
    }),
  })), /checkpoint binding/);
  const allowed = validateLifecycleState({
    ...state,
    thread: { ...state.thread, checkpoint: checkpoint(1) },
  });
  assert.equal(allowed.thread.checkpoint.native_session_id, 'native-1');
}

// ── stale fence generation cannot publish a result ─────────────────────
{
  let state = freshState();
  const action = active(state);
  state = dispatch(state, action, 105);
  state = fenceGeneration(state, clock++);
  assert.equal(state.thread.fencing_generation, 2);
  const stale = step(state, {
    fencing_generation: 1,
    developer: developerEvent(action, 105, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1),
    }),
  });
  assert.equal(stale.decision, 'stale');
  assert.equal(stale.reason, 'stale_fencing_generation');
  assert.equal(stale.nextState, null);
}

// Drive the happy path to waiting_merge.
function runToWaitingMerge() {
  let state = freshState();
  let action = active(state);
  state = dispatch(state, action, 201);
  state = apply(step(state, {
    developer: developerEvent(action, 201, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1),
    }),
  }));
  assert.equal(state.phase, 'publishing');
  const publish = active(state);
  state = dispatch(state, publish, 202);
  state = apply(step(state, {
    publisher: {
      action_id: publish.id, run_id: 202, attempt: 1, status: 'completed',
      outcome: 'published',
      pr: {
        number: 4500, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  }));
  assert.equal(state.phase, 'ci_checking');
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
  assert.equal(state.phase, 'reviewing');
  const review = active(state);
  state = dispatch(state, review, 203);
  state = apply(step(state, {
    reviewer: {
      action_id: review.id, run_id: 203, attempt: 1, status: 'completed',
      outcome: 'approved', head_sha: CANDIDATE,
      evidence_generation: review.evidence_generation,
      digest: REVIEW_DIGEST, findings: [], verified: true,
    },
  }));
  assert.equal(state.phase, 'evaluating');
  state = apply(step(state));
  assert.equal(state.phase, 'accepting');
  const accept = active(state);
  assert.equal(accept.gate, 'pr');
  state = dispatch(state, accept, 204);
  state = apply(step(state, {
    acceptance: {
      action_id: accept.id, run_id: 204, attempt: 1, stage: 'pr',
      head_sha: CANDIDATE, outcome: 'passed', digest: ACCEPT_DIGEST,
      failed_criteria: [], verified: true,
    },
  }));
  assert.equal(state.phase, 'waiting_merge');
  return state;
}

// ── merge receipt is required; no merge observation means no completion ─
{
  const waiting = runToWaitingMerge();
  const noMerge = step(waiting);
  assert.equal(noMerge.decision, 'wait');
  assert.equal(noMerge.reason, 'await_authorized_merge');
  assert.equal(noMerge.nextState, null);

  const afterMerge = apply(step(waiting, {
    merge: { pr_number: 4500, merged_sha: CANDIDATE2, verified: true },
  }));
  assert.equal(afterMerge.phase, 'post_merge_acceptance');
  assert.equal(afterMerge.thread.merged_sha, CANDIDATE2);
  assert.equal(afterMerge.pr.state, 'merged');
  const mergedAccept = active(afterMerge);
  assert.equal(mergedAccept.gate, 'merged');
  assert.equal(mergedAccept.sha, CANDIDATE2);

  // Post-merge failure blocks and never rewrites the merged PR.
  const merged = dispatch(afterMerge, mergedAccept, 205);
  const failed = step(merged, {
    acceptance: {
      action_id: mergedAccept.id, run_id: 205, attempt: 1, stage: 'merged',
      head_sha: CANDIDATE2, outcome: 'failed', digest: ACCEPT_DIGEST,
      failed_criteria: ['SC-06'], verified: true,
    },
  });
  assert.equal(failed.decision, 'block');
  assert.equal(failed.nextState.phase, 'blocked');
  assert.equal(failed.nextState.blocker.reason, 'merged_acceptance_failed');
  assert.equal(failed.nextState.pr.merged_sha, CANDIDATE2);
  assert.equal(failed.nextState.pr.head_sha, CANDIDATE,
    'the merged PR is never edited by a post-merge failure');

  // Pending merged evidence also blocks instead of inventing completion.
  const pendingMerged = dispatch(afterMerge, mergedAccept, 206);
  const pending = step(pendingMerged, {
    acceptance: {
      action_id: mergedAccept.id, run_id: 206, attempt: 1, stage: 'merged',
      head_sha: CANDIDATE2, outcome: 'pending', digest: ACCEPT_DIGEST,
      failed_criteria: [], verified: true,
    },
  });
  assert.equal(pending.decision, 'block');
  assert.equal(pending.nextState.blocker.reason, 'merged_acceptance_pending');
}

// ── merged Acceptance passed is the only completion path ───────────────
{
  const waiting = runToWaitingMerge();
  const afterMerge = apply(step(waiting, {
    merge: { pr_number: 4500, merged_sha: CANDIDATE2, verified: true },
  }));
  const mergedAccept = active(afterMerge);
  const merged = dispatch(afterMerge, mergedAccept, 207);
  const done = step(merged, {
    acceptance: {
      action_id: mergedAccept.id, run_id: 207, attempt: 1, stage: 'merged',
      head_sha: CANDIDATE2, outcome: 'passed', digest: ACCEPT_DIGEST,
      failed_criteria: [], verified: true,
    },
  });
  assert.equal(done.decision, 'advance');
  assert.equal(done.nextState.phase, 'done');
}

// ── ordinary PR/required-check policy is not redefined by V2 ──────────
{
  const quality = readFileSync('.github/workflows/ci-quality.yml', 'utf8');
  assert.match(quality, /web-check/, 'the existing required aggregate remains');
  const policy = readFileSync('scripts/ci/quality-scope.mjs', 'utf8');
  assert.ok(!policy.includes('Agent / Review') &&
    !policy.includes('Agent / Reviewer') &&
    !policy.includes('reviewer-required'),
  'no Reviewer required-check context is introduced');
  const lifecycleCode = readFileSync('scripts/lib/agent/workflow/lifecycle.mjs', 'utf8');
  assert.ok(!/statuses\.create|checkRuns|check-runs/.test(lifecycleCode),
    'lifecycle code cannot mint a Reviewer check');
}

console.log('agent workflow resume selftest: OK');
