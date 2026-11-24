// Issue #4482 SC-07 — sanitized Reconcile observation projection.
//
// This is a bounded, explicitly selected projection of the durable lifecycle
// state. It never copies prompts, native session bytes, checkpoints, tokens or
// credentials; source Run/Attempt and exact SHA correlation stay in the
// immutable Store receipts and the transition log.
import { validateLifecycleState } from './contract.mjs';

const MAX_STEPS = 32;
const TOKEN = /^[a-z0-9_]{1,80}$/;

function fail(message) {
  throw new Error('agent workflow telemetry: ' + message);
}
function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function token(value, label) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('invalid ' + label);
  return value;
}

function sanitizeStep(step) {
  if (step == null || typeof step !== 'object' || Array.isArray(step)) {
    fail('invalid reconcile step');
  }
  const decision = token(step.decision, 'step decision');
  const reason = step.reason == null ? null : token(step.reason, 'step reason');
  return { decision, reason };
}

export function buildReconcileTelemetry({ summary, state, now = Date.now() }) {
  validateLifecycleState(state);
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('invalid reconcile summary');
  }
  if (summary.kind !== 'agent_workflow_v2_reconcile_result' ||
      summary.issue !== state.issue) {
    fail('reconcile summary does not belong to this Issue');
  }
  if (!Number.isSafeInteger(now) || now < 1) fail('invalid clock');
  if (!Array.isArray(summary.steps) || summary.steps.length > MAX_STEPS) {
    fail('invalid reconcile steps');
  }
  const wake = summary.wake ?? {};
  const record = {
    schema_version: 1,
    kind: 'agent_workflow_reconcile_observation',
    issue: summary.issue,
    wake: {
      source: token(wake.source, 'wake source'),
      reason: token(wake.reason, 'wake reason'),
    },
    phase: token(state.phase, 'phase'),
    substate: state.substate == null ? null : token(state.substate, 'substate'),
    decision: token(summary.decision, 'decision'),
    reason: summary.reason == null ? null : token(summary.reason, 'reason'),
    store_version: summary.store_version ?? state.version,
    migrated: summary.migrated === true,
    exhausted: summary.exhausted === true,
    steps: summary.steps.map(sanitizeStep),
    pending_actions: state.outbox.filter((action) =>
      !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(action.status)).length,
    unresolved_dispatch: state.outbox.filter((action) =>
      ['dispatching', 'ambiguous'].includes(action.status)).length,
    retry_budget: {
      infrastructure: state.budgets.infrastructure_retries,
      model: state.budgets.model_retries,
      repair_rounds: state.budgets.repair_rounds,
    },
    stage_age_ms: Math.max(0, now - state.updated_at),
    repair_round: state.budgets.repair_rounds,
    first_pass: state.budgets.repair_rounds === 0,
    checkpoint: state.thread.checkpoint == null ? null : {
      version: state.thread.checkpoint.version,
      session_bound: typeof state.thread.checkpoint.native_session_id === 'string',
    },
    feedback_finding_count: state.feedback?.finding_ids.length ?? 0,
    stale_results: summary.steps.filter((step) =>
      step.decision === 'stale' || step.decision === 'stale_observation').length,
    ingest_failures: summary.steps.filter((step) =>
      step.decision === 'recover' && /ingest/.test(step.reason ?? '')).length,
  };
  if (!nonNegative(record.store_version) || !nonNegative(record.stage_age_ms)) {
    fail('invalid reconcile version/age');
  }
  const serialized = JSON.stringify(record);
  if (/native_bytes|transcript|plaintext|private_key|access_token|secret|credential/i
    .test(serialized)) {
    fail('published reconcile telemetry contains private material');
  }
  if (Buffer.byteLength(serialized) > 16 * 1024) fail('reconcile telemetry exceeds bound');
  return record;
}

export function validateReconcileTelemetry(record) {
  if (record?.schema_version !== 1 ||
      record?.kind !== 'agent_workflow_reconcile_observation') {
    fail('invalid reconcile telemetry schema');
  }
  token(record.phase, 'phase');
  token(record.decision, 'decision');
  token(record.wake?.source, 'wake source');
  token(record.wake?.reason, 'wake reason');
  if (!nonNegative(record.store_version) || !nonNegative(record.stage_age_ms)) {
    fail('invalid reconcile version/age');
  }
  return record;
}
