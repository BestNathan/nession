// Issue #4482 — explicit schema v1 -> v2 compatibility projection.
//
// The immutable v1 state files remain in the Store and are never rewritten.
// A migrated v2 state records the exact source version/digest. Unknown or
// under-specified legacy states become an explicit `blocked` projection with a
// durable diagnostic instead of a silent reset or a guessed PR.
import { createHash } from 'node:crypto';
import { validateDevelopmentState } from '../orchestration/outbox.mjs';
import {
  actionIdFor, checkpointBinding, evidenceGenerationFor, stableDigest,
  threadIdFor, transitionKey, validateLifecycleState,
} from './contract.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const V1_PHASES = new Set(['ready', 'review', 'repair', 'quality', 'acceptance',
  'waiting-merge', 'post-merge-acceptance', 'done', 'blocked']);

function reject(message) {
  throw new Error('agent workflow migration: ' + message);
}
function v1Digest(state) {
  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(state, null, 2) + '\n')).digest('hex');
}
function firstTransitionSha(state) {
  return state.transitions.find((transition) => SHA40.test(transition.target_sha ?? ''))
    ?.target_sha ?? null;
}
function baseShaFor(state) {
  const pendingDeveloper = state.outbox.find((entry) =>
    entry.task?.type === 'dispatch' && entry.task.role === 'developer' &&
    ['pending', 'dispatching', 'dispatched'].includes(entry.status));
  if (SHA40.test(pendingDeveloper?.task?.sha ?? '')) return pendingDeveloper.task.sha;
  if (SHA40.test(state.target_sha ?? '')) return state.target_sha;
  return firstTransitionSha(state);
}
function categoryForFailure(code) {
  return ['cancelled', 'timeout', 'cancel', 'timed_out'].some((part) =>
    String(code).includes(part)) ? 'infrastructure' : 'model';
}

function convertAction(state, entry) {
  const task = entry.task;
  const role = task.role ?? null;
  if (task.type === 'notify') return null;
  if (task.type === 'verify' && task.gate === 'quality') return null;
  if (task.type === 'verify' && task.gate === 'sc-acceptance') {
    return {
      id: entry.id,
      role: 'acceptor',
      action: 'accept',
      sha: task.sha,
      evidence_generation: null,
      agent_id: state.assignments.acceptor,
      feedback_sha256: null,
      resume: false,
      gate: state.phase === 'post-merge-acceptance' ? 'merged' : 'pr',
      status: 'pending',
      attempts: 0,
      run: null,
      receipt: null,
      predecessor: null,
      created_version: 1,
    };
  }
  if (task.type !== 'dispatch' || role == null) return null;
  let status = entry.status;
  let run = null;
  let receipt = null;
  if (status === 'dispatching') {
    receipt = {
      status: 'prepared', dispatch_id: entry.id,
      issuer_run_id: entry.receipt?.issuer_run_id ?? 0,
      ticket_sha256: entry.receipt?.ticket_sha256 ?? '0'.repeat(64),
    };
    if (!receipt.issuer_run_id || !/^[a-f0-9]{64}$/.test(receipt.ticket_sha256)) {
      status = 'ambiguous';
      receipt = null;
    }
  } else if (status === 'dispatched') {
    if (entry.receipt?.status === 'verified' && entry.receipt.source_run_id) {
      run = { id: entry.receipt.source_run_id, attempt: 1, verified: true };
      status = 'dispatched';
    } else {
      // A v1 dispatch acknowledgement without a Run binding cannot be replayed
      // as an executable v2 action; fail closed as ambiguous.
      status = 'ambiguous';
    }
    receipt = null;
  } else if (status === 'yielded') {
    const source = entry.receipt ?? {};
    receipt = {
      status: 'yielded', dispatch_id: entry.id,
      source_run_id: source.source_run_id, source_attempt: source.source_attempt,
      checkpoint_version: source.checkpoint_version,
      checkpoint_commit_sha: source.checkpoint_commit_sha,
      ciphertext_sha256: source.ciphertext_sha256,
    };
  } else if (status === 'failed') {
    const source = entry.receipt ?? {};
    receipt = {
      status: 'failed', dispatch_id: entry.id,
      source_run_id: source.source_run_id, source_attempt: source.source_attempt,
      failure_code: source.failure_code ?? 'legacy_failure',
      category: categoryForFailure(source.failure_code),
    };
  } else if (status !== 'pending') {
    return null;
  }
  return {
    id: entry.id,
    role,
    action: task.task === 'review' ? 'review' : task.task === 'repair' ? 'repair' : 'implement',
    sha: task.sha,
    evidence_generation: null,
    agent_id: task.agent_id ?? state.assignments[role],
    feedback_sha256: null,
    resume: task.resume === true,
    gate: null,
    status,
    attempts: entry.attempts ?? 0,
    run,
    receipt,
    predecessor: task.continuation?.parent_action_id ?? null,
    created_version: 1,
  };
}

