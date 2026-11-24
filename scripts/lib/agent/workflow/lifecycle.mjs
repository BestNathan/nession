// Issue #4482 — Agent Workflow V2 lifecycle decision owner.
//
// One pure decision function owns every business transition for a schema v2
// Issue lifecycle. Trusted ingesters attest facts, the Reconcile loop persists
// decisions and executes scoped effects, CI owns deterministic check truth,
// Acceptance owns SC verdicts and the existing merge policy owns merging.
//
// A model, worker or wake source may never select the next business role.
import {
  BUSINESS_PHASES, DEFAULT_CONFIG, FAILURE_CATEGORIES, REVIEW_OUTCOMES,
  REVIEWER_FAILURES, WAKE_SOURCES, activeAction, actionIdFor, assertExecutionTransition,
  blocked, checkpointBinding, evidenceGenerationFor, nextActionOrdinal, stableDigest,
  transitionKey, validateLifecycleState,
} from './contract.mjs';
import { buildFeedbackBundle } from './feedback.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{1,80}$/;

const REVIEW_RUN_STATUSES = ['queued', 'in_progress', 'completed'];
const DEVELOPER_OUTCOMES = ['implementation_ready', 'yielded', 'failed', 'cancelled', 'timeout'];
const PUBLISHER_OUTCOMES = ['published', 'failed', 'ambiguous'];
const TERMINAL_PHASES = new Set(['done', 'cancelled']);

function reject(message) {
  throw new Error('agent workflow lifecycle: ' + message);
}
function onlyKeys(value, allowed, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    reject('invalid ' + label);
  }
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function sha(value, label) {
  if (!SHA40.test(value ?? '')) reject('invalid ' + label);
  return value;
}
function hex(value, label) {
  if (!HEX64.test(value ?? '')) reject('invalid ' + label);
  return value;
}
function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  for (const key of ['max_infrastructure_retries', 'max_model_retries', 'max_repair_rounds']) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 0 || merged[key] > 16) {
      reject('invalid retry/repair policy');
    }
  }
  if (!Number.isSafeInteger(merged.max_steps) || merged.max_steps < 1 || merged.max_steps > 32) {
    reject('invalid work budget');
  }
  return merged;
}

function normalizeFinding(raw) {
  onlyKeys(raw, ['id', 'severity', 'category', 'message', 'file', 'sc'], 'Review finding');
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 200 ||
      !['blocking', 'nonblocking'].includes(raw.severity) ||
      typeof raw.category !== 'string' || raw.category.length < 1 ||
      typeof raw.message !== 'string' || raw.message.length < 1 ||
      raw.message.length > 4000 ||
      (raw.file != null && (typeof raw.file !== 'string' || raw.file.length > 500)) ||
      (raw.sc != null && !/^SC-[0-9]{2}$/.test(raw.sc))) {
    reject('invalid Review finding');
  }
  return {
    id: raw.id,
    severity: raw.severity,
    category: raw.category,
    message: raw.message,
    file: raw.file ?? null,
    sc: raw.sc ?? null,
  };
}

function normalizeFailure(raw) {
  onlyKeys(raw, ['category', 'code'], 'failure classification');
  if (!FAILURE_CATEGORIES.includes(raw.category) ||
      typeof raw.code !== 'string' || raw.code.length < 1 || raw.code.length > 200) {
    reject('invalid failure classification');
  }
  return { category: raw.category, code: raw.code };
}

function normalizeCheckpoint(raw) {
  if (raw == null) return null;
  return checkpointBinding(raw);
}

function normalizePr(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['number', 'head_sha', 'base_sha', 'state', 'merged_sha'], 'PR observation');
  if (!positive(raw.number) || !SHA40.test(raw.head_sha ?? '') ||
      !SHA40.test(raw.base_sha ?? '') ||
      !['open', 'closed', 'merged'].includes(raw.state) ||
      (raw.merged_sha != null && !SHA40.test(raw.merged_sha))) {
    reject('invalid PR observation');
  }
  return {
    number: raw.number,
    head_sha: raw.head_sha,
    base_sha: raw.base_sha,
    state: raw.state,
    merged_sha: raw.merged_sha ?? null,
  };
}

function normalizeWake(raw) {
  onlyKeys(raw, ['source', 'reason', 'correlation_id'], 'wake');
  if (!WAKE_SOURCES.includes(raw.source) ||
      typeof raw.reason !== 'string' || raw.reason.length < 1 || raw.reason.length > 200 ||
      (raw.correlation_id != null &&
       (typeof raw.correlation_id !== 'string' || raw.correlation_id.length > 200))) {
    reject('invalid wake');
  }
  return { source: raw.source, reason: raw.reason, correlation_id: raw.correlation_id ?? null };
}

function normalizeDeveloper(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['action_id', 'run_id', 'attempt', 'status', 'outcome', 'target_sha',
    'failure', 'checkpoint', 'verified'], 'Developer observation');
  hex(raw.action_id, 'Developer action ID');
  if (!positive(raw.run_id) || !positive(raw.attempt) ||
      !REVIEW_RUN_STATUSES.includes(raw.status) || raw.verified !== true) {
    reject('untrusted Developer observation');
  }
  if (raw.status === 'completed') {
    if (!DEVELOPER_OUTCOMES.includes(raw.outcome)) reject('invalid Developer outcome');
    if (raw.target_sha != null) sha(raw.target_sha, 'Developer target SHA');
    if (raw.failure != null) normalizeFailure(raw.failure);
  } else if (raw.outcome != null) {
    reject('non-terminal Developer observation cannot carry an outcome');
  }
  return {
    action_id: raw.action_id,
    run_id: raw.run_id,
    attempt: raw.attempt,
    status: raw.status,
    outcome: raw.outcome ?? null,
    target_sha: raw.target_sha ?? null,
    failure: raw.failure ? normalizeFailure(raw.failure) : null,
    checkpoint: normalizeCheckpoint(raw.checkpoint),
  };
}

function normalizePublisher(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['action_id', 'run_id', 'attempt', 'status', 'outcome', 'pr', 'failure',
    'readback', 'verified'], 'Publisher observation');
  hex(raw.action_id, 'Publisher action ID');
  if (!positive(raw.run_id) || !positive(raw.attempt) ||
      !REVIEW_RUN_STATUSES.includes(raw.status) || raw.verified !== true) {
    reject('untrusted Publisher observation');
  }
  if (raw.status === 'completed') {
    if (!PUBLISHER_OUTCOMES.includes(raw.outcome)) reject('invalid Publisher outcome');
    if (raw.failure != null) normalizeFailure(raw.failure);
  } else if (raw.outcome != null) {
    reject('non-terminal Publisher observation cannot carry an outcome');
  }
  let readback = null;
  if (raw.readback != null) {
    onlyKeys(raw.readback, ['branch_absent', 'pr_absent'], 'Publisher readback');
    if (typeof raw.readback.branch_absent !== 'boolean' ||
        typeof raw.readback.pr_absent !== 'boolean' ||
        raw.readback.branch_absent !== raw.readback.pr_absent) {
      reject('invalid Publisher readback');
    }
    readback = {
      branch_absent: raw.readback.branch_absent,
      pr_absent: raw.readback.pr_absent,
    };
  }
  return {
    action_id: raw.action_id,
    run_id: raw.run_id,
    attempt: raw.attempt,
    status: raw.status,
    outcome: raw.outcome ?? null,
    pr: normalizePr(raw.pr),
    failure: raw.failure ? normalizeFailure(raw.failure) : null,
    readback,
  };
}

