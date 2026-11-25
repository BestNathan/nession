// Issue #4482 — the single bounded Reconcile loop.
//
// Every wake source funnels through the same `reconcileOnce` decision path.
// Reconcile observes authenticated facts, asks the canonical lifecycle owner
// for an eligible decision, persists it with expected-version CAS, executes
// only the committed scoped effect, reads the effect back and commits a
// verified receipt. No model runs in this module and it holds no model
// credentials. External effects are never blindly repeated.
import {
  DEFAULT_CONFIG, WAKE_SOURCES, activeAction, transitionKey, validateLifecycleState,
} from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import { migrateV1State } from './migration.mjs';

function reject(message) {
  throw new Error('agent workflow reconcile: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function normalizeWake(wake) {
  if (wake == null || typeof wake !== 'object' || Array.isArray(wake) ||
      Object.keys(wake).some((key) => !['source', 'reason', 'correlation_id', 'issues']
        .includes(key)) ||
      !WAKE_SOURCES.includes(wake.source) ||
      typeof wake.reason !== 'string' || wake.reason.length < 1 || wake.reason.length > 200 ||
      (wake.correlation_id != null && typeof wake.correlation_id !== 'string') ||
      (wake.issues != null && (!Array.isArray(wake.issues) ||
        wake.issues.some((issue) => !positive(issue))))) {
    reject('invalid wake');
  }
  return {
    source: wake.source,
    reason: wake.reason,
    correlation_id: wake.correlation_id ?? null,
    issues: wake.issues ?? [],
  };
}

// All three wake paths select identical decision logic. The wake can hint at
// Issues and carry a reason/correlation id; it cannot choose a role, approve a
// result or authorize a start.
export function normalizeReconcileWake(wake) {
  return normalizeWake(wake);
}

function requirePorts(ports) {
  if (ports == null || typeof ports !== 'object' || Array.isArray(ports) ||
      Object.keys(ports).some((key) => !['store', 'observer', 'effects'].includes(key)) ||
      ports.store == null || ports.observer == null) {
    reject('invalid reconcile ports');
  }
  for (const fn of ['load', 'cas']) {
    if (typeof ports.store[fn] !== 'function') reject('store port requires ' + fn);
  }
  if (typeof ports.observer.observe !== 'function') reject('observer port requires observe');
  if (ports.effects != null &&
      typeof ports.effects !== 'object') reject('invalid effects port');
}

function preparedReceipt(action, prepared, now) {
  if (prepared == null || typeof prepared !== 'object' ||
      !positive(prepared.issuer_run_id) || !/^[a-f0-9]{64}$/.test(prepared.ticket_sha256 ?? '')) {
    reject('invalid prepared dispatch intent');
  }
  return {
    status: 'prepared',
    dispatch_id: action.id,
    issuer_run_id: prepared.issuer_run_id,
    ticket_sha256: prepared.ticket_sha256,
  };
}

function runBinding(result) {
  if (!positive(result?.run_id) || !positive(result?.attempt)) return null;
  return { id: result.run_id, attempt: result.attempt, verified: true };
}

async function executeDispatch({ state, intent, effects, store, now }) {
  const action = state.outbox.find((entry) => entry.id === intent.action_id);
  if (action == null) reject('intent has no committed action');
  if (action.status === 'dispatching' || action.status === 'ambiguous') {
    // A prior attempt may have reached GitHub even if its response was lost.
    // Read the deterministic Run binding first; never send a second POST until
    // the original effect is proven absent by the trusted reader.
    const readback = effects.readbackDispatch == null ? null :
      await effects.readbackDispatch({ state, action });
    if (readback?.status === 'found' && runBinding(readback) != null) {
      const next = updateExecutionState(state, action.id, {
        status: 'dispatched', run: runBinding(readback),
      }, now);
      const written = await store.cas(next, state.version);
      return written?.conflict ? state : next;
    }
    return state;
  }
  if (action.status !== 'pending') return state;
  if (typeof effects.prepareDispatch !== 'function' ||
      typeof effects.dispatch !== 'function') {
    reject('effects port requires prepareDispatch/dispatch');
  }
  const prepared = await effects.prepareDispatch({ state, action });
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: preparedReceipt(action, prepared, now),
    attempts: action.attempts + 1,
  }, now);
  // The write-ahead intent must be durable BEFORE the external POST. A CAS
  // conflict aborts this attempt and the loop re-observes instead of sending.
  const intentWritten = await store.cas(dispatching, state.version);
  if (intentWritten?.conflict) return state;
  let current = dispatching;
  const result = await effects.dispatch({ state: current, action, prepared });
  if (result?.status === 'accepted' && runBinding(result) != null) {
    current = updateExecutionState(current, action.id, {
      status: 'dispatched', run: runBinding(result),
    }, now);
  } else if (result?.status === 'failed' && runBinding(result) != null) {
    current = updateExecutionState(current, action.id, {
      status: 'failed',
      run: runBinding(result),
      receipt: {
        status: 'failed', dispatch_id: action.id,
        source_run_id: result.run_id, source_attempt: result.attempt,
        failure_code: result.failure?.code ?? 'dispatch_failed',
        category: result.failure?.category ?? 'infrastructure',
      },
    }, now);
  } else {
    // No authenticated Run identity: the external effect is ambiguous, never
    // reported as a proven failure or retried blindly.
    current = updateExecutionState(current, action.id, { status: 'ambiguous' }, now);
  }
  await store.cas(current, dispatching.version);
  return current;
}