function convertTransitions(state) {
  const seen = new Set();
  const converted = [];
  for (const transition of state.transitions) {
    const event = {
      issue: state.issue,
      kind: transition.kind,
      outcome: transition.outcome,
      action_id: null,
      run_id: transition.run_id ?? null,
      attempt: transition.attempt ?? null,
      target_sha: transition.target_sha ?? null,
      evidence_generation: null,
    };
    const key = transitionKey(event);
    if (seen.has(key)) {
      // Two legacy records with identical authenticated identity are one
      // historical fact; keep the first and retain the source digest.
      continue;
    }
    seen.add(key);
    converted.push({
      key, kind: event.kind, outcome: event.outcome,
      action_id: event.action_id, run_id: event.run_id,
      attempt: event.attempt, target_sha: event.target_sha,
      evidence_generation: event.evidence_generation,
      recorded_version: 1,
    });
  }
  return converted;
}

function blockedProjection({ state, baseSha, reason, migration, now }) {
  return validateLifecycleState({
    schema_version: 2,
    issue: state.issue,
    version: 1,
    phase: 'blocked',
    substate: 'legacy_migration_blocked',
    thread: {
      id: threadIdFor({ issue: state.issue, developer: state.assignments.developer,
        base_sha: baseSha }),
      attempt: 1,
      base_sha: baseSha,
      head_sha: null,
      merged_sha: null,
      fencing_generation: 1,
      checkpoint: null,
    },
    assignments: { ...state.assignments },
    pr: null,
    ci: null,
    review: null,
    feedback: null,
    budgets: {
      infrastructure_retries: 0,
      model_retries: 0,
      repair_rounds: state.repair_attempts ?? 0,
    },
    transitions: [],
    outbox: [],
    blocker: { reason, evidence_ref: null, owner_action_required: true },
    cancellation: null,
    migration: {
      ...migration,
      mapped_phase: 'blocked',
    },
    start: {
      authority_run_id: state.transitions[0]?.run_id ?? 0,
      authorized_at: now,
    },
    wake: null,
    updated_at: now,
  });
}