function normalizeCi(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['head_sha', 'obligation_sha256', 'status', 'digest', 'checks',
    'observed_at', 'verified'], 'CI observation');
  if (raw.verified !== true) reject('untrusted CI observation');
  sha(raw.head_sha, 'CI HEAD');
  hex(raw.obligation_sha256, 'CI obligation');
  hex(raw.digest, 'CI digest');
  if (!['pending', 'pass', 'actionable_fail', 'infrastructure', 'missing'].includes(raw.status) ||
      !positive(raw.observed_at) || !Array.isArray(raw.checks) || raw.checks.length > 128) {
    reject('invalid CI observation');
  }
  return {
    head_sha: raw.head_sha,
    obligation_sha256: raw.obligation_sha256,
    status: raw.status,
    digest: raw.digest,
    checks: raw.checks.map((check) => {
      onlyKeys(check, ['name', 'workflow', 'conclusion', 'applicability', 'evidence_ref'],
        'CI check');
      if (typeof check.name !== 'string' || typeof check.workflow !== 'string' ||
          !['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped',
            'pending', 'missing', 'unknown'].includes(check.conclusion) ||
          !['applicable', 'not_applicable', 'unknown'].includes(check.applicability) ||
          (check.evidence_ref != null && typeof check.evidence_ref !== 'string')) {
        reject('invalid CI check');
      }
      return {
        name: check.name,
        workflow: check.workflow,
        conclusion: check.conclusion,
        applicability: check.applicability,
        evidence_ref: check.evidence_ref ?? null,
      };
    }),
    observed_at: raw.observed_at,
  };
}

function normalizeReviewer(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['action_id', 'run_id', 'attempt', 'status', 'outcome', 'head_sha',
    'evidence_generation', 'digest', 'findings', 'verified'], 'Reviewer observation');
  hex(raw.action_id, 'Reviewer action ID');
  if (!positive(raw.run_id) || !positive(raw.attempt) ||
      !REVIEW_RUN_STATUSES.includes(raw.status) || raw.verified !== true) {
    reject('untrusted Reviewer observation');
  }
  if (raw.status === 'completed') {
    if (![...REVIEW_OUTCOMES, ...REVIEWER_FAILURES].includes(raw.outcome)) {
      reject('invalid Reviewer outcome');
    }
    sha(raw.head_sha, 'Reviewer HEAD');
    hex(raw.evidence_generation, 'Reviewer evidence generation');
    hex(raw.digest, 'Reviewer digest');
    if (!Array.isArray(raw.findings) || raw.findings.length > 256) {
      reject('invalid Reviewer findings');
    }
    return {
      action_id: raw.action_id,
      run_id: raw.run_id,
      attempt: raw.attempt,
      status: raw.status,
      outcome: raw.outcome,
      head_sha: raw.head_sha,
      evidence_generation: raw.evidence_generation,
      digest: raw.digest,
      findings: raw.findings.map(normalizeFinding),
    };
  }
  if (raw.outcome != null) reject('non-terminal Reviewer observation cannot carry an outcome');
  return {
    action_id: raw.action_id,
    run_id: raw.run_id,
    attempt: raw.attempt,
    status: raw.status,
    outcome: null,
    head_sha: null,
    evidence_generation: null,
    digest: null,
    findings: [],
  };
}

function normalizeAcceptance(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['action_id', 'run_id', 'attempt', 'stage', 'head_sha', 'outcome', 'digest',
    'failed_criteria', 'verified'], 'Acceptance observation');
  hex(raw.action_id, 'Acceptance action ID');
  if (raw.verified !== true || !positive(raw.run_id) || !positive(raw.attempt) ||
      !['pr', 'merged'].includes(raw.stage) ||
      !['passed', 'failed', 'pending'].includes(raw.outcome)) {
    reject('untrusted Acceptance observation');
  }
  sha(raw.head_sha, 'Acceptance HEAD');
  hex(raw.digest, 'Acceptance digest');
  if (!Array.isArray(raw.failed_criteria) ||
      raw.failed_criteria.some((criterion) => !/^SC-[0-9]{2}$/.test(criterion ?? ''))) {
    reject('invalid failed criteria');
  }
  return {
    action_id: raw.action_id,
    run_id: raw.run_id,
    attempt: raw.attempt,
    stage: raw.stage,
    head_sha: raw.head_sha,
    outcome: raw.outcome,
    digest: raw.digest,
    failed_criteria: raw.failed_criteria,
  };
}

function normalizeMerge(raw) {
  if (raw == null) return null;
  onlyKeys(raw, ['pr_number', 'merged_sha', 'verified'], 'merge observation');
  if (raw.verified !== true || !positive(raw.pr_number) || !SHA40.test(raw.merged_sha ?? '')) {
    reject('untrusted merge observation');
  }
  return { pr_number: raw.pr_number, merged_sha: raw.merged_sha };
}

export function normalizeObservation(observation, state) {
  onlyKeys(observation, ['issue', 'state_version', 'observed_at', 'wake', 'pr',
    'fencing_generation',
    'developer', 'publisher', 'ci', 'reviewer', 'acceptance', 'merge'], 'observation');
  if (!positive(observation.issue) || observation.issue !== state.issue ||
      !positive(observation.state_version) || !positive(observation.observed_at) ||
      observation.state_version !== state.version || observation.wake == null) {
    reject('observation is not bound to the current state version');
  }
  if (observation.fencing_generation != null &&
      (!Number.isSafeInteger(observation.fencing_generation) ||
       observation.fencing_generation < 1)) {
    reject('invalid observation fencing generation');
  }
  return {
    issue: observation.issue,
    state_version: observation.state_version,
    observed_at: observation.observed_at,
    fencing_generation: observation.fencing_generation ?? null,
    wake: normalizeWake(observation.wake),
    pr: normalizePr(observation.pr),
    developer: normalizeDeveloper(observation.developer),
    publisher: normalizePublisher(observation.publisher),
    ci: normalizeCi(observation.ci),
    reviewer: normalizeReviewer(observation.reviewer),
    acceptance: normalizeAcceptance(observation.acceptance),
    merge: normalizeMerge(observation.merge),
  };
}

function wait(state, reason, substate = state.substate) {
  return { decision: 'wait', reason, substate, nextState: null, intents: [] };
}
function ignore(state, reason) {
  return { decision: 'ignore', reason, nextState: null, intents: [] };
}
function stale(state, reason) {
  return { decision: 'stale', reason, nextState: null, intents: [] };
}
function replay(state, reason) {
  return { decision: 'replay', reason, nextState: null, intents: [] };
}
function invalid(state, reason) {
  return { decision: 'invalid', reason, nextState: null, intents: [] };
}
function recover(state, reason, nextState = null, intents = []) {
  return { decision: 'recover', reason, nextState, intents };
}

const RUN_BINDING_STATES = new Set(['dispatched', 'claimed', 'executing', 'ambiguous']);
function applyActionUpdate(action, changes) {
  const merged = { ...action, ...changes };
  // The prepared dispatch intent is replaced by the verified Run binding; it
  // must not linger on a state that does not accept a dispatch receipt.
  if (changes.status != null && RUN_BINDING_STATES.has(changes.status)) {
    merged.receipt = null;
  }
  return merged;
}
function actionUpdates(updates) {
  const byId = new Map(updates.map((update) => [update.id, update]));
  return (action) => {
    const update = byId.get(action.id);
    if (!update) return action;
    return applyActionUpdate(action, update.changes);
  };
}

function makeAction(state, nextVersion, {
  role, action, sha: target, evidence_generation = null, resume = false,
  feedback_sha256 = null, gate = null, predecessor = null, agent_id = null,
}) {
  const ordinal = nextActionOrdinal(state, role, action);
  const id = actionIdFor({
    issue: state.issue, thread_id: state.thread.id,
    // System notifications have no model role but still need a stable identity.
    role: role ?? 'system', action, sha: target, ordinal, predecessor,
  });
  const assigned = role == null ? null :
    role === 'publisher' ? (agent_id ?? 'trusted-publisher') :
    state.assignments[role];
  if (role != null && !AGENT_ID.test(assigned ?? '')) reject('missing action assignment');
  return {
    id,
    role,
    action,
    sha: target,
    evidence_generation,
    agent_id: assigned,
    feedback_sha256,
    resume,
    gate,
    status: 'pending',
    attempts: 0,
    run: null,
    receipt: null,
    predecessor,
    created_version: nextVersion,
  };
}

function intentFor(action) {
  if (action.role == null) {
    return {
      type: 'notify', action_id: action.id, action: action.action, sha: action.sha,
    };
  }
  if (action.role === 'publisher') {
    return {
      type: 'publish', action_id: action.id, role: 'publisher', action: 'publish',
      sha: action.sha,
    };
  }
  if (action.role === 'acceptor') {
    return {
      type: 'accept', action_id: action.id, role: 'acceptor', action: 'accept',
      sha: action.sha, gate: action.gate,
    };
  }
  return {
    type: 'dispatch', action_id: action.id, role: action.role, action: action.action,
    sha: action.sha, agent_id: action.agent_id,
    evidence_generation: action.evidence_generation,
    feedback_sha256: action.feedback_sha256, resume: action.resume,
  };
}