async function executePublish({ state, intent, effects, store, now }) {
  const action = state.outbox.find((entry) => entry.id === intent.action_id);
  if (action == null) reject('intent has no committed action');
  if (action.status === 'dispatching' || action.status === 'ambiguous') {
    const readback = effects.readbackPublish == null ? null :
      await effects.readbackPublish({ state, action });
    if (readback?.status === 'found' && runBinding(readback) != null &&
        readback.pr != null) {
      const next = updateExecutionState(state, action.id, {
        status: 'dispatched', run: runBinding(readback),
      }, now);
      const written = await store.cas(next, state.version);
      return written?.conflict ? state : next;
    }
    return state;
  }
  if (action.status !== 'pending') return state;
  if (typeof effects.preparePublish !== 'function' ||
      typeof effects.publish !== 'function') {
    reject('effects port requires preparePublish/publish');
  }
  const prepared = await effects.preparePublish({ state, action });
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: preparedReceipt(action, prepared, now),
    attempts: action.attempts + 1,
  }, now);
  const intentWritten = await store.cas(dispatching, state.version);
  if (intentWritten?.conflict) return state;
  let current = dispatching;
  const result = await effects.publish({ state: current, action, prepared });
  if (result?.status === 'accepted' && runBinding(result) != null) {
    current = updateExecutionState(current, action.id, {
      status: 'dispatched', run: runBinding(result),
    }, now);
  } else if (result?.status === 'failed' && runBinding(result) != null) {
    current = updateExecutionState(current, action.id, {
      status: 'failed',
      run: runBinding(result),
      receipt: {
        status: 'failed', dispatch_id: action.id,
        source_run_id: result.run_id, source_attempt: result.attempt,
        failure_code: result.failure?.code ?? 'publish_failed',
        category: result.failure?.category ?? 'infrastructure',
      },
    }, now);
  } else {
    current = updateExecutionState(current, action.id, { status: 'ambiguous' }, now);
  }
  await store.cas(current, dispatching.version);
  return current;
}

async function executeAccept({ state, intent, effects, store, now }) {
  const action = state.outbox.find((entry) => entry.id === intent.action_id);
  if (action == null) reject('intent has no committed action');
  if (action.status === 'dispatching' || action.status === 'ambiguous') {
    const readback = effects.readbackAccept == null ? null :
      await effects.readbackAccept({ state, action });
    if (readback?.status === 'found' && runBinding(readback) != null) {
      const next = updateExecutionState(state, action.id, {
        status: 'dispatched', run: runBinding(readback),
      }, now);
      const written = await store.cas(next, state.version);
      return written?.conflict ? state : next;
    }
    return state;
  }
  if (action.status !== 'pending') return state;
  if (typeof effects.prepareAccept !== 'function' ||
      typeof effects.accept !== 'function') {
    reject('effects port requires prepareAccept/accept');
  }
  const prepared = await effects.prepareAccept({ state, action });
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: preparedReceipt(action, prepared, now),
    attempts: action.attempts + 1,
  }, now);
  const intentWritten = await store.cas(dispatching, state.version);
  if (intentWritten?.conflict) return state;
  const result = await effects.accept({ state: dispatching, action, prepared });
  const current = runBinding(result) == null ?
    updateExecutionState(dispatching, action.id, { status: 'ambiguous' }, now) :
    updateExecutionState(dispatching, action.id, {
      status: 'dispatched', run: runBinding(result),
    }, now);
  await store.cas(current, dispatching.version);
  return current;
}