// `pr` is a trusted readback required for legacy phases whose state does not
// record the PR number. It is never inferred from Issue prose or a model.
export function migrateV1State({ state: v1, pr = null, readback = null, now = Date.now() }) {
  validateDevelopmentState(v1);
  pr = pr ?? readback?.pr ?? null;
  const checkpoint = readback?.checkpoint == null ? null : checkpointBinding(readback.checkpoint);
  const fencing = readback?.lease?.fencing_generation;
  if (fencing != null && (!Number.isSafeInteger(fencing) || fencing < 1)) {
    reject('invalid legacy lease fencing generation');
  }
  const fencingGeneration = fencing ?? 1;
  if (v1.schema_version !== 1 || !V1_PHASES.has(v1.phase)) {
    reject('unsupported legacy schema/phase');
  }
  if (!Number.isSafeInteger(now) || now < 1) reject('invalid clock');
  const baseSha = baseShaFor(v1);
  if (!SHA40.test(baseSha ?? '')) reject('legacy state has no trustworthy base/head SHA');
  const migration = {
    from_schema_version: 1,
    from_version: v1.version,
    from_digest: v1Digest(v1),
    from_phase: v1.phase,
    mapped_phase: v1.phase,
    legacy_order: v1.phase === 'review' ? 'reviewer_first' : 'none',
  };
  const converted = v1.outbox.map((entry) => convertAction(v1, entry))
    .filter((entry) => entry != null);
  const active = converted.filter((entry) =>
    !['retired', 'failed', 'cancelled', 'yielded'].includes(entry.status));
  if (active.length > 1) {
    reject('legacy state has multiple active actions');
  }
  // A v1 dispatch without a verified Run binding is ambiguous. A readback may
  // prove the original Run; otherwise the migration blocks instead of guessing.
  for (const entry of active) {
    if (entry.status !== 'ambiguous') continue;
    const proof = readback?.run;
    if (proof?.verified === true && proof.action_id === entry.id &&
        Number.isSafeInteger(proof.run_id) && proof.run_id > 0 &&
        Number.isSafeInteger(proof.run_attempt) && proof.run_attempt > 0) {
      entry.status = 'dispatched';
      entry.run = {
        id: proof.run_id, attempt: proof.run_attempt, verified: true,
      };
    } else {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_ambiguous_dispatch',
      });
    }
  }
  const prBinding = (readback) => ({
    number: readback.number,
    head_sha: readback.head_sha,
    base_sha: readback.base_sha,
    state: readback.state,
    merged_sha: readback.merged_sha ?? null,
  });

  const common = {
    schema_version: 2,
    issue: v1.issue,
    version: 1,
    assignments: { ...v1.assignments },
    transitions: convertTransitions(v1),
    migration,
    start: {
      authority_run_id: v1.transitions[0]?.run_id ?? 0,
      authorized_at: now,
    },
    wake: null,
    updated_at: now,
    budgets: {
      infrastructure_retries: 0,
      model_retries: 0,
      repair_rounds: v1.repair_attempts ?? 0,
    },
    blocker: null,
    cancellation: null,
  };

  const requirePr = (label) => {
    if (pr == null) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_' + label + '_requires_pr_readback',
      });
    }
    if (!SHA40.test(pr.head_sha ?? '') || !SHA40.test(pr.base_sha ?? '') ||
        !Number.isSafeInteger(pr.number) || pr.number < 1 ||
        !['open', 'closed', 'merged'].includes(pr.state)) {
      reject('invalid legacy PR readback');
    }
    return null;
  };

  if (v1.phase === 'done') {
    const merged = v1.merged_sha ?? v1.target_sha ?? firstTransitionSha(v1);
    return validateLifecycleState({
      ...common,
      phase: 'done',
      substate: 'legacy_complete',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: null,
        merged_sha: SHA40.test(merged ?? '') ? merged : null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: null,
      ci: null,
      review: null,
      feedback: null,
      outbox: [],
      migration: { ...migration, mapped_phase: 'done' },
    });
  }
  if (v1.phase === 'blocked') {
    return blockedProjection({
      state: v1, baseSha, migration, now,
      reason: 'legacy_blocked_state_requires_owner',
    });
  }
  if (v1.phase === 'ready') {
    const developer = active.find((entry) => entry.role === 'developer');
    if (developer == null || developer.action !== 'implement') {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_ready_state_missing_developer_action',
      });
    }
    return validateLifecycleState({
      ...common,
      phase: 'authorized',
      substate: 'legacy_ready',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: null,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: null,
      ci: null,
      review: null,
      feedback: null,
      outbox: [developer],
      migration: { ...migration, mapped_phase: 'authorized' },
    });
  }
  if (v1.phase === 'repair') {
    const developer = active.find((entry) => entry.role === 'developer' && entry.action === 'repair');
    if (developer == null) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_repair_state_missing_repair_action',
      });
    }
    const blocked = requirePr('repair');
    if (blocked != null) return blocked;
    if (pr.head_sha !== v1.target_sha) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_repair_head_differs_from_pr',
      });
    }
    const repairCheckpoint = v1.outbox.find((entry) => entry.id === developer.id)
      ?.task?.repair_checkpoint ?? null;
    return validateLifecycleState({
      ...common,
      phase: 'developing',
      substate: 'legacy_repair',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: pr.head_sha,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint: checkpoint ?? (repairCheckpoint == null ? null : {
          version: repairCheckpoint.checkpoint_version,
          commit_sha: repairCheckpoint.checkpoint_commit_sha,
          ciphertext_sha256: repairCheckpoint.ciphertext_sha256,
          native_session_id: null,
        }),
      },
      pr: { ...prBinding(pr), merged_sha: null },
      ci: null,
      review: null,
      feedback: null,
      outbox: [developer],
      migration: { ...migration, mapped_phase: 'developing' },
    });
  }
  if (v1.phase === 'review') {
    const reviewer = active.find((entry) => entry.role === 'reviewer');
    if (reviewer == null || !SHA40.test(v1.target_sha ?? '')) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_review_state_missing_reviewer_action',
      });
    }
    const blocked = requirePr('review');
    if (blocked != null) return blocked;
    if (pr.head_sha !== v1.target_sha) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_review_head_differs_from_pr',
      });
    }
    return validateLifecycleState({
      ...common,
      phase: 'reviewing',
      substate: 'legacy_review',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: v1.target_sha,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: { ...prBinding(pr), merged_sha: null },
      ci: null,
      review: null,
      feedback: null,
      outbox: [{
        ...reviewer,
        // A legacy Reviewer-first action has no V2 CI generation yet. The
        // deterministic legacy binding is HEAD-only; CI is collected after the
        // Review verdict and before any aggregate decision.
        evidence_generation: evidenceGenerationFor({
          head_sha: v1.target_sha, ci_digest: null,
        }),
      }],
      migration: { ...migration, mapped_phase: 'reviewing' },
    });
  }
  if (v1.phase === 'quality') {
    const blocked = requirePr('quality');
    if (blocked != null) return blocked;
    if (pr.head_sha !== v1.target_sha) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_quality_head_differs_from_pr',
      });
    }
    return validateLifecycleState({
      ...common,
      phase: 'ci_checking',
      substate: 'legacy_quality_barrier',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: v1.target_sha,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: { ...prBinding(pr), merged_sha: null },
      ci: null,
      review: null,
      feedback: null,
      outbox: [],
      migration: { ...migration, mapped_phase: 'ci_checking' },
    });
  }
  if (v1.phase === 'acceptance') {
    const blocked = requirePr('acceptance');
    if (blocked != null) return blocked;
    if (pr.head_sha !== v1.target_sha) {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_acceptance_head_differs_from_pr',
      });
    }
    const acceptor = active.find((entry) => entry.role === 'acceptor') ?? {
      id: actionIdFor({
        issue: v1.issue,
        thread_id: threadIdFor({
          issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha,
        }),
        role: 'acceptor', action: 'accept', sha: v1.target_sha, ordinal: 1,
      }),
      role: 'acceptor', action: 'accept', sha: v1.target_sha,
      evidence_generation: null, agent_id: v1.assignments.acceptor,
      feedback_sha256: null, resume: false, gate: 'pr', status: 'pending',
      attempts: 0, run: null, receipt: null, predecessor: null, created_version: 1,
    };
    return validateLifecycleState({
      ...common,
      phase: 'accepting',
      substate: 'legacy_acceptance',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: v1.target_sha,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: { ...prBinding(pr), merged_sha: null },
      ci: null,
      review: null,
      feedback: null,
      outbox: [acceptor],
      migration: { ...migration, mapped_phase: 'accepting' },
    });
  }
  if (v1.phase === 'waiting-merge') {
    const blocked = requirePr('waiting_merge');
    if (blocked != null) return blocked;
    if (pr.head_sha !== v1.target_sha || pr.state !== 'open') {
      return blockedProjection({
        state: v1, baseSha, migration, now,
        reason: 'legacy_waiting_merge_head_or_state_mismatch',
      });
    }
    return validateLifecycleState({
      ...common,
      phase: 'waiting_merge',
      substate: 'legacy_waiting_merge',
      thread: {
        id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
        attempt: 1,
        base_sha: baseSha,
        head_sha: v1.target_sha,
        merged_sha: null,
        fencing_generation: fencingGeneration,
        checkpoint,
      },
      pr: { ...prBinding(pr), merged_sha: null },
      ci: null,
      review: null,
      feedback: null,
      outbox: [],
      migration: { ...migration, mapped_phase: 'waiting_merge' },
    });
  }
  // post-merge-acceptance
  const merged = v1.merged_sha ?? v1.target_sha;
  if (!SHA40.test(merged ?? '')) {
    return blockedProjection({
      state: v1, baseSha, migration, now,
      reason: 'legacy_post_merge_state_missing_merged_sha',
    });
  }
  const blocked = requirePr('post_merge');
  if (blocked != null) return blocked;
  if (pr.state !== 'merged' || pr.merged_sha !== merged) {
    return blockedProjection({
      state: v1, baseSha, migration, now,
      reason: 'legacy_post_merge_pr_mismatch',
    });
  }
  const acceptor = {
    id: actionIdFor({
      issue: v1.issue,
      thread_id: threadIdFor({
        issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha,
      }),
      role: 'acceptor', action: 'accept', sha: merged, ordinal: 1,
    }),
    role: 'acceptor', action: 'accept', sha: merged,
    evidence_generation: null, agent_id: v1.assignments.acceptor,
    feedback_sha256: null, resume: false, gate: 'merged', status: 'pending',
    attempts: 0, run: null, receipt: null, predecessor: null, created_version: 1,
  };
  return validateLifecycleState({
    ...common,
    phase: 'post_merge_acceptance',
    substate: 'legacy_post_merge',
    thread: {
      id: threadIdFor({ issue: v1.issue, developer: v1.assignments.developer, base_sha: baseSha }),
      attempt: 1,
      base_sha: baseSha,
      head_sha: pr.head_sha,
      merged_sha: merged,
      fencing_generation: fencingGeneration,
      checkpoint,
    },
    pr: { ...prBinding(pr), state: 'merged', merged_sha: merged },
    ci: null,
    review: null,
    feedback: null,
    outbox: [acceptor],
    migration: { ...migration, mapped_phase: 'post_merge_acceptance' },
  });
}

// Deterministic identity for a legacy lifecycle, exposed for fixtures and for
// the Reconcile scan to deduplicate two wakes for the same Issue.
export function legacyLifecycleDigest(v1) {
  validateDevelopmentState(v1);
  return stableDigest(['agent-workflow-v2-legacy', v1.issue, v1.version, v1Digest(v1)]);
}