function commit(state, {
  phase = state.phase, substate = state.substate, transition = null,
  updates = [], newActions = [], patch = {}, now,
}) {
  const version = state.version + 1;
  const applyUpdate = actionUpdates(updates.map((update) => ({
    id: update.id, changes: update.changes,
  })));
  const outbox = state.outbox.map(applyUpdate).concat(newActions);
  const next = {
    ...state,
    ...patch,
    phase,
    substate,
    version,
    updated_at: now,
    transitions: transition == null ? state.transitions : [
      ...state.transitions,
      { ...transition, recorded_version: version },
    ],
    outbox,
  };
  return validateLifecycleState(next);
}

function transitionFor(state, {
  kind, outcome, action = null, run_id = null, attempt = null, target_sha = null,
  evidence_generation = null,
}) {
  const event = {
    issue: state.issue, kind, outcome,
    action_id: action?.id ?? null,
    run_id, attempt, target_sha,
    evidence_generation,
  };
  return { key: transitionKey(event), kind, outcome,
    action_id: event.action_id, run_id, attempt, target_sha, evidence_generation };
}

function eventReplay(state, kind, events) {
  for (const event of events) {
    if (event == null) continue;
    const existing = state.transitions.find((transition) =>
      transition.kind === kind &&
      (event.action_id == null || transition.action_id === event.action_id) &&
      (event.run_id == null || transition.run_id === event.run_id) &&
      (event.attempt == null || transition.attempt === event.attempt));
    if (!existing) continue;
    if (existing.outcome !== (event.outcome ?? existing.outcome) ||
        (event.target_sha != null && existing.target_sha !== event.target_sha) ||
        (event.evidence_generation != null &&
         existing.evidence_generation !== event.evidence_generation)) {
      return { conflict: true, transition: existing };
    }
    return { replay: true, transition: existing };
  }
  return null;
}

function fence(state, reason, action = null) {
  if (action == null || ['retired', 'failed', 'cancelled', 'yielded'].includes(action.status)) {
    return [];
  }
  return [{
    id: action.id,
    changes: { status: 'cancelled', receipt: { status: 'cancelled', reason } },
  }];
}

function blockState(state, reason, { now, action = null, transition = null, patch = {}, update = null }) {
  const updates = fence(state, reason, action);
  if (update != null) updates.push(update);
  return commit(state, {
    phase: 'blocked', substate: 'blocked', now,
    transition,
    updates,
    patch: { ...patch, blocker: blocked(reason) },
  });
}

function recordRun(action, observation) {
  return {
    id: observation.run_id,
    attempt: observation.attempt,
    verified: true,
  };
}

function budgetRetry(state, category, config) {
  const infrastructure = category === 'infrastructure';
  const key = infrastructure ? 'infrastructure_retries' : 'model_retries';
  const max = infrastructure ?
    config.max_infrastructure_retries : config.max_model_retries;
  const next = state.budgets[key] + 1;
  return { key, next, exhausted: next > max, budget: { ...state.budgets, [key]: next } };
}

function latestDeveloperAction(state) {
  return [...state.outbox].reverse().find((entry) =>
    entry.role === 'developer' && entry.status === 'committed') ?? null;
}

function decidePendingDispatch(state, action, reason) {
  return {
    decision: 'advance',
    reason,
    substate: action.role + '_dispatch_pending',
    nextState: null,
    intents: [intentFor(action)],
  };
}