async function executeNotify({ state, intent, store, now }) {
  const action = state.outbox.find((entry) => entry.id === intent.action_id);
  if (action == null) reject('intent has no committed action');
  if (action.status !== 'pending') return state;
  const next = updateExecutionState(state, action.id, {
    status: 'committed',
    receipt: {
      status: 'available', dispatch_id: action.id,
      outcome: intent.action, evidence_generation: null,
    },
  }, now);
  const written = await store.cas(next, state.version);
  return written?.conflict ? state : next;
}

function ciRetryMarker(state, action) {
  return state.transitions.some((transition) =>
    transition.kind === 'ci_retry' && transition.action_id === action.id);
}

// The retry intent must be durable BEFORE the external rerun request. The
// action itself is created by the lifecycle decision; this transition records
// that the executor is about to cross the external-effect boundary. A later
// wake that sees the marker must read back, never blindly re-request.
async function writeCiRetryMarker({ state, action, store, now }) {
  const event = {
    kind: 'ci_retry', outcome: 'requested',
    action_id: action.id, run_id: null, attempt: null,
    target_sha: action.sha, evidence_generation: action.evidence_generation,
  };
  const next = validateLifecycleState({
    ...state,
    version: state.version + 1,
    updated_at: now,
    transitions: [...state.transitions, {
      ...event, key: transitionKey({ issue: state.issue, ...event }),
      recorded_version: state.version + 1,
    }],
  });
  const written = await store.cas(next, state.version);
  return written?.conflict ? null : next;
}

function ciRetryCancelled(state, action, reason, now) {
  return updateExecutionState(state, action.id, {
    status: 'cancelled', receipt: { status: 'cancelled', reason },
  }, now);
}

async function finishCiRetry({ state, action, result, store, now }) {
  let next;
  if (result?.status === 'accepted' && runBinding(result) != null) {
    next = updateExecutionState(state, action.id, {
      status: 'committed',
      run: runBinding(result),
      receipt: {
        status: 'available', dispatch_id: action.id,
        outcome: 'ci_retry_requested',
        evidence_generation: action.evidence_generation,
      },
    }, now);
  } else if (result?.status === 'failed') {
    const code = typeof result.failure?.code === 'string' && result.failure.code.length > 0 ?
      result.failure.code.slice(0, 200) : 'ci_retry_failed';
    next = ciRetryCancelled(state, action, code, now);
  } else {
    // The response is uncertain and no verified rerun identity is available.
    // Keep the durable pending action (and its marker); a later reconcile must
    // read back instead of issuing a duplicate external request.
    return state;
  }
  const written = await store.cas(next, state.version);
  return written?.conflict ? state : next;
}

async function completeCiRetry({ state, action, effects, store, now }) {
  if (action.status !== 'pending') return state;
  if (action.action !== 'ci_retry' || action.role != null) reject('invalid CI retry action');
  if (action.sha !== state.thread.head_sha) {
    // A stale-head retry is never sent. Cancel it so the next decision can
    // collect the new HEAD's obligation without an active-action conflict.
    const next = ciRetryCancelled(state, action, 'ci_retry_stale_head', now);
    const written = await store.cas(next, state.version);
    return written?.conflict ? state : next;
  }
  let current = state;
  let justMarked = false;
  if (!ciRetryMarker(current, action)) {
    current = await writeCiRetryMarker({ state: current, action, store, now });
    if (current == null) return state;
    justMarked = true;
  }
  let result = null;
  if (!justMarked) {
    // A prior attempt may have reached GitHub even if its response was lost.
    if (typeof effects.readbackCiRetry !== 'function') return current;
    const readback = await effects.readbackCiRetry({ state: current, action });
    if (readback?.status === 'found' && runBinding(readback) != null) {
      result = { status: 'accepted', run_id: readback.run_id, attempt: readback.attempt };
    } else if (readback?.status !== 'absent') {
      // Unknown effect: block until verified, never re-request.
      return current;
    }
  }
  if (result == null) {
    if (typeof effects.retryCi !== 'function') reject('effects port requires retryCi');
    result = await effects.retryCi({ state: current, action });
  }
  return finishCiRetry({ state: current, action, result, store, now });
}

// A pending retry may need readback even when the lifecycle has no new intent.
async function resumeCiRetry({ state, ports, now }) {
  const action = activeAction(state);
  if (action == null || action.action !== 'ci_retry') return state;
  return completeCiRetry({
    state, action, effects: ports.effects, store: ports.store, now,
  });
}

