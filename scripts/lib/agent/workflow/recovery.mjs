// Issue #4527 — generic terminal recovery for Agent Workflow V2.
//
// This module classifies an authenticated fact for one active action and
// produces a deterministic retirement/successor/block plan. It never reruns a
// model when an accepted result can be ingested, never creates a successor
// without a terminal proof, and never loses a committed native checkpoint.
import {
  actionIdFor, nextActionOrdinal, validateLifecycleState,
} from './contract.mjs';
import {
  MAX_FINDINGS,
} from './contract.mjs';

function reject(message) {
  throw new Error('agent workflow recovery: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export const RECOVERY_CLASSES = Object.freeze([
  'healthy', 'queued', 'claimed', 'executing', 'terminal_result',
  'completed_uningested', 'committed_not_advanced', 'ambiguous',
  'missing_result', 'expired_artifact', 'denied_policy',
  'terminal_failure', 'unknown',
]);

// `fact` is the authenticated fact from workflow/facts.mjs. A missing or
// unreadable fact is `unknown`; it never proves a failure or a success.
export function classifyRecovery({ state, action, fact }) {
  if (state == null || action == null) reject('state/action required');
  if (fact == null) return { class: 'unknown', reason: 'fact_unavailable' };
  if (fact.kind === 'terminal_result') return { class: 'terminal_result' };
  if (fact.kind === 'completed_uningested') {
    return { class: 'completed_uningested', reason: 'result_not_ingested' };
  }
  if (fact.kind === 'running') {
    if (fact.claimed === true) return { class: 'claimed' };
    if (fact.executing === true) return { class: 'executing' };
    return { class: 'queued' };
  }
  if (fact.kind === 'denied') {
    if (/policy|denied|forbidden|unauthor/i.test(fact.reason ?? '')) {
      return { class: 'denied_policy', reason: fact.reason };
    }
    return { class: 'unknown', reason: fact.reason ?? 'denied_fact' };
  }
  if (fact.kind === 'unavailable') {
    return { class: 'unknown', reason: fact.reason ?? 'unavailable_fact' };
  }
  if (fact.kind === 'terminal_failure') {
    if (action.run != null && fact.run != null &&
        (fact.run.id !== action.run.id ||
         fact.run.attempt !== action.run.attempt)) {
      // A fact for another Run never retires or reruns this action.
      return { class: 'ambiguous', reason: 'run_binding_mismatch' };
    }
    const code = String(fact.code ?? '');
    if (/expired|artifact.*missing|missing.*artifact/i.test(code)) {
      return { class: 'expired_artifact', category: 'infrastructure', code };
    }
    if (/missing_result|result_missing/i.test(code)) {
      return { class: 'missing_result', category: 'model', code };
    }
    if (/policy|denied|forbidden|unauthor/i.test(code)) {
      return { class: 'denied_policy', reason: code };
    }
    if (!positive(fact.run?.id) || !positive(fact.run?.attempt)) {
      return { class: 'ambiguous', reason: 'terminal_without_run_identity' };
    }
    return {
      class: 'terminal_failure',
      category: fact.category === 'infrastructure' ? 'infrastructure' : 'model',
      code: code || 'terminal_failure',
      outcome: fact.outcome ?? 'failed',
    };
  }
  if (fact.kind === 'pending_dispatch') return { class: 'queued' };
  if (state.outbox.some((entry) => entry.status === 'committed') &&
      !state.outbox.some((entry) => ['pending', 'dispatching', 'dispatched',
        'claimed', 'executing', 'result_available', 'ambiguous']
        .includes(entry.status))) {
    return { class: 'committed_not_advanced' };
  }
  return { class: 'unknown', reason: 'unclassified_fact' };
}