function decideDeveloper(state, observation, config, now) {
  const action = activeAction(state);
  if (action == null || action.role !== 'developer') {
    return invalid(state, 'no active Developer action');
  }
  if (action.status === 'failed' || action.status === 'cancelled') {
    return invalid(state, 'active Developer action is terminal');
  }
  const developer = observation.developer;
  const matched = developer != null && developer.action_id === action.id;
  if (!matched) {
    if (developer != null) return stale(state, 'developer_result_for_another_action');
    if (action.status === 'pending') return decidePendingDispatch(state, action, 'dispatch_developer');
    if (action.status === 'dispatching' || action.status === 'ambiguous') {
      return wait(state, 'await_dispatch_readback', 'developer_dispatching');
    }
    return wait(state, 'await_developer', 'developer_running');
  }
  if (developer.status === 'queued' || developer.status === 'in_progress') {
    if (action.run != null && (action.run.id !== developer.run_id ||
        action.run.attempt !== developer.attempt)) {
      return stale(state, 'developer_run_identity_changed');
    }
    if (['dispatched', 'claimed', 'executing'].includes(action.status) &&
        action.run != null) {
      return wait(state, 'developer_running', 'developer_executing');
    }
    // First verified observation of the Run adopts it without a model rerun.
    return {
      decision: 'advance',
      reason: 'adopt_verified_run',
      substate: 'developer_executing',
      nextState: commit(state, {
        phase: state.phase, substate: 'developer_executing', now,
        updates: [{ id: action.id, changes: {
          status: developer.status === 'queued' ? 'dispatched' : 'executing',
          run: recordRun(action, developer), attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  // Terminal Developer result. A Run that was never adopted is adopted first;
  // the business transition happens on the next bounded reconcile step.
  if (action.run == null) {
    return {
      decision: 'advance',
      reason: 'adopt_terminal_run_before_result',
      substate: 'developer_result_pending',
      nextState: commit(state, {
        phase: state.phase, substate: 'developer_result_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'dispatched', run: recordRun(action, developer),
          attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  if (action.run.id !== developer.run_id || action.run.attempt !== developer.attempt) {
    return stale(state, 'developer_result_run_mismatch');
  }
  const replayCheck = eventReplay(state, 'developer', [developer]);
  if (replayCheck?.conflict) return invalid(state, 'conflicting developer replay');
  if (replayCheck?.replay) return replay(state, 'developer_result_already_committed');
  const checkpoint = developer.checkpoint;
  if (developer.outcome === 'implementation_ready') {
    if (checkpoint == null) return stale(state, 'developer_result_missing_checkpoint');
    if (developer.target_sha == null) return stale(state, 'developer_result_missing_target_sha');
    if (developer.target_sha === state.thread.head_sha) {
      return stale(state, 'developer_result_does_not_advance_head');
    }
    const publishAction = makeAction(state, state.version + 1, {
      role: 'publisher', action: 'publish', sha: developer.target_sha,
    });
    const transition = transitionFor(state, {
      kind: 'developer', outcome: 'implementation_ready', action,
      run_id: developer.run_id, attempt: developer.attempt,
      target_sha: developer.target_sha,
    });
    return {
      decision: 'advance',
      reason: 'developer_ready_publish',
      substate: 'publish_pending',
      nextState: commit(state, {
        phase: 'publishing', substate: 'publish_pending', now, transition,
        updates: [{ id: action.id, changes: {
          status: 'committed',
          run: recordRun(action, developer),
          receipt: {
            status: 'available', dispatch_id: action.id,
            source_run_id: developer.run_id, source_attempt: developer.attempt,
            outcome: 'implementation_ready', evidence_generation: null,
          },
        } }],
        newActions: [publishAction],
        patch: {
          thread: { ...state.thread, checkpoint, attempt: state.thread.attempt },
        },
      }),
      intents: [intentFor(publishAction)],
    };
  }
  if (developer.outcome === 'yielded') {
    if (checkpoint == null) return stale(state, 'yielded_slice_missing_checkpoint');
    const continuation = makeAction(state, state.version + 1, {
      role: 'developer', action: action.action, sha: action.sha, resume: true,
      predecessor: action.id,
    });
    return {
      decision: 'advance',
      reason: 'developer_yield_continuation',
      substate: 'continuation_pending',
      nextState: commit(state, {
        phase: 'developing', substate: 'continuation_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'yielded',
          run: recordRun(action, developer),
          receipt: {
            status: 'yielded', dispatch_id: action.id,
            source_run_id: developer.run_id, source_attempt: developer.attempt,
            checkpoint_version: checkpoint.version,
            checkpoint_commit_sha: checkpoint.commit_sha,
            ciphertext_sha256: checkpoint.ciphertext_sha256,
          },
        } }],
        newActions: [continuation],
        patch: {
          thread: {
            ...state.thread, checkpoint, attempt: state.thread.attempt + 1,
          },
        },
      }),
      intents: [intentFor(continuation)],
    };
  }
  // failed / cancelled / timeout
  const category = developer.failure?.category ??
    (developer.outcome === 'timeout' || developer.outcome === 'cancelled' ?
      'infrastructure' : 'model');
  const failureCode = developer.failure?.code ?? developer.outcome;
  const failureUpdateBase = {
    id: action.id,
    changes: {
      status: 'failed',
      run: recordRun(action, developer),
      receipt: {
        status: 'failed', dispatch_id: action.id,
        source_run_id: developer.run_id, source_attempt: developer.attempt,
        failure_code: failureCode, category,
      },
    },
  };
  const failureTransition = transitionFor(state, {
    kind: 'developer', outcome: developer.outcome, action,
    run_id: developer.run_id, attempt: developer.attempt, target_sha: action.sha,
  });
  if (developer.failure?.code === 'checkpoint_incompatible' ||
      developer.failure?.code === 'checkpoint_corrupt') {
    // A committed checkpoint that cannot be restored must never silently fork
    // a new native session. Block with an owner migration path.
    return {
      decision: 'block',
      reason: developer.failure.code,
      substate: 'blocked',
      nextState: blockState(state, developer.failure.code, {
        now, update: failureUpdateBase, transition: failureTransition,
      }),
      intents: [],
    };
  }
  const retry = budgetRetry(state, category, config);
  if (retry.exhausted) {
    return {
      decision: 'block',
      reason: category + '_budget_exhausted',
      substate: 'blocked',
      nextState: blockState(state, category + '_budget_exhausted', {
        now, update: failureUpdateBase, transition: failureTransition,
        patch: { budgets: retry.budget },
      }),
      intents: [],
    };
  }
  const successor = makeAction(state, state.version + 1, {
    role: 'developer', action: action.action, sha: action.sha, resume: true,
    predecessor: action.id,
  });
  return {
    decision: 'advance',
    reason: 'developer_retry',
    substate: 'retry_pending',
    nextState: commit(state, {
      phase: 'developing', substate: 'retry_pending', now,
      transition: failureTransition,
      updates: [failureUpdateBase],
      newActions: [successor],
      patch: {
        budgets: retry.budget,
        thread: {
          ...state.thread,
          checkpoint: checkpoint ?? state.thread.checkpoint,
          attempt: state.thread.attempt + 1,
        },
      },
    }),
    intents: [intentFor(successor)],
  };
}

function decidePublisher(state, observation, config, now) {
  const action = activeAction(state);
  if (action == null || action.role !== 'publisher') {
    return invalid(state, 'no active Publisher action');
  }
  const publisher = observation.publisher;
  const matched = publisher != null && publisher.action_id === action.id;
  if (!matched) {
    if (publisher != null) return stale(state, 'publisher_result_for_another_action');
    if (action.status === 'pending') return decidePendingDispatch(state, action, 'dispatch_publisher');
    if (action.status === 'dispatching' || action.status === 'ambiguous') {
      return wait(state, 'await_publish_readback', 'publisher_dispatching');
    }
    return wait(state, 'await_publisher', 'publisher_running');
  }
  if (publisher.status === 'queued' || publisher.status === 'in_progress') {
    if (action.run == null) {
      return {
        decision: 'advance',
        reason: 'adopt_publisher_run',
        substate: 'publisher_executing',
        nextState: commit(state, {
          phase: state.phase, substate: 'publisher_executing', now,
          updates: [{ id: action.id, changes: {
            status: publisher.status === 'queued' ? 'dispatched' : 'executing',
            run: recordRun(action, publisher), attempts: action.attempts + 1,
          } }],
        }),
        intents: [],
      };
    }
    return wait(state, 'publisher_running', 'publisher_executing');
  }
  if (action.run == null) {
    return {
      decision: 'advance',
      reason: 'adopt_terminal_publisher_run',
      substate: 'publisher_result_pending',
      nextState: commit(state, {
        phase: state.phase, substate: 'publisher_result_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'dispatched', run: recordRun(action, publisher),
          attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  if (action.run.id !== publisher.run_id ||
      action.run.attempt !== publisher.attempt) {
    return stale(state, 'publisher_result_run_mismatch');
  }
  const replayCheck = eventReplay(state, 'publisher', [publisher]);
  if (replayCheck?.conflict) return invalid(state, 'conflicting publisher replay');
  if (replayCheck?.replay) return replay(state, 'publisher_result_already_committed');
  if (publisher.outcome === 'published') {
    const pr = publisher.pr;
    if (pr == null) return stale(state, 'published_result_missing_pr');
    if (pr.head_sha !== action.sha) return invalid(state, 'publisher_head_differs_from_accepted_patch');
    if (state.pr != null && pr.number !== state.pr.number) {
      return invalid(state, 'publisher_created_a_second_pr');
    }
    if (pr.state !== 'open') return stale(state, 'published_pr_not_open');
    const transition = transitionFor(state, {
      kind: 'publisher', outcome: 'published', action,
      run_id: publisher.run_id, attempt: publisher.attempt, target_sha: pr.head_sha,
    });
    return {
      decision: 'advance',
      reason: 'published_wait_ci',
      substate: 'ci_pending',
      nextState: commit(state, {
        phase: 'ci_checking', substate: 'ci_pending', now, transition,
        updates: [{ id: action.id, changes: {
          status: 'committed',
          run: recordRun(action, publisher),
          receipt: {
            status: 'available', dispatch_id: action.id,
            source_run_id: publisher.run_id, source_attempt: publisher.attempt,
            outcome: 'published', evidence_generation: null,
          },
        } }],
        patch: {
          pr: { ...pr, merged_sha: null },
          thread: {
            ...state.thread, head_sha: pr.head_sha,
            merged_sha: null,
          },
          ci: null,
          review: null,
          feedback: null,
        },
      }),
      intents: [],
    };
  }
  // failed / ambiguous: adopt a verified readback, otherwise never re-POST.
  if (publisher.outcome === 'ambiguous' && publisher.pr != null &&
      publisher.pr.head_sha === action.sha &&
      (state.pr == null || publisher.pr.number === state.pr.number)) {
    const transition = transitionFor(state, {
      kind: 'publisher', outcome: 'published', action,
      run_id: publisher.run_id, attempt: publisher.attempt,
      target_sha: publisher.pr.head_sha,
    });
    return {
      decision: 'advance',
      reason: 'adopted_publisher_readback',
      substate: 'ci_pending',
      nextState: commit(state, {
        phase: 'ci_checking', substate: 'ci_pending', now, transition,
        updates: [{ id: action.id, changes: {
          status: 'committed',
          run: recordRun(action, publisher),
          receipt: {
            status: 'available', dispatch_id: action.id,
            source_run_id: publisher.run_id, source_attempt: publisher.attempt,
            outcome: 'published', evidence_generation: null,
          },
        } }],
        patch: {
          pr: { ...publisher.pr, merged_sha: null },
          thread: { ...state.thread, head_sha: publisher.pr.head_sha, merged_sha: null },
          ci: null, review: null, feedback: null,
        },
      }),
      intents: [],
    };
  }
  const category = publisher.failure?.category ?? 'business';
  const retry = budgetRetry(state, category, config);
  const failureUpdate = {
    id: action.id,
    changes: {
      status: publisher.outcome === 'ambiguous' ? 'ambiguous' : 'failed',
      run: recordRun(action, publisher),
      ...(publisher.outcome === 'ambiguous' ? {} : {
        receipt: {
          status: 'failed', dispatch_id: action.id,
          source_run_id: publisher.run_id, source_attempt: publisher.attempt,
          failure_code: publisher.failure?.code ?? publisher.outcome, category,
        },
      }),
    },
  };
  const transition = transitionFor(state, {
    kind: 'publisher', outcome: publisher.outcome, action,
    run_id: publisher.run_id, attempt: publisher.attempt, target_sha: action.sha,
  });
  if (retry.exhausted || publisher.outcome === 'ambiguous') {
    return {
      decision: 'block',
      reason: publisher.outcome === 'ambiguous' ?
        'ambiguous_publisher_effect' : 'publisher_budget_exhausted',
      substate: 'blocked',
      nextState: blockState(state, publisher.outcome === 'ambiguous' ?
        'ambiguous_publisher_effect' : 'publisher_budget_exhausted', {
        now, update: failureUpdate, transition, patch: { budgets: retry.budget },
      }),
      intents: [],
    };
  }
  // A proven-absent branch/PR is the only safe case for one bounded retry.
  if (publisher.readback == null || !publisher.readback.branch_absent ||
      !publisher.readback.pr_absent) {
    return recover(state, 'publisher_effect_unverified');
  }
  const successor = makeAction(state, state.version + 1, {
    role: 'publisher', action: 'publish', sha: action.sha, predecessor: action.id,
  });
  return {
    decision: 'advance',
    reason: 'publisher_retry',
    substate: 'publish_retry',
    nextState: commit(state, {
      phase: 'publishing', substate: 'publish_retry', now, transition,
      updates: [failureUpdate],
      newActions: [successor],
      patch: { budgets: retry.budget },
    }),
    intents: [intentFor(successor)],
  };
}

// Review/aggregate bits derived from a previous evidence generation. CI itself
// is replaced explicitly by the caller so a fresh terminal observation is not
// accidentally erased.
function invalidateEvidence() {
  return { review: null, feedback: null };
}

function decideCi(state, observation, config, now) {
  const head = state.thread.head_sha;
  if (head == null) return invalid(state, 'CI phase without a published HEAD');
  const ci = observation.ci;
  if (ci == null) return wait(state, 'await_ci', 'ci_pending');
  if (ci.head_sha !== head) return stale(state, 'ci_evidence_for_another_head');
  const priorObligation = state.ci?.obligation_sha256 ?? null;
  if (priorObligation != null && priorObligation !== ci.obligation_sha256) {
    // The trusted obligation set changed for the same HEAD. Every existing
    // review/feedback bit is invalid; re-freeze and recollect.
    const transition = transitionFor(state, {
      kind: 'ci', outcome: 'obligation_refrozen', target_sha: head,
      evidence_generation: ci.obligation_sha256,
    });
    return recover(state, 'ci_obligation_refrozen', commit(state, {
      phase: 'ci_checking', substate: 'ci_pending', now, transition,
      patch: { ci, ...invalidateEvidence(state) },
    }), []);
  }
  if (ci.status === 'pending') {
    if (state.ci != null &&
        state.ci.obligation_sha256 === ci.obligation_sha256 &&
        state.ci.status === 'pending') {
      return wait(state, 'ci_pending', 'ci_pending');
    }
    return {
      decision: 'advance',
      reason: 'ci_pending_obligation_frozen',
      substate: 'ci_pending',
      nextState: commit(state, {
        phase: 'ci_checking', substate: 'ci_pending', now,
        patch: { ci },
      }),
      intents: [],
    };
  }
  if (ci.status === 'pass' || ci.status === 'actionable_fail') {
    const generation = evidenceGenerationFor({
      head_sha: head, ci_digest: ci.digest,
    });
    if (state.review != null &&
        state.review.head_sha === head &&
        state.migration?.legacy_order === 'reviewer_first') {
      // The legacy Reviewer-first verdict is already committed; CI is the only
      // missing side of the aggregate. Do not run a second Reviewer.
      return {
        decision: 'advance',
        reason: 'legacy_ci_completes_aggregate',
        substate: 'aggregate_pending',
        nextState: commit(state, {
          phase: 'evaluating', substate: 'aggregate_pending', now,
          patch: { ci },
        }),
        intents: [],
      };
    }
    const reviewAction = makeAction(state, state.version + 1, {
      role: 'reviewer', action: 'review', sha: head,
      evidence_generation: generation,
    });
    const transition = transitionFor(state, {
      kind: 'ci', outcome: ci.status, target_sha: head,
      evidence_generation: generation,
    });
    return {
      decision: 'advance',
      reason: 'ci_barrier_terminal_dispatch_reviewer',
      substate: 'review_pending',
      nextState: commit(state, {
        phase: 'reviewing', substate: 'review_pending', now, transition,
        newActions: [reviewAction],
        patch: { ci, ...invalidateEvidence(state) },
      }),
      intents: [intentFor(reviewAction)],
    };
  }
  // missing / infrastructure: bounded recovery, never an invented pass.
  const category = 'infrastructure';
  const retry = budgetRetry(state, category, config);
  const reason = ci.status === 'missing' ? 'ci_evidence_missing' : 'ci_infrastructure_failure';
  if (retry.exhausted) {
    return {
      decision: 'block',
      reason,
      substate: 'blocked',
      nextState: blockState(state, reason, {
        now, patch: { ci, budgets: retry.budget, ...invalidateEvidence(state) },
      }),
      intents: [],
    };
  }
  return recover(state, reason, commit(state, {
    phase: 'ci_checking', substate: 'ci_recovery', now,
    patch: { ci, budgets: retry.budget, ...invalidateEvidence(state) },
  }), [{ type: 'retry_ci', sha: head, obstacle: reason }]);
}

function decideReviewer(state, observation, config, now) {
  const action = activeAction(state);
  if (action == null || action.role !== 'reviewer') {
    return invalid(state, 'no active Reviewer action');
  }
  // A materially changed CI evidence generation invalidates this Review and
  // any aggregate it could produce. Fence the Reviewer and recollect.
  if (observation.ci != null &&
      ['pass', 'actionable_fail', 'infrastructure', 'missing'].includes(observation.ci.status) &&
      observation.ci.head_sha === state.thread.head_sha &&
      evidenceGenerationFor({
        head_sha: state.thread.head_sha, ci_digest: observation.ci.digest,
      }) !== action.evidence_generation) {
    return recover(state, 'ci_evidence_generation_changed', commit(state, {
      phase: 'ci_checking', substate: 'ci_pending', now,
      updates: [{
        id: action.id,
        changes: {
          status: 'cancelled',
          receipt: { status: 'cancelled', reason: 'ci_evidence_generation_changed' },
        },
      }],
      patch: {
        ci: observation.ci,
        review: null,
        feedback: null,
      },
    }), []);
  }
  const reviewer = observation.reviewer;
  const matched = reviewer != null && reviewer.action_id === action.id;
  if (!matched) {
    if (reviewer != null) return stale(state, 'reviewer_result_for_another_action');
    if (action.status === 'pending') return decidePendingDispatch(state, action, 'dispatch_reviewer');
    if (action.status === 'dispatching' || action.status === 'ambiguous') {
      return wait(state, 'await_dispatch_readback', 'reviewer_dispatching');
    }
    return wait(state, 'await_reviewer', 'reviewer_running');
  }
  if (reviewer.status === 'queued' || reviewer.status === 'in_progress') {
    if (action.run == null) {
      return {
        decision: 'advance',
        reason: 'adopt_reviewer_run',
        substate: 'reviewer_executing',
        nextState: commit(state, {
          phase: state.phase, substate: 'reviewer_executing', now,
          updates: [{ id: action.id, changes: {
            status: reviewer.status === 'queued' ? 'dispatched' : 'executing',
            run: recordRun(action, reviewer), attempts: action.attempts + 1,
          } }],
        }),
        intents: [],
      };
    }
    return wait(state, 'reviewer_running', 'reviewer_executing');
  }
  if (action.run == null) {
    return {
      decision: 'advance',
      reason: 'adopt_terminal_reviewer_run',
      substate: 'reviewer_result_pending',
      nextState: commit(state, {
        phase: state.phase, substate: 'reviewer_result_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'dispatched', run: recordRun(action, reviewer),
          attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  if (action.run.id !== reviewer.run_id ||
      action.run.attempt !== reviewer.attempt) {
    return stale(state, 'reviewer_result_run_mismatch');
  }
  if (!REVIEW_OUTCOMES.includes(reviewer.outcome)) {
    // Reviewer runtime/invalid/cancel/timeout is never a negative code verdict.
    const category = reviewer.outcome === 'cancelled' || reviewer.outcome === 'timeout' ?
      'infrastructure' : 'model';
    const retry = budgetRetry(state, category, config);
    const failureUpdate = {
      id: action.id,
      changes: {
        status: 'failed',
        run: recordRun(action, reviewer),
        receipt: {
          status: 'failed', dispatch_id: action.id,
          source_run_id: reviewer.run_id, source_attempt: reviewer.attempt,
          failure_code: reviewer.outcome, category,
        },
      },
    };
    if (retry.exhausted) {
      return {
        decision: 'block',
        reason: 'reviewer_runtime_budget_exhausted',
        substate: 'blocked',
        nextState: blockState(state, 'reviewer_runtime_budget_exhausted', {
          now, update: failureUpdate, patch: { budgets: retry.budget },
        }),
        intents: [],
      };
    }
    const successor = makeAction(state, state.version + 1, {
      role: 'reviewer', action: 'review', sha: action.sha,
      evidence_generation: action.evidence_generation, predecessor: action.id,
    });
    return {
      decision: 'advance',
      reason: 'reviewer_retry',
      substate: 'review_retry',
      nextState: commit(state, {
        phase: 'reviewing', substate: 'review_retry', now,
        updates: [failureUpdate],
        newActions: [successor],
        patch: { budgets: retry.budget },
      }),
      intents: [intentFor(successor)],
    };
  }
  if (reviewer.head_sha !== state.thread.head_sha ||
      reviewer.evidence_generation !== action.evidence_generation) {
    return stale(state, 'reviewer_evidence_for_another_generation');
  }
  const legacyReviewerFirst = state.migration?.legacy_order === 'reviewer_first';
  if (state.ci == null && !legacyReviewerFirst) {
    return invalid(state, 'reviewer_result_without_terminal_ci');
  }
  if (state.ci != null && !['pass', 'actionable_fail'].includes(state.ci.status)) {
    return invalid(state, 'reviewer_result_without_terminal_ci');
  }
  const replayCheck = eventReplay(state, 'reviewer', [reviewer]);
  if (replayCheck?.conflict) return invalid(state, 'conflicting reviewer replay');
  if (replayCheck?.replay) return replay(state, 'reviewer_result_already_committed');
  const transition = transitionFor(state, {
    kind: 'reviewer', outcome: reviewer.outcome, action,
    run_id: reviewer.run_id, attempt: reviewer.attempt,
    target_sha: reviewer.head_sha, evidence_generation: reviewer.evidence_generation,
  });
  return {
    decision: 'advance',
    reason: 'review_terminal_aggregate',
    substate: 'aggregate_pending',
    nextState: commit(state, {
      phase: 'evaluating', substate: 'aggregate_pending', now, transition,
      updates: [{ id: action.id, changes: {
        status: 'committed',
        run: recordRun(action, reviewer),
        receipt: {
          status: 'available', dispatch_id: action.id,
          source_run_id: reviewer.run_id, source_attempt: reviewer.attempt,
          outcome: reviewer.outcome, evidence_generation: reviewer.evidence_generation,
        },
      } }],
      patch: {
        review: {
          head_sha: reviewer.head_sha,
          evidence_generation: reviewer.evidence_generation,
          outcome: reviewer.outcome,
          run_id: reviewer.run_id,
          attempt: reviewer.attempt,
          digest: reviewer.digest,
          findings: reviewer.findings,
        },
      },
    }),
    intents: [],
  };
}

function decideEvaluation(state, observation, config, now) {
  if (state.pr == null || state.thread.head_sha == null) {
    return invalid(state, 'evaluation without a published PR');
  }
  if (state.ci == null && state.review != null &&
      state.migration?.legacy_order === 'reviewer_first') {
    // Legacy Reviewer-first states converge onto the V2 barrier: collect CI
    // for the exact reviewed HEAD before any aggregate decision.
    return recover(state, 'legacy_reviewer_first_collect_ci', commit(state, {
      phase: 'ci_checking', substate: 'ci_pending', now,
    }), []);
  }
  if (state.ci == null || state.review == null) {
    return wait(state, 'await_aggregate_evidence', 'aggregate_pending');
  }
  if (!['pass', 'actionable_fail'].includes(state.ci.status)) {
    return recover(state, 'ci_evidence_unresolved');
  }
  if (!REVIEW_OUTCOMES.includes(state.review.outcome)) {
    return recover(state, 'review_evidence_unresolved');
  }
  if (state.ci.head_sha !== state.thread.head_sha ||
      state.review.head_sha !== state.thread.head_sha) {
    return stale(state, 'aggregate_evidence_for_another_head');
  }
  const ciPass = state.ci.status === 'pass';
  const approved = state.review.outcome === 'approved';
  const generation = evidenceGenerationFor({
    head_sha: state.thread.head_sha,
    ci_digest: state.ci.digest,
    review_digest: state.review.digest,
  });
  if (ciPass && approved) {
    const acceptAction = makeAction(state, state.version + 1, {
      role: 'acceptor', action: 'accept', sha: state.thread.head_sha,
      evidence_generation: generation, gate: 'pr',
    });
    const transition = transitionFor(state, {
      kind: 'evaluation', outcome: 'proceed_acceptance',
      target_sha: state.thread.head_sha, evidence_generation: generation,
    });
    return {
      decision: 'advance',
      reason: 'aggregate_pass_acceptance',
      substate: 'acceptance_pending',
      nextState: commit(state, {
        phase: 'accepting', substate: 'acceptance_pending', now, transition,
        newActions: [acceptAction],
      }),
      intents: [intentFor(acceptAction)],
    };
  }
  const nextRound = state.budgets.repair_rounds + 1;
  if (nextRound > config.max_repair_rounds) {
    return {
      decision: 'block',
      reason: 'repair_budget_exhausted',
      substate: 'blocked',
      nextState: blockState(state, 'repair_budget_exhausted', {
        now, patch: { budgets: { ...state.budgets, repair_rounds: nextRound } },
      }),
      intents: [],
    };
  }
  const bundle = buildFeedbackBundle({
    issue: state.issue, pr: state.pr.number, head_sha: state.thread.head_sha,
    ci: ciPass ? null : state.ci,
    review: approved ? null : state.review,
    prior: state.feedback,
    repair_round: nextRound,
  });
  const predecessor = latestDeveloperAction(state);
  const repairAction = makeAction(state, state.version + 1, {
    role: 'developer', action: 'repair', sha: state.thread.head_sha,
    resume: true, feedback_sha256: bundle.bundle_sha256,
    evidence_generation: generation, predecessor: predecessor?.id ?? null,
  });
  const transition = transitionFor(state, {
    kind: 'evaluation', outcome: 'repair',
    target_sha: state.thread.head_sha, evidence_generation: generation,
  });
  return {
    decision: 'advance',
    reason: 'aggregate_repair',
    substate: 'repair_pending',
    nextState: commit(state, {
      phase: 'developing', substate: 'repair_pending', now, transition,
      newActions: [repairAction],
      patch: {
        feedback: bundle,
        budgets: { ...state.budgets, repair_rounds: nextRound },
      },
    }),
    intents: [intentFor(repairAction)],
  };
}

function decideAccepting(state, observation, config, now) {
  const action = activeAction(state);
  if (action == null || action.role !== 'acceptor' || action.gate !== 'pr') {
    if (state.phase === 'accepting' && action == null) {
      // A committed-but-not-advanced receipt is reconstructed by the
      // evaluation decision on the next reconcile.
      return recover(state, 'acceptance_intent_missing');
    }
    return invalid(state, 'no active PR Acceptance action');
  }
  const acceptance = observation.acceptance;
  const matched = acceptance != null && acceptance.action_id === action.id;
  if (!matched) {
    if (acceptance != null) return stale(state, 'acceptance_for_another_action');
    if (action.status === 'pending') return decidePendingDispatch(state, action, 'dispatch_acceptance');
    if (action.status === 'dispatching' || action.status === 'ambiguous') {
      return wait(state, 'await_acceptance', 'acceptance_running');
    }
    return wait(state, 'await_acceptance', 'acceptance_running');
  }
  if (action.run != null && (action.run.id !== acceptance.run_id ||
      action.run.attempt !== acceptance.attempt)) {
    return stale(state, 'acceptance_run_identity_changed');
  }
  if (acceptance.stage !== 'pr') return stale(state, 'acceptance_wrong_stage');
  if (acceptance.head_sha !== state.thread.head_sha) {
    return stale(state, 'acceptance_for_another_head');
  }
  if (action.run == null) {
    return {
      decision: 'advance',
      reason: 'adopt_terminal_acceptance_run',
      substate: 'acceptance_result_pending',
      nextState: commit(state, {
        phase: state.phase, substate: 'acceptance_result_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'dispatched',
          run: { id: acceptance.run_id, attempt: acceptance.attempt, verified: true },
          attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  if (acceptance.outcome === 'pending') {
    return {
      decision: 'block',
      reason: 'acceptance_pending',
      substate: 'blocked',
      nextState: blockState(state, 'acceptance_pending', {
        now, action, patch: {},
      }),
      intents: [],
    };
  }
  if (acceptance.outcome === 'passed') {
    const mergeNotify = makeAction(state, state.version + 1, {
      role: null, action: 'merge_notify', sha: state.thread.head_sha,
      predecessor: action.id,
    });
    const transition = transitionFor(state, {
      kind: 'acceptance', outcome: 'passed', action,
      run_id: acceptance.run_id, attempt: acceptance.attempt,
      target_sha: state.thread.head_sha,
    });
    return {
      decision: 'advance',
      reason: 'acceptance_passed_requires_authorized_merge',
      substate: 'merge_pending',
      nextState: commit(state, {
        phase: 'waiting_merge', substate: 'merge_pending', now, transition,
        updates: [{ id: action.id, changes: {
          status: 'committed',
          run: action.run,
          receipt: {
            status: 'available', dispatch_id: action.id,
            source_run_id: action.run.id, source_attempt: action.run.attempt,
            outcome: 'passed', evidence_generation: action.evidence_generation,
          },
        } }],
        newActions: [mergeNotify],
      }),
      intents: [intentFor(mergeNotify)],
    };
  }
  // Failed PR Acceptance is an actionable repair source.
  const nextRound = state.budgets.repair_rounds + 1;
  if (nextRound > config.max_repair_rounds) {
    return {
      decision: 'block',
      reason: 'repair_budget_exhausted',
      substate: 'blocked',
      nextState: blockState(state, 'repair_budget_exhausted', {
        now, action, patch: { budgets: { ...state.budgets, repair_rounds: nextRound } },
      }),
      intents: [],
    };
  }
  const bundle = buildFeedbackBundle({
    issue: state.issue, pr: state.pr.number, head_sha: state.thread.head_sha,
    acceptance: {
      head_sha: acceptance.head_sha,
      digest: acceptance.digest,
      failed_criteria: acceptance.failed_criteria,
    },
    prior: state.feedback,
    repair_round: nextRound,
  });
  const predecessor = latestDeveloperAction(state);
  const repairAction = makeAction(state, state.version + 1, {
    role: 'developer', action: 'repair', sha: state.thread.head_sha,
    resume: true, feedback_sha256: bundle.bundle_sha256,
    evidence_generation: action.evidence_generation,
    predecessor: predecessor?.id ?? null,
  });
  const transition = transitionFor(state, {
    kind: 'acceptance', outcome: 'failed', action,
    run_id: acceptance.run_id, attempt: acceptance.attempt,
    target_sha: state.thread.head_sha,
  });
  return {
    decision: 'advance',
    reason: 'acceptance_repair',
    substate: 'repair_pending',
    nextState: commit(state, {
      phase: 'developing', substate: 'repair_pending', now, transition,
      updates: [{ id: action.id, changes: {
        status: 'committed',
        run: action.run,
        receipt: {
          status: 'available', dispatch_id: action.id,
          source_run_id: action.run.id, source_attempt: action.run.attempt,
          outcome: 'failed', evidence_generation: action.evidence_generation,
        },
      } }],
      newActions: [repairAction],
      patch: {
        feedback: bundle,
        budgets: { ...state.budgets, repair_rounds: nextRound },
      },
    }),
    intents: [intentFor(repairAction)],
  };
}

function decideWaitingMerge(state, observation, config, now) {
  if (state.pr == null) return invalid(state, 'merge phase without a PR');
  if (observation.merge != null) {
    const merge = observation.merge;
    if (merge.pr_number !== state.pr.number) {
      return invalid(state, 'merge observation for another PR');
    }
    const mergeNotify = state.outbox.find((entry) => entry.action === 'merge_notify' &&
      !['retired', 'cancelled', 'failed'].includes(entry.status));
    const acceptAction = makeAction(state, state.version + 1, {
      role: 'acceptor', action: 'accept', sha: merge.merged_sha,
      evidence_generation: state.review?.evidence_generation ?? null, gate: 'merged',
    });
    const transition = transitionFor(state, {
      kind: 'merge', outcome: 'completed',
      target_sha: merge.merged_sha,
      evidence_generation: state.review?.evidence_generation ?? null,
    });
    return {
      decision: 'advance',
      reason: 'merged_post_merge_acceptance',
      substate: 'merged_acceptance_pending',
      nextState: commit(state, {
        phase: 'post_merge_acceptance', substate: 'merged_acceptance_pending', now,
        transition,
        updates: mergeNotify == null ? [] : [{
          id: mergeNotify.id,
          changes: {
            status: 'committed',
            receipt: {
              status: 'available', dispatch_id: mergeNotify.id,
              outcome: 'merge_observed', evidence_generation: null,
            },
          },
        }],
        newActions: [acceptAction],
        patch: {
          pr: { ...state.pr, state: 'merged', merged_sha: merge.merged_sha },
          thread: { ...state.thread, merged_sha: merge.merged_sha },
        },
      }),
      intents: [intentFor(acceptAction)],
    };
  }
  if (observation.pr != null && observation.pr.state === 'closed' &&
      observation.pr.merged_sha == null) {
    return {
      decision: 'block',
      reason: 'pr_closed_without_merge',
      substate: 'blocked',
      nextState: blockState(state, 'pr_closed_without_merge', { now }),
      intents: [],
    };
  }
  return wait(state, 'await_authorized_merge', 'merge_pending');
}

function decidePostMerge(state, observation, config, now) {
  const action = activeAction(state);
  if (action == null || action.role !== 'acceptor' || action.gate !== 'merged') {
    return invalid(state, 'no active merged Acceptance action');
  }
  const acceptance = observation.acceptance;
  const matched = acceptance != null && acceptance.action_id === action.id;
  if (!matched) {
    if (acceptance != null) return stale(state, 'merged_acceptance_for_another_action');
    if (action.status === 'pending') return decidePendingDispatch(state, action, 'dispatch_merged_acceptance');
    if (action.status === 'dispatching' || action.status === 'ambiguous') {
      return wait(state, 'await_merged_acceptance', 'merged_acceptance_running');
    }
    return wait(state, 'await_merged_acceptance', 'merged_acceptance_running');
  }
  if (action.run != null && (action.run.id !== acceptance.run_id ||
      action.run.attempt !== acceptance.attempt)) {
    return stale(state, 'merged_acceptance_run_identity_changed');
  }
  if (acceptance.stage !== 'merged' ||
      acceptance.head_sha !== state.thread.merged_sha) {
    return stale(state, 'merged_acceptance_for_another_sha');
  }
  if (action.run == null) {
    return {
      decision: 'advance',
      reason: 'adopt_terminal_merged_acceptance_run',
      substate: 'merged_acceptance_result_pending',
      nextState: commit(state, {
        phase: state.phase, substate: 'merged_acceptance_result_pending', now,
        updates: [{ id: action.id, changes: {
          status: 'dispatched',
          run: { id: acceptance.run_id, attempt: acceptance.attempt, verified: true },
          attempts: action.attempts + 1,
        } }],
      }),
      intents: [],
    };
  }
  const transition = transitionFor(state, {
    kind: 'acceptance', outcome: acceptance.outcome, action,
    run_id: acceptance.run_id, attempt: acceptance.attempt,
    target_sha: state.thread.merged_sha,
  });
  if (acceptance.outcome === 'passed') {
    return {
      decision: 'advance',
      reason: 'merged_acceptance_done',
      substate: 'complete',
      nextState: commit(state, {
        phase: 'done', substate: 'complete', now, transition,
        updates: [{ id: action.id, changes: {
          status: 'committed',
          run: action.run,
          receipt: {
            status: 'available', dispatch_id: action.id,
            source_run_id: action.run.id, source_attempt: action.run.attempt,
            outcome: 'passed', evidence_generation: action.evidence_generation,
          },
        } }],
      }),
      intents: [],
    };
  }
  return {
    decision: 'block',
    reason: acceptance.outcome === 'pending' ?
      'merged_acceptance_pending' : 'merged_acceptance_failed',
    substate: 'blocked',
    nextState: blockState(state, acceptance.outcome === 'pending' ?
      'merged_acceptance_pending' : 'merged_acceptance_failed', { now, action, transition }),
    intents: [],
  };
}

function guardObservedHead(state, observation, now) {
  if (state.pr == null || observation.pr == null) return null;
  if (observation.pr.number !== state.pr.number) {
    return {
      decision: 'block',
      reason: 'unrelated_pr_observed',
      substate: 'blocked',
      nextState: blockState(state, 'unrelated_pr_observed', { now }),
      intents: [],
    };
  }
  if (observation.pr.head_sha !== state.pr.head_sha) {
    const action = activeAction(state);
    return {
      decision: 'block',
      reason: 'unauthorized_head_change',
      substate: 'blocked',
      nextState: blockState(state, 'unauthorized_head_change', {
        now, action, patch: { ci: null, review: null, feedback: null },
      }),
      intents: [],
    };
  }
  return null;
}

// A duplicate/reordered wake may re-deliver a result that was already
// committed in an earlier phase. Matching identity is an idempotent replay;
// the same Run with different evidence is a conflict and fails closed.
function globalReplay(state, obs) {
  const candidates = [];
  if (obs.developer?.status === 'completed') {
    candidates.push({
      kind: 'developer', action_id: obs.developer.action_id,
      run_id: obs.developer.run_id, attempt: obs.developer.attempt,
      target_sha: obs.developer.target_sha, outcome: obs.developer.outcome,
      evidence_generation: null,
    });
  }
  if (obs.publisher?.status === 'completed') {
    candidates.push({
      kind: 'publisher', action_id: obs.publisher.action_id,
      run_id: obs.publisher.run_id, attempt: obs.publisher.attempt,
      target_sha: obs.publisher.pr?.head_sha ?? null,
      outcome: obs.publisher.outcome, evidence_generation: null,
    });
  }
  if (obs.reviewer?.status === 'completed') {
    candidates.push({
      kind: 'reviewer', action_id: obs.reviewer.action_id,
      run_id: obs.reviewer.run_id, attempt: obs.reviewer.attempt,
      target_sha: obs.reviewer.head_sha, outcome: obs.reviewer.outcome,
      evidence_generation: obs.reviewer.evidence_generation,
    });
  }
  if (obs.acceptance != null && obs.acceptance.outcome !== 'pending') {
    candidates.push({
      kind: 'acceptance', action_id: obs.acceptance.action_id,
      run_id: obs.acceptance.run_id, attempt: obs.acceptance.attempt,
      target_sha: obs.acceptance.head_sha, outcome: obs.acceptance.outcome,
      evidence_generation: null,
    });
  }
  for (const candidate of candidates) {
    const event = { issue: state.issue, ...candidate };
    const key = transitionKey(event);
    if (state.transitions.some((transition) => transition.key === key)) {
      return { replay: true, candidate };
    }
    const sameIdentity = state.transitions.find((transition) =>
      transition.kind === candidate.kind &&
      (candidate.action_id == null || transition.action_id === candidate.action_id) &&
      (candidate.run_id == null || transition.run_id === candidate.run_id) &&
      (candidate.attempt == null || transition.attempt === candidate.attempt));
    if (sameIdentity) return { conflict: true, candidate };
  }
  return null;
}

export function decideLifecycle(state, observation, config = {}) {
  validateLifecycleState(state);
  const policy = normalizeConfig(config);
  const now = observation?.observed_at;
  const obs = normalizeObservation(observation, state);
  if (TERMINAL_PHASES.has(state.phase)) return ignore(state, 'terminal');
  if (state.phase === 'blocked') return ignore(state, 'blocked');
  const replayGuard = globalReplay(state, obs);
  if (replayGuard?.conflict) return invalid(state, 'conflicting_replay');
  if (replayGuard?.replay) return replay(state, 'result_already_committed');
  if (obs.fencing_generation != null &&
      obs.fencing_generation !== state.thread.fencing_generation) {
    // A Worker from a superseded fence generation can never publish a result,
    // checkpoint or PR effect into the live lifecycle.
    return stale(state, 'stale_fencing_generation');
  }
  if (state.phase !== 'publishing') {
    const headGuard = guardObservedHead(state, obs, now);
    if (headGuard != null) return headGuard;
    if (obs.pr?.state === 'merged' && state.phase !== 'waiting_merge' &&
        state.phase !== 'post_merge_acceptance') {
      return {
        decision: 'block',
        reason: 'out_of_band_merge',
        substate: 'blocked',
        nextState: blockState(state, 'out_of_band_merge', {
          now, action: activeAction(state),
          patch: { ci: null, review: null, feedback: null },
        }),
        intents: [],
      };
    }
  }
  switch (state.phase) {
    case 'authorized':
    case 'developing':
      return decideDeveloper(state, obs, policy, now);
    case 'publishing':
      return decidePublisher(state, obs, policy, now);
    case 'ci_checking':
      return decideCi(state, obs, policy, now);
    case 'reviewing':
      return decideReviewer(state, obs, policy, now);
    case 'evaluating':
      return decideEvaluation(state, obs, policy, now);
    case 'accepting':
      return decideAccepting(state, obs, policy, now);
    case 'waiting_merge':
      return decideWaitingMerge(state, obs, policy, now);
    case 'post_merge_acceptance':
      return decidePostMerge(state, obs, policy, now);
    default:
      return invalid(state, 'unknown business phase');
  }
}

// Apply a pure execution-state transition (Run adoption, claim observation).
// This is still a versioned CAS write; it never fabricates a business advance.
export function updateExecutionState(state, actionId, changes, now) {
  validateLifecycleState(state);
  if (!HEX64.test(actionId ?? '')) reject('invalid action ID');
  const action = state.outbox.find((entry) => entry.id === actionId);
  if (action == null) reject('unknown action');
  if (changes.status != null) {
    assertExecutionTransition(action.status, changes.status, action.role);
  }
  const next = {
    ...state,
    version: state.version + 1,
    updated_at: now,
    outbox: state.outbox.map((entry) => entry.id === actionId ?
      applyActionUpdate(entry, changes) : entry),
  };
  return validateLifecycleState(next);
}

export function cancelLifecycle(state, reason, now) {
  validateLifecycleState(state);
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500) {
    reject('invalid cancellation reason');
  }
  const active = activeAction(state);
  const updates = active == null ? [] : [{
    id: active.id,
    changes: { status: 'cancelled', receipt: { status: 'cancelled', reason: 'lifecycle_cancelled' } },
  }];
  return validateLifecycleState({
    ...state,
    version: state.version + 1,
    phase: 'cancelled',
    substate: 'cancelled',
    updated_at: now,
    cancellation: {
      reason,
      fenced_actions: active == null ? [] : [active.id],
    },
    blocker: null,
    outbox: state.outbox.map((entry) => {
      const update = updates.find((item) => item.id === entry.id);
      return update ? { ...entry, ...update.changes } : entry;
    }),
  });
}

// Owner recovery is an explicit new fence generation. The caller must also
// materialize the authorized successor action; an old observation from the
// previous generation is then rejected by `decideLifecycle`.
export function fenceGeneration(state, now, nextPhase = state.phase) {
  validateLifecycleState(state);
  return validateLifecycleState({
    ...state,
    version: state.version + 1,
    phase: nextPhase,
    substate: nextPhase === state.phase ? state.substate : 'owner_recovery',
    updated_at: now,
    blocker: nextPhase === 'blocked' ? state.blocker : null,
    thread: { ...state.thread, fencing_generation: state.thread.fencing_generation + 1 },
  });
}

export { stableDigest };