// A dispatching/ambiguous action may already have a real external effect whose
// response was lost. The trusted reader is consulted before any new POST.
async function recoverAmbiguousAction({ state, ports, now }) {
  const action = activeAction(state);
  if (action == null || !['dispatching', 'ambiguous'].includes(action.status)) return state;
  if (action.role === 'publisher') {
    if (typeof ports.effects.readbackPublish !== 'function') return state;
    const readback = await ports.effects.readbackPublish({ state, action });
    if (readback?.status !== 'found' || runBinding(readback) == null) return state;
    const next = updateExecutionState(state, action.id, {
      status: 'dispatched', run: runBinding(readback),
    }, now);
    const written = await ports.store.cas(next, state.version);
    return written?.conflict ? state : next;
  }
  if (action.role === 'acceptor') {
    if (typeof ports.effects.readbackAccept !== 'function') return state;
    const readback = await ports.effects.readbackAccept({ state, action });
    if (readback?.status !== 'found' || runBinding(readback) == null) return state;
    const next = updateExecutionState(state, action.id, {
      status: 'dispatched', run: runBinding(readback),
    }, now);
    const written = await ports.store.cas(next, state.version);
    return written?.conflict ? state : next;
  }
  if (action.role === 'developer' || action.role === 'reviewer') {
    if (typeof ports.effects.readbackDispatch !== 'function') return state;
    const readback = await ports.effects.readbackDispatch({ state, action });
    if (readback?.status !== 'found' || runBinding(readback) == null) return state;
    const next = updateExecutionState(state, action.id, {
      status: 'dispatched', run: runBinding(readback),
    }, now);
    const written = await ports.store.cas(next, state.version);
    return written?.conflict ? state : next;
  }
  return state;
}

async function executeIntent({ state, intent, ports, now }) {
  switch (intent.type) {
    case 'dispatch':
      return executeDispatch({ state, intent, effects: ports.effects, store: ports.store, now });
    case 'publish':
      return executePublish({ state, intent, effects: ports.effects, store: ports.store, now });
    case 'accept':
      return executeAccept({ state, intent, effects: ports.effects, store: ports.store, now });
    case 'notify':
      return executeNotify({ state, intent, store: ports.store, now });
    case 'retry_ci': {
      const action = state.outbox.find((entry) => entry.id === intent.action_id);
      if (action == null) reject('retry intent has no committed action');
      return completeCiRetry({
        state, action, effects: ports.effects, store: ports.store, now,
      });
    }
    case 'reingest':
      if (typeof ports.effects.reingest !== 'function') {
        reject('effects port requires reingest');
      }
      await ports.effects.reingest({ state, intent });
      return state;
    default:
      reject('unknown intent type');
  }
}