function budgetFor(state, category, config) {
  if (!['infrastructure', 'model'].includes(category)) reject('invalid retry category');
  const key = category === 'infrastructure' ? 'infrastructure_retries' : 'model_retries';
  const max = category === 'infrastructure' ?
    config.max_infrastructure_retries : config.max_model_retries;
  const next = state.budgets[key] + 1;
  return {
    key, next, exhausted: next > max,
    budget: { ...state.budgets, [key]: next },
  };
}

function successorAction(state, action, { role, action: name, sha, predecessor }) {
  const ordinal = nextActionOrdinal(state, role, name);
  const id = actionIdFor({
    issue: state.issue, thread_id: state.thread.id, role, action: name,
    sha, ordinal, predecessor: predecessor.id,
  });
  return {
    id,
    role,
    action: name,
    sha,
    evidence_generation: predecessor.evidence_generation ?? null,
    agent_id: role === 'publisher' ? 'trusted-publisher' : state.assignments[role],
    feedback_sha256: predecessor.feedback_sha256 ?? null,
    resume: true,
    gate: predecessor.gate ?? null,
    status: 'pending',
    attempts: 0,
    run: null,
    receipt: null,
    predecessor: predecessor.id,
    created_version: state.version + 1,
  };
}

// Plan a generic terminal recovery. The plan is pure data; applying it is a
// separate CAS write owned by Reconcile.
export function planTerminalRecovery({
  state, action, fact, config = {},
}) {
  validateLifecycleState(state);
  if (action == null || action.id == null) reject('active action required');
  const current = state.outbox.find((entry) => entry.id === action.id);
  if (current == null) reject('action is not in the state');
  const classification = classifyRecovery({ state, action: current, fact });
  const maxInfra = Number.isSafeInteger(config.max_infrastructure_retries) ?
    config.max_infrastructure_retries : 3;
  const maxModel = Number.isSafeInteger(config.max_model_retries) ?
    config.max_model_retries : 3;
  const policy = { max_infrastructure_retries: maxInfra, max_model_retries: maxModel };
  if (classification.class === 'terminal_result' ||
      classification.class === 'healthy' ||
      classification.class === 'queued' ||
      classification.class === 'claimed' ||
      classification.class === 'executing') {
    return { action: 'wait', class: classification.class };
  }
  if (classification.class === 'completed_uningested') {
    if (!positive(fact.run?.id) || !positive(fact.run?.attempt)) {
      return { action: 'block', class: classification.class, reason: 'missing_run_identity' };
    }
    return {
      action: 'reingest', class: classification.class,
      run_id: fact.run.id, attempt: fact.run.attempt,
    };
  }
  if (classification.class === 'committed_not_advanced') {
    return { action: 'reconstruct', class: classification.class };
  }
  if (classification.class === 'ambiguous') {
    return { action: 'block', class: classification.class, reason: 'ambiguous_effect' };
  }
  if (classification.class === 'denied_policy') {
    return { action: 'block', class: classification.class, reason: 'policy_denied' };
  }
  if (classification.class === 'unknown') {
    return { action: 'block', class: classification.class, reason: 'unknown_evidence' };
  }
  // A terminal action is already retired; do not create a second successor.
  if (['failed', 'committed', 'retired', 'cancelled', 'yielded'].includes(current.status)) {
    return { action: 'none', class: classification.class, reason: 'action_already_terminal' };
  }
  if (!positive(fact.run?.id) || !positive(fact.run?.attempt)) {
    // A failure without a verified Run identity is ambiguous, not a terminal
    // proof. Never retire or rerun on it.
    return { action: 'block', class: classification.class, reason: 'missing_run_identity' };
  }
  const category = classification.category === 'infrastructure' ?
    'infrastructure' : 'model';
  const failureCode = classification.code ??
    (classification.class === 'expired_artifact' ? 'artifact_expired' : 'terminal_failure');
  if (classification.class === 'missing_result' &&
      fact.checkpoint_incompatible === true) {
    return { action: 'block', class: classification.class, reason: 'checkpoint_incompatible' };
  }
  if (fact.checkpoint_corrupt === true) {
    return { action: 'block', class: classification.class, reason: 'checkpoint_corrupt' };
  }
  const budget = budgetFor(state, category, policy);
  if (budget.exhausted) {
    return {
      action: 'block', class: classification.class,
      reason: category + '_budget_exhausted', budget: budget.budget,
    };
  }
  const checkpoint = fact.checkpoint ?? state.thread.checkpoint ?? null;
  // A committed checkpoint must be preserved. The successor carries the same
  // logical Thread and the same native checkpoint identity.
  const successor = successorAction(state, current, {
    role: current.role, action: current.action, sha: current.sha,
    predecessor: current,
  });
  return {
    action: 'retire_successor',
    class: classification.class,
    category,
    failure_code: failureCode,
    outcome: classification.outcome ?? 'failed',
    retirement: {
      status: 'failed', dispatch_id: current.id,
      source_run_id: fact.run.id, source_attempt: fact.run.attempt,
      failure_code: failureCode, category,
    },
    successor,
    checkpoint,
    budget: budget.budget,
    next_phase: current.role === 'reviewer' ? 'reviewing' : 'developing',
  };
}

