// Issue #4525 — safe exported diagnostic projection.
//
// Reconcile's private plan contains full next states, including checkpoint
// bindings and feedback details. That object never leaves the trusted process.
// The exported artifact/log is built from an explicit whitelist only.
import { validateLifecycleState } from './contract.mjs';

const TOKEN = /^[a-z0-9_]{1,80}$/;
const PHASE = /^[a-z][a-z0-9_-]{1,80}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_STEPS = 32;
const MAX_BYTES = 16 * 1024;
const SENSITIVE = /native_bytes|native_session_id|transcript|prompt|private_key|access_token|secret|credential|plaintext|checkpoint_path|outbox|transitions|nextState/i;

function fail(message) {
  throw new Error('agent workflow diagnostic: ' + message);
}
function token(value, label) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('invalid ' + label);
  return value;
}
function optionalToken(value, label) {
  return value == null ? null : token(value, label);
}
function phaseToken(value, label) {
  if (typeof value !== 'string' || !PHASE.test(value)) fail('invalid ' + label);
  return value;
}
function nonNegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid ' + label);
  return value;
}

function safeSteps(steps) {
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) fail('invalid steps');
  return steps.map((step) => ({
    decision: token(step?.decision, 'step decision'),
    reason: optionalToken(step?.reason, 'step reason'),
  }));
}

function planProjection(plan) {
  if (plan == null) return null;
  if (plan.schema_version !== 2) return null;
  validateLifecycleState(plan);
  const active = plan.outbox.filter((action) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(action.status));
  return {
    next_phase: phaseToken(plan.phase, 'plan phase'),
    next_substate: plan.substate == null ? null : token(plan.substate, 'plan substate'),
    next_actions: active.slice(0, 8).map((action) => ({
      role: action.role == null ? null : token(action.role, 'action role'),
      action: token(action.action, 'action name'),
      status: token(action.status, 'action status'),
    })),
  };
}

function safeMigration(record) {
  if (record == null) return null;
  return {
    from_schema_version: 1,
    from_version: record.from_version,
    from_digest: record.from_digest,
    from_phase: phaseToken(record.from_phase, 'migration from phase'),
    mapped_phase: phaseToken(record.mapped_phase, 'migration mapped phase'),
    legacy_order: record.legacy_order,
  };
}

export function projectReconcileDiagnostic({ summary, state }) {
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('invalid reconcile summary');
  }
  if (summary.kind !== 'agent_workflow_v2_reconcile_result') {
    fail('invalid reconcile result kind');
  }
  if (!Number.isSafeInteger(summary.issue) || summary.issue < 1) {
    fail('invalid reconcile Issue');
  }
  if (summary.store_version != null &&
      (!Number.isSafeInteger(summary.store_version) || summary.store_version < 0)) {
    fail('invalid Store version');
  }
  const wake = summary.wake ?? {};
  const diagnostic = {
    schema_version: 1,
    kind: 'agent_workflow_v2_diagnostic',
    issue: summary.issue,
    wake: {
      source: token(wake.source, 'wake source'),
      reason: token(wake.reason, 'wake reason'),
    },
    decision: token(summary.decision, 'decision'),
    reason: optionalToken(summary.reason, 'reason'),
    store_version: summary.store_version ?? null,
    migrated: summary.migrated === true,
    exhausted: summary.exhausted === true,
    steps: safeSteps(summary.steps ?? []),
    pending_intents: Array.isArray(summary.pending_intents) ?
      summary.pending_intents.slice(0, 8).map((intent) => token(intent, 'intent type')) : [],
  };
  if (state != null) {
    if (state.schema_version === 2) {
      validateLifecycleState(state);
      diagnostic.phase = phaseToken(state.phase, 'phase');
      diagnostic.substate = state.substate == null ? null : token(state.substate, 'substate');
      diagnostic.blocked_reason = state.blocker == null ? null :
        token(state.blocker.reason, 'blocked reason');
      diagnostic.migration = safeMigration(state.migration);
      diagnostic.counts = {
        pending_actions: state.outbox.filter((action) =>
          !['retired', 'failed', 'cancelled', 'yielded', 'committed']
            .includes(action.status)).length,
        unresolved_dispatch: state.outbox.filter((action) =>
          ['dispatching', 'ambiguous'].includes(action.status)).length,
        repair_rounds: state.budgets.repair_rounds,
        feedback_findings: state.feedback?.finding_ids.length ?? 0,
      };
      diagnostic.plan = planProjection(summary.plan);
    } else if (state.schema_version === 1) {
      diagnostic.phase = phaseToken(state.phase, 'legacy phase');
      diagnostic.legacy = {
        schema_version: 1,
        version: state.version,
        phase: phaseToken(state.phase, 'legacy phase'),
      };
      diagnostic.migration = safeMigration(summary.plan?.migration ?? null);
      diagnostic.plan = planProjection(summary.plan);
    } else {
      fail('unsupported state schema');
    }
  }
  if (diagnostic.phase == null) {
    diagnostic.phase = summary.phase == null ? null : phaseToken(summary.phase, 'summary phase');
  }
  const serialized = JSON.stringify(diagnostic);
  if (SENSITIVE.test(serialized)) fail('diagnostic contains private material');
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail('diagnostic exceeds bound');
  return Object.freeze(diagnostic);
}

// Whole-payload check for callers that assemble a batch. It rejects raw state
// shapes, native/private keys and oversized/free-text values anywhere in the
// exported document.
export function assertSafeDiagnosticPayload(value) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 8) fail('diagnostic nesting exceeds bound');
    if (node == null) return;
    if (typeof node === 'string') {
      if (node.length > 400) fail('diagnostic string exceeds bound');
      if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(node)) {
        fail('diagnostic string contains control characters');
      }
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return;
    if (typeof node !== 'object') fail('unsupported diagnostic value');
    if (seen.has(node)) fail('diagnostic contains a cycle');
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > 64) fail('diagnostic array exceeds bound');
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (SENSITIVE.test(key) || ['native_bytes', 'native_session_id',
        'prompt', 'transcript', 'checkpoint_path', 'outbox', 'transitions']
        .includes(key)) {
        fail('diagnostic exposes a private/raw state key');
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
    fail('diagnostic payload exceeds bound');
  }
  return value;
}

export { HEX40, HEX64 };