export async function reconcileOnce({
  issue, wake, ports, config = {}, now = Date.now(), maxSteps = null, apply = true,
}) {
  if (!positive(issue) || !positive(now)) reject('invalid Issue/clock');
  requirePorts(ports);
  const normalizedWake = normalizeWake(wake);
  const policy = { ...DEFAULT_CONFIG, ...config };
  const budget = maxSteps ?? policy.max_steps;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 32) reject('invalid step budget');
  const summary = {
    schema_version: 1,
    kind: 'agent_workflow_v2_reconcile_result',
    issue,
    wake: { source: normalizedWake.source, reason: normalizedWake.reason },
    steps: [],
    store_version: null,
    phase: null,
    decision: 'ignore',
    migrated: false,
    exhausted: false,
  };
  for (let step = 0; step < budget; step++) {
    const loaded = await ports.store.load(issue);
    if (loaded == null || loaded.state == null) {
      summary.decision = 'ignore';
      summary.reason = 'no_active_lifecycle';
      return summary;
    }
    let state = loaded.state;
    let version = loaded.version;
    if (state.schema_version === 1) {
      const legacyPr = ports.observer.legacyPr == null ? null :
        await ports.observer.legacyPr({ issue, state });
      const migrated = migrateV1State({ state, pr: legacyPr, now });
      const next = validateLifecycleState({
        ...migrated,
        version: loaded.version + 1,
        updated_at: now,
      });
      if (!apply) {
        summary.decision = 'plan';
        summary.reason = 'legacy_migration_required';
        summary.migrated = true;
        summary.plan = next;
        summary.store_version = loaded.version;
        summary.phase = state.phase;
        return summary;
      }
      const written = await ports.store.cas(next, loaded.version);
      if (written?.conflict) continue;
      state = next;
      version = written?.version ?? next.version;
      summary.migrated = true;
    }
    let observation;
    try {
      observation = await ports.observer.observe({ issue, state, wake: normalizedWake });
    } catch {
      // API unavailable / permission unknown is not a failure or a pass.
      summary.decision = 'recover';
      summary.reason = 'observation_unavailable';
      summary.store_version = version;
      summary.phase = state.phase;
      return summary;
    }
    if (observation == null) {
      summary.decision = 'wait';
      summary.reason = 'no_observation';
      summary.store_version = version;
      summary.phase = state.phase;
      return summary;
    }
    if (observation.state_version != null && observation.state_version !== state.version) {
      // The observation is bound to another state version: re-observe after the
      // competing write instead of applying stale facts.
      summary.steps.push({ decision: 'stale_observation', reason: 'reload_and_reobserve' });
      continue;
    }
    const decision = decideLifecycle(state, {
      ...observation,
      state_version: observation.state_version ?? state.version,
    }, policy);
    summary.steps.push({ decision: decision.decision, reason: decision.reason });
    if (decision.nextState != null && !apply) {
      summary.decision = 'plan';
      summary.reason = decision.reason;
      summary.plan = decision.nextState;
      summary.pending_intents = decision.intents.map((intent) => intent.type);
      summary.store_version = version;
      summary.phase = state.phase;
      return summary;
    }
    if (decision.nextState != null) {
      const written = await ports.store.cas(decision.nextState, state.version);
      if (written?.conflict) {
        // Never reuse a stale side-effect plan: reload and re-observe.
        summary.steps.push({ decision: 'cas_conflict', reason: 'reload_and_reobserve' });
        continue;
      }
      state = decision.nextState;
      version = written?.version ?? state.version;
      summary.decision = decision.decision;
      summary.reason = decision.reason;
    } else {
      summary.decision = decision.decision;
      summary.reason = decision.reason;
    }
    if (decision.nextState == null && decision.intents.length === 0) {
      if (apply && ports.effects != null) {
        const resumed = await resumeCiRetry({ state, ports, now });
        if (resumed !== state) {
          state = resumed;
          version = state.version;
          summary.store_version = version;
          summary.phase = state.phase;
          continue;
        }
        const recovered = await recoverAmbiguousAction({ state, ports, now });
        if (recovered !== state) {
          state = recovered;
          version = state.version;
          summary.store_version = version;
          summary.phase = state.phase;
          continue;
        }
      }
      summary.store_version = version;
      summary.phase = state.phase;
      return summary;
    }
    if (decision.intents.length > 0) {
      if (!apply || ports.effects == null) {
        // Plan-only observation is a valid bounded result; the committed intent
        // remains pending for the next authorized run.
        summary.decision = 'plan';
        summary.reason = decision.reason;
        summary.store_version = version;
        summary.phase = state.phase;
        summary.pending_intents = decision.intents.map((intent) => intent.type);
        return summary;
      }
      const versionBeforeIntents = state.version;
      for (const intent of decision.intents) {
        try {
          state = await executeIntent({ state, intent, ports, now });
        } catch {
          // The write-ahead intent (or pending action) is durable. A later wake
          // reads the effect back instead of blindly repeating it.
          summary.decision = 'recover';
          summary.reason = 'effect_execution_unavailable';
          summary.store_version = version;
          summary.phase = state.phase;
          return summary;
        }
        version = state.version;
      }
      if (state.version === versionBeforeIntents) {
        summary.steps.push({
          decision: 'effect_not_committed',
          reason: 'reload_and_reobserve',
        });
      }
    }
    summary.store_version = version;
    summary.phase = state.phase;
  }
  summary.exhausted = true;
  summary.phase = summary.phase ?? null;
  return summary;
}

// Bounded scan for the schedule/authenticated wake entrypoint. It only loads
// already-active durability records; it never discovers arbitrary open Issues
// and never auto-starts development.
export async function reconcileActiveIssues({
  issues, wake, ports, config = {}, now = Date.now(), maxIssues = 20,
}) {
  if (!Array.isArray(issues) || issues.length > 200) reject('invalid active Issue list');
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1 || maxIssues > 50) {
    reject('invalid Issue budget');
  }
  const unique = [...new Set(issues)].slice(0, maxIssues);
  const results = [];
  for (const issue of unique) {
    results.push(await reconcileOnce({ issue, wake, ports, config, now }));
  }
  return {
    schema_version: 1,
    kind: 'agent_workflow_v2_reconcile_batch',
    wake: { source: wake.source, reason: wake.reason },
    processed: results.length,
    results,
  };
}

export function activeLifecycleIssues(storeIndex) {
  if (!Array.isArray(storeIndex)) reject('invalid Store index');
  return storeIndex.filter((entry) => positive(entry?.issue) &&
    entry.schema_version === 2).map((entry) => entry.issue);
}