export function applyTerminalRecovery(state, plan, now = Date.now()) {
  validateLifecycleState(state);
  if (plan == null || typeof plan.action !== 'string') reject('invalid recovery plan');
  if (!positive(now)) reject('invalid clock');
  if (plan.action === 'wait' || plan.action === 'reingest' ||
      plan.action === 'reconstruct' || plan.action === 'none') {
    return null;
  }
  if (plan.action === 'block') {
    const action = state.outbox.find((entry) => entry.status !== 'retired' &&
      entry.status !== 'failed' && entry.status !== 'cancelled' &&
      entry.status !== 'yielded' && entry.status !== 'committed');
    const updates = action == null ? [] : [{
      id: action.id,
      changes: {
        status: 'cancelled',
        receipt: { status: 'cancelled', reason: 'recovery_block' },
      },
    }];
    const blocked = {
      ...state,
      version: state.version + 1,
      phase: 'blocked',
      substate: 'blocked',
      updated_at: now,
      blocker: {
        reason: String(plan.reason ?? 'recovery_blocked').slice(0, 500),
        evidence_ref: null,
        owner_action_required: true,
      },
      budgets: plan.budget ?? state.budgets,
      outbox: state.outbox.map((entry) => {
        const update = updates.find((item) => item.id === entry.id);
        return update ? { ...entry, ...update.changes } : entry;
      }),
    };
    return validateLifecycleState(blocked);
  }
  if (plan.action !== 'retire_successor') reject('unknown recovery plan action');
  const action = state.outbox.find((entry) => entry.id === plan.retirement.dispatch_id);
  if (action == null) reject('recovery target action missing');
  if (['failed', 'committed', 'retired', 'cancelled', 'yielded'].includes(action.status)) {
    return null;
  }
  const successor = plan.successor;
  if (successor == null || successor.predecessor !== action.id ||
      successor.created_version !== state.version + 1 ||
      successor.status !== 'pending') reject('invalid recovery successor');
  const next = {
    ...state,
    version: state.version + 1,
    phase: plan.next_phase,
    substate: 'recovery_pending',
    updated_at: now,
    budgets: plan.budget ?? state.budgets,
    outbox: [
      ...state.outbox.map((entry) => entry.id === action.id ? {
        ...entry,
        status: 'failed',
        run: { id: plan.retirement.source_run_id,
          attempt: plan.retirement.source_attempt, verified: true },
        receipt: plan.retirement,
      } : entry),
      successor,
    ],
    thread: {
      ...state.thread,
      attempt: state.thread.attempt + 1,
      checkpoint: plan.checkpoint ?? state.thread.checkpoint,
    },
  };
  return validateLifecycleState(next);
}

export { MAX_FINDINGS, nonNegative };
