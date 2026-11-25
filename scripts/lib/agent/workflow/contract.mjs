// Issue #4482 — Agent Workflow V2 canonical lifecycle contract.
//
// This module owns the versioned Issue lifecycle state shape, its identity
// rules and its strict validation. It contains no GitHub, Store, Provider or
// model access: every observation and effect is supplied by trusted callers.
//
// `schema_version: 1` remains the legacy state format owned by
// `orchestration/transition.mjs`. A schema v2 state is driven ONLY by
// `workflow/lifecycle.mjs`; a schema v1 state is never accepted by V2 code.
import { createHash } from 'node:crypto';
import { resolveIdentity, validateRegistry } from '../harness/contract.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{1,80}$/;

export const BUSINESS_PHASES = Object.freeze([
  'authorized',
  'developing',
  'publishing',
  'ci_checking',
  'reviewing',
  'evaluating',
  'accepting',
  'waiting_merge',
  'post_merge_acceptance',
  'done',
  'blocked',
  'cancelled',
]);

// Task execution states. A GitHub Run being queued/in_progress/completed is an
// observation, never by itself an accepted result or business completion.
export const EXECUTION_STATES = Object.freeze([
  'pending',
  'dispatching',
  'dispatched',
  'claimed',
  'executing',
  'result_available',
  'committed',
  'retired',
  'yielded',
  'failed',
  'cancelled',
  'ambiguous',
]);

export const EXECUTION_EDGES = Object.freeze({
  pending: Object.freeze(['dispatching', 'cancelled']),
  dispatching: Object.freeze(['dispatched', 'ambiguous', 'failed', 'cancelled']),
  dispatched: Object.freeze(['claimed', 'ambiguous', 'failed', 'cancelled']),
  claimed: Object.freeze(['executing', 'failed', 'cancelled']),
  executing: Object.freeze(['result_available', 'yielded', 'ambiguous', 'failed', 'cancelled']),
  result_available: Object.freeze(['committed', 'failed', 'cancelled']),
  committed: Object.freeze(['retired']),
  yielded: Object.freeze(['retired']),
  ambiguous: Object.freeze(['dispatched', 'failed', 'cancelled', 'retired']),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  retired: Object.freeze([]),
});

export const WAKE_SOURCES = Object.freeze(['github_event', 'schedule', 'external', 'manual']);

export const ROLE_ACTIONS = Object.freeze({
  developer: Object.freeze(['implement', 'repair']),
  publisher: Object.freeze(['publish']),
  reviewer: Object.freeze(['review']),
  acceptor: Object.freeze(['accept']),
});

// Notification/observation actions have no model role. `ci_retry` is a durable
// system Outbox action: its creation is the write-ahead intent, and its
// committed receipt records the verified rerun Run/attempt.
export const SYSTEM_ACTIONS = Object.freeze([
  'merge_notify', 'block_notify', 'done_notify', 'ci_retry',
]);

export const CI_STATUSES = Object.freeze([
  'pending', 'pass', 'actionable_fail', 'infrastructure', 'missing',
]);

export const REVIEW_OUTCOMES = Object.freeze(['approved', 'changes_requested']);

export const REVIEWER_FAILURES = Object.freeze([
  'runtime_failure', 'invalid_result', 'cancelled', 'timeout',
]);

export const FAILURE_CATEGORIES = Object.freeze([
  'infrastructure', 'model', 'business', 'ambiguous',
]);

export const DEFAULT_CONFIG = Object.freeze({
  max_infrastructure_retries: 3,
  max_model_retries: 3,
  max_repair_rounds: 3,
  max_actions: 128,
  max_transitions: 512,
  max_steps: 8,
});

export const MAX_CHECK_RESULTS = 128;
export const MAX_FINDINGS = 256;

function reject(message) {
  throw new Error('agent workflow v2: ' + message);
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function onlyKeys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    reject('invalid ' + label);
  }
}
function sha(value, label) {
  if (!SHA40.test(value ?? '')) reject('invalid ' + label);
  return value;
}
function hex(value, label) {
  if (!HEX64.test(value ?? '')) reject('invalid ' + label);
  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}
export function stableDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// Logical Developer Thread: persists across Runs, attempts and repair rounds.
// A retry or resumed repair is NOT a new Thread.
export function threadIdFor({ issue, developer, base_sha }) {
  if (!positive(issue) || !AGENT_ID.test(developer ?? '')) reject('invalid Thread identity');
  return stableDigest(['agent-workflow-v2-thread', issue, developer, sha(base_sha, 'Thread base SHA')]);
}

// Stable, deterministic action identity. Re-deciding the same transition
// without committed state must produce the same action, never a duplicate POST.
export function actionIdFor({ issue, thread_id, role, action, sha: target, ordinal, predecessor = null }) {
  if (!positive(issue) || !HEX64.test(thread_id ?? '') ||
      typeof role !== 'string' || typeof action !== 'string' ||
      !Number.isSafeInteger(ordinal) || ordinal < 1) reject('invalid action identity');
  return stableDigest([
    'agent-workflow-v2-action', issue, thread_id, role, action,
    sha(target, 'action SHA'), ordinal, predecessor,
  ]);
}

// Evidence generation binds every CI/Review/Acceptance/Merge fact to one exact
// PR head plus its accepted evidence. A rerun that materially changes evidence
// yields a new generation and invalidates the old aggregate.
export function evidenceGenerationFor({ head_sha, ci_digest = null, review_digest = null }) {
  return stableDigest([
    'agent-workflow-v2-evidence', sha(head_sha, 'evidence HEAD'),
    ci_digest ?? null, review_digest ?? null,
  ]);
}

export function transitionKey(event) {
  return stableDigest([
    'agent-workflow-v2-transition', event.issue, event.kind, event.action_id ?? null,
    event.run_id ?? null, event.attempt ?? null, event.target_sha ?? null,
    event.outcome ?? null, event.evidence_generation ?? null,
  ]);
}

export function checkpointBinding(checkpoint) {
  if (checkpoint == null) return null;
  onlyKeys(checkpoint, ['version', 'commit_sha', 'ciphertext_sha256', 'native_session_id'],
    'checkpoint binding');
  if (!positive(checkpoint.version) || !SHA40.test(checkpoint.commit_sha ?? '') ||
      !HEX64.test(checkpoint.ciphertext_sha256 ?? '') ||
      !(checkpoint.native_session_id == null ||
        (typeof checkpoint.native_session_id === 'string' &&
         checkpoint.native_session_id.length > 0 && checkpoint.native_session_id.length <= 256))) {
    reject('invalid checkpoint binding');
  }
  return {
    version: checkpoint.version,
    commit_sha: checkpoint.commit_sha,
    ciphertext_sha256: checkpoint.ciphertext_sha256,
    native_session_id: checkpoint.native_session_id ?? null,
  };
}

function validateAuthority(authority) {
  onlyKeys(authority, ['repository', 'event', 'permission', 'ref', 'run_id'], 'start authority');
  if (authority.repository !== 'BestNathan/nession' ||
      authority.event !== 'workflow_dispatch' || authority.permission !== 'write' ||
      authority.ref !== 'refs/heads/main' || !positive(authority.run_id)) {
    reject('unauthorized lifecycle start');
  }
}

// A new lifecycle starts ONLY from a verified owner-authorized command. Scanning
// arbitrary open Issues/PRs must never call this function.
export function createLifecycleState({
  registry, issue, base_sha, developer, reviewer, acceptor,
  developer_sha, authority, now = Date.now(),
}) {
  validateRegistry(registry);
  validateAuthority(authority);
  if (!plain(registry.instances)) reject('invalid registry');
  const assignments = { developer, reviewer, acceptor };
  for (const role of ['developer', 'reviewer', 'acceptor']) {
    const instance = registry.instances[assignments[role]];
    if (!instance || instance.role !== role) reject('role or ID is not registered');
    resolveIdentity(registry, assignments[role], ROLE_ACTIONS[role][0], instance.environment);
  }
  sha(base_sha, 'base SHA');
  sha(developer_sha, 'Developer source SHA');
  if (!positive(now)) reject('invalid clock');
  const thread_id = threadIdFor({ issue, developer, base_sha });
  const action_id = actionIdFor({
    issue, thread_id, role: 'developer', action: 'implement',
    sha: developer_sha, ordinal: 1,
  });
  const state = {
    schema_version: 2,
    issue,
    version: 1,
    phase: 'authorized',
    substate: 'idle',
    thread: {
      id: thread_id,
      attempt: 1,
      base_sha,
      head_sha: null,
      merged_sha: null,
      fencing_generation: 1,
      checkpoint: null,
    },
    assignments,
    pr: null,
    ci: null,
    review: null,
    feedback: null,
    budgets: { infrastructure_retries: 0, model_retries: 0, repair_rounds: 0 },
    transitions: [],
    outbox: [{
      id: action_id,
      role: 'developer',
      action: 'implement',
      sha: developer_sha,
      evidence_generation: null,
      agent_id: developer,
      feedback_sha256: null,
      resume: false,
      status: 'pending',
      attempts: 0,
      run: null,
      receipt: null,
      predecessor: null,
      created_version: 1,
    }],
    blocker: null,
    cancellation: null,
    migration: null,
    start: { authority_run_id: authority.run_id, authorized_at: now },
    wake: null,
    updated_at: now,
  };
  return validateLifecycleState(state);
}

function validateAction(action, state, seen) {
  onlyKeys(action, ['id', 'role', 'action', 'sha', 'evidence_generation', 'agent_id',
    'feedback_sha256', 'resume', 'gate', 'status', 'attempts', 'run', 'receipt',
    'predecessor', 'created_version'], 'v2 outbox action');
  if (!HEX64.test(action.id ?? '') || seen.has(action.id)) reject('invalid/duplicate v2 action');
  seen.add(action.id);
  sha(action.sha, 'action SHA');
  if (action.evidence_generation != null) hex(action.evidence_generation, 'action evidence generation');
  if (!EXECUTION_STATES.includes(action.status)) reject('invalid execution state');
  if (!nonNegative(action.attempts) || action.attempts > 64) reject('invalid action attempts');
  if (!positive(action.created_version) || action.created_version > state.version) {
    reject('invalid action creation version');
  }
  if (action.resume != null && typeof action.resume !== 'boolean') reject('invalid resume flag');
  if (action.feedback_sha256 != null) hex(action.feedback_sha256, 'feedback digest');
  if (action.predecessor != null) hex(action.predecessor, 'action predecessor');
  if (action.role == null) {
    if (!SYSTEM_ACTIONS.includes(action.action) || action.agent_id != null) {
      reject('invalid system action');
    }
  } else {
    if (!ROLE_ACTIONS[action.role]?.includes(action.action)) reject('invalid role action');
    if (!AGENT_ID.test(action.agent_id ?? '')) reject('missing action Agent assignment');
    if (action.role !== 'publisher' && action.agent_id !== state.assignments[action.role]) {
      reject('action Agent differs from registered assignment');
    }
    if (action.role === 'publisher' && !AGENT_ID.test(action.agent_id)) reject('invalid Publisher identity');
  }
  if (action.gate != null && !['pr', 'merged', 'ci'].includes(action.gate)) reject('invalid action gate');
  if (action.run != null) {
    onlyKeys(action.run, ['id', 'attempt', 'verified'], 'action Run binding');
    if (!positive(action.run.id) || !positive(action.run.attempt) ||
        action.run.verified !== true) reject('invalid action Run binding');
  }
  const terminal = ['result_available', 'committed', 'retired', 'yielded', 'failed', 'cancelled'];
  if (action.receipt != null) {
    if (!plain(action.receipt)) reject('invalid action receipt');
    if (action.status === 'dispatching') {
      onlyKeys(action.receipt, ['status', 'dispatch_id', 'issuer_run_id', 'ticket_sha256'],
        'dispatch intent receipt');
      if (action.receipt.status !== 'prepared' || action.receipt.dispatch_id !== action.id ||
          !positive(action.receipt.issuer_run_id) ||
          !HEX64.test(action.receipt.ticket_sha256 ?? '')) {
        reject('invalid dispatch intent receipt');
      }
    } else if (action.status === 'yielded') {
      onlyKeys(action.receipt, ['status', 'dispatch_id', 'source_run_id', 'source_attempt',
        'checkpoint_version', 'checkpoint_commit_sha', 'ciphertext_sha256'], 'yield receipt');
      if (action.receipt.status !== 'yielded' || action.receipt.dispatch_id !== action.id ||
          !positive(action.receipt.source_run_id) ||
          !positive(action.receipt.source_attempt) ||
          !positive(action.receipt.checkpoint_version) ||
          !SHA40.test(action.receipt.checkpoint_commit_sha ?? '') ||
          !HEX64.test(action.receipt.ciphertext_sha256 ?? '')) reject('invalid yield receipt');
    } else if (action.status === 'failed') {
      onlyKeys(action.receipt, ['status', 'dispatch_id', 'source_run_id', 'source_attempt',
        'failure_code', 'category'], 'failure receipt');
      if (action.receipt.status !== 'failed' || action.receipt.dispatch_id !== action.id ||
          !positive(action.receipt.source_run_id) ||
          !positive(action.receipt.source_attempt) ||
          typeof action.receipt.failure_code !== 'string' ||
          !FAILURE_CATEGORIES.includes(action.receipt.category)) {
        reject('invalid failure receipt');
      }
    } else if (['result_available', 'committed'].includes(action.status)) {
      onlyKeys(action.receipt, ['status', 'dispatch_id', 'source_run_id', 'source_attempt',
        'outcome', 'evidence_generation'], 'result receipt');
      if (action.receipt.status !== 'available' || action.receipt.dispatch_id !== action.id ||
          typeof action.receipt.outcome !== 'string' ||
          (action.role == null ?
            action.receipt.source_run_id != null || action.receipt.source_attempt != null :
            !positive(action.receipt.source_run_id) ||
            !positive(action.receipt.source_attempt))) reject('invalid result receipt');
    } else if (action.status === 'cancelled') {
      onlyKeys(action.receipt, ['status', 'reason'], 'cancellation receipt');
      if (action.receipt.status !== 'cancelled' || typeof action.receipt.reason !== 'string' ||
          action.receipt.reason.length < 1 || action.receipt.reason.length > 200) {
        reject('invalid cancellation receipt');
      }
    } else if (action.status === 'retired') {
      onlyKeys(action.receipt, ['status', 'reason'], 'retirement receipt');
      if (action.receipt.status !== 'retired' || typeof action.receipt.reason !== 'string' ||
          action.receipt.reason.length < 1 || action.receipt.reason.length > 200) {
        reject('invalid retirement receipt');
      }
    } else {
      reject('unexpected receipt on ' + action.status + ' action');
    }
  } else if (terminal.includes(action.status)) {
    reject('terminal action requires a receipt');
  }
  if (action.role != null && action.status !== 'dispatching' && action.status !== 'pending' &&
      action.run == null &&
      !['yielded', 'failed', 'cancelled', 'retired', 'ambiguous'].includes(action.status)) {
    reject('dispatched action requires a verified Run binding');
  }
  return action;
}

function validateCi(ci, state) {
  if (ci == null) return;
  onlyKeys(ci, ['head_sha', 'obligation_sha256', 'status', 'digest', 'checks', 'observed_at'],
    'CI evidence');
  sha(ci.head_sha, 'CI HEAD');
  hex(ci.obligation_sha256, 'CI obligation');
  hex(ci.digest, 'CI digest');
  if (!CI_STATUSES.includes(ci.status)) reject('invalid CI status');
  if (!positive(ci.observed_at)) reject('invalid CI observation time');
  if (!Array.isArray(ci.checks) || ci.checks.length > MAX_CHECK_RESULTS) reject('invalid CI checks');
  for (const check of ci.checks) {
    onlyKeys(check, ['name', 'workflow', 'conclusion', 'applicability', 'evidence_ref'],
      'CI check');
    if (typeof check.name !== 'string' || check.name.length < 1 || check.name.length > 200 ||
        typeof check.workflow !== 'string' || check.workflow.length < 1 ||
        check.workflow.length > 200 ||
        !['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped',
          'pending', 'missing', 'unknown'].includes(check.conclusion) ||
        !['applicable', 'not_applicable', 'unknown'].includes(check.applicability) ||
        (check.evidence_ref != null &&
         (typeof check.evidence_ref !== 'string' || check.evidence_ref.length > 500))) {
      reject('invalid CI check');
    }
  }
  if (state.pr != null && state.pr.head_sha !== ci.head_sha) {
    // CI evidence for another HEAD is stale; it may be recorded only as an
    // observation, never as the accepted obligation for the current PR.
    reject('CI evidence for a different PR HEAD');
  }
}

function validateReview(review, state) {
  if (review == null) return;
  onlyKeys(review, ['head_sha', 'evidence_generation', 'outcome', 'run_id', 'attempt',
    'digest', 'findings'], 'Review evidence');
  sha(review.head_sha, 'Review HEAD');
  hex(review.evidence_generation, 'Review evidence generation');
  if (!REVIEW_OUTCOMES.includes(review.outcome)) reject('invalid Review outcome');
  if (!positive(review.run_id) || !positive(review.attempt)) reject('invalid Review Run');
  hex(review.digest, 'Review digest');
  if (!Array.isArray(review.findings) || review.findings.length > MAX_FINDINGS) {
    reject('invalid Review findings');
  }
  for (const finding of review.findings) {
    onlyKeys(finding, ['id', 'severity', 'category', 'message', 'file', 'sc'], 'Review finding');
    if (typeof finding.id !== 'string' || finding.id.length < 1 || finding.id.length > 200 ||
        !['blocking', 'nonblocking'].includes(finding.severity) ||
        typeof finding.category !== 'string' || typeof finding.message !== 'string' ||
        finding.message.length > 4000 ||
        (finding.file != null && (typeof finding.file !== 'string' || finding.file.length > 500)) ||
        (finding.sc != null && !/^SC-[0-9]{2}$/.test(finding.sc))) {
      reject('invalid Review finding');
    }
  }
  if (state.pr != null && state.pr.head_sha !== review.head_sha) {
    reject('Review evidence for a different PR HEAD');
  }
}

function validateFeedback(feedback, state) {
  if (feedback == null) return;
  onlyKeys(feedback, ['bundle_sha256', 'head_sha', 'ci_digest', 'review_digest',
    'parent_sha256', 'repair_round', 'finding_ids', 'sources', 'findings',
    'prior_finding_ids'], 'feedback bundle');
  hex(feedback.bundle_sha256, 'feedback bundle');
  sha(feedback.head_sha, 'feedback HEAD');
  if (feedback.ci_digest != null) hex(feedback.ci_digest, 'feedback CI digest');
  if (feedback.review_digest != null) hex(feedback.review_digest, 'feedback Review digest');
  if (feedback.parent_sha256 != null) hex(feedback.parent_sha256, 'feedback parent');
  if (!positive(feedback.repair_round) || feedback.repair_round > 32) reject('invalid repair round');
  if (!Array.isArray(feedback.finding_ids) || feedback.finding_ids.length > MAX_FINDINGS ||
      feedback.finding_ids.some((id) => typeof id !== 'string' || id.length > 200)) {
    reject('invalid feedback finding IDs');
  }
  if (!Array.isArray(feedback.sources) || feedback.sources.length < 1 ||
      feedback.sources.length > 8 ||
      feedback.sources.some((source) => !['ci', 'review', 'acceptance'].includes(source))) {
    reject('invalid feedback sources');
  }
  if (feedback.findings != null) {
    if (!Array.isArray(feedback.findings) || feedback.findings.length > MAX_FINDINGS) {
      reject('invalid feedback findings');
    }
    for (const finding of feedback.findings) {
      onlyKeys(finding, ['id', 'severity', 'category', 'message', 'file', 'sc'],
        'feedback finding');
      if (typeof finding.id !== 'string' || finding.id.length < 1 || finding.id.length > 200 ||
          !['blocking', 'nonblocking'].includes(finding.severity) ||
          typeof finding.category !== 'string' || typeof finding.message !== 'string' ||
          finding.message.length > 4000 ||
          (finding.file != null && (typeof finding.file !== 'string' || finding.file.length > 500)) ||
          (finding.sc != null && !/^SC-[0-9]{2}$/.test(finding.sc))) {
        reject('invalid feedback finding');
      }
    }
  }
  if (feedback.prior_finding_ids != null) {
    if (!Array.isArray(feedback.prior_finding_ids) ||
        feedback.prior_finding_ids.length > MAX_FINDINGS ||
        feedback.prior_finding_ids.some((id) => typeof id !== 'string' || id.length > 200)) {
      reject('invalid prior feedback finding IDs');
    }
  }
  if (state.pr != null && state.pr.head_sha !== feedback.head_sha) {
    reject('feedback bundle for a different PR HEAD');
  }
}

export function validateLifecycleState(state) {
  onlyKeys(state, ['schema_version', 'issue', 'version', 'phase', 'substate', 'thread',
    'assignments', 'pr', 'ci', 'review', 'feedback', 'budgets', 'transitions', 'outbox',
    'blocker', 'cancellation', 'migration', 'start', 'wake', 'updated_at'], 'v2 state');
  if (state.schema_version !== 2 || !positive(state.issue) || !positive(state.version) ||
      !BUSINESS_PHASES.includes(state.phase) ||
      !(state.substate == null ||
        (typeof state.substate === 'string' && /^[a-z][a-z0-9_]{1,80}$/.test(state.substate))) ||
      !positive(state.updated_at)) {
    reject('invalid v2 state shape');
  }
  onlyKeys(state.thread, ['id', 'attempt', 'base_sha', 'head_sha', 'merged_sha',
    'fencing_generation', 'checkpoint'], 'Thread');
  hex(state.thread.id, 'Thread ID');
  if (!positive(state.thread.attempt) || state.thread.attempt > 64) reject('invalid Thread attempt');
  sha(state.thread.base_sha, 'Thread base SHA');
  if (state.thread.head_sha != null) sha(state.thread.head_sha, 'Thread HEAD');
  if (state.thread.merged_sha != null) sha(state.thread.merged_sha, 'Thread merged SHA');
  if (!positive(state.thread.fencing_generation)) reject('invalid fencing generation');
  checkpointBinding(state.thread.checkpoint);
  onlyKeys(state.assignments, ['developer', 'reviewer', 'acceptor'], 'role assignments');
  for (const role of ['developer', 'reviewer', 'acceptor']) {
    if (!AGENT_ID.test(state.assignments[role] ?? '')) reject('missing agent assignment');
  }
  if (state.pr != null) {
    onlyKeys(state.pr, ['number', 'head_sha', 'base_sha', 'state', 'merged_sha'], 'PR binding');
    if (!positive(state.pr.number) || !SHA40.test(state.pr.head_sha ?? '') ||
        !SHA40.test(state.pr.base_sha ?? '') ||
        !['open', 'closed', 'merged'].includes(state.pr.state) ||
        (state.pr.merged_sha != null && !SHA40.test(state.pr.merged_sha))) {
      reject('invalid PR binding');
    }
    if (state.thread.head_sha !== state.pr.head_sha) reject('Thread/PR HEAD mismatch');
  } else if (state.thread.head_sha != null) {
    reject('Thread HEAD without PR binding');
  }
  validateCi(state.ci, state);
  validateReview(state.review, state);
  validateFeedback(state.feedback, state);
  onlyKeys(state.budgets, ['infrastructure_retries', 'model_retries', 'repair_rounds'],
    'budgets');
  for (const key of ['infrastructure_retries', 'model_retries', 'repair_rounds']) {
    if (!nonNegative(state.budgets[key]) || state.budgets[key] > 1024) reject('invalid budget');
  }
  if (state.blocker != null) {
    onlyKeys(state.blocker, ['reason', 'evidence_ref', 'owner_action_required'], 'blocker');
    if (typeof state.blocker.reason !== 'string' || state.blocker.reason.length < 1 ||
        state.blocker.reason.length > 500 ||
        (state.blocker.evidence_ref != null &&
         (typeof state.blocker.evidence_ref !== 'string' ||
          state.blocker.evidence_ref.length > 500)) ||
        state.blocker.owner_action_required !== true) reject('invalid durable blocker');
    if (state.phase !== 'blocked') reject('blocker requires blocked phase');
  } else if (state.phase === 'blocked') {
    reject('blocked phase requires a durable reason');
  }
  if (state.cancellation != null) {
    onlyKeys(state.cancellation, ['reason', 'fenced_actions'], 'cancellation');
    if (typeof state.cancellation.reason !== 'string' || state.cancellation.reason.length < 1 ||
        state.cancellation.reason.length > 500 ||
        !Array.isArray(state.cancellation.fenced_actions) ||
        state.cancellation.fenced_actions.length > DEFAULT_CONFIG.max_actions ||
        state.cancellation.fenced_actions.some((id) => !HEX64.test(id ?? ''))) {
      reject('invalid cancellation');
    }
    if (state.phase !== 'cancelled') reject('cancellation requires cancelled phase');
  } else if (state.phase === 'cancelled') {
    reject('cancelled phase requires a cancellation record');
  }
  if (state.migration != null) {
    onlyKeys(state.migration, ['from_schema_version', 'from_version', 'from_digest',
      'from_phase', 'mapped_phase', 'legacy_order'], 'migration record');
    if (state.migration.from_schema_version !== 1 ||
        !positive(state.migration.from_version) ||
        !HEX64.test(state.migration.from_digest ?? '') ||
        !['ready', 'review', 'repair', 'quality', 'acceptance', 'waiting-merge',
          'post-merge-acceptance', 'done', 'blocked'].includes(state.migration.from_phase) ||
        !BUSINESS_PHASES.includes(state.migration.mapped_phase) ||
        !['reviewer_first', 'none'].includes(state.migration.legacy_order)) {
      reject('invalid migration record');
    }
    // The mapped phase is lineage only: after a later transition the current
    // phase is authoritative while the original migration record stays intact.
  }
  onlyKeys(state.start, ['authority_run_id', 'authorized_at'], 'start authority');
  if (!(positive(state.start.authority_run_id) ||
        (state.migration != null && state.start.authority_run_id === 0)) ||
      !positive(state.start.authorized_at)) {
    reject('invalid start authority');
  }
  if (state.wake != null) {
    onlyKeys(state.wake, ['source', 'reason', 'correlation_id', 'observed_at'], 'wake');
    if (!WAKE_SOURCES.includes(state.wake.source) ||
        typeof state.wake.reason !== 'string' || state.wake.reason.length < 1 ||
        state.wake.reason.length > 200 ||
        (state.wake.correlation_id != null &&
         (typeof state.wake.correlation_id !== 'string' ||
          state.wake.correlation_id.length > 200)) ||
        !positive(state.wake.observed_at)) reject('invalid wake record');
  }
  if (!Array.isArray(state.transitions) ||
      state.transitions.length > DEFAULT_CONFIG.max_transitions) reject('invalid transitions');
  const keys = new Set();
  for (const transition of state.transitions) {
    onlyKeys(transition, ['key', 'kind', 'outcome', 'action_id', 'run_id', 'attempt',
      'target_sha', 'evidence_generation', 'recorded_version'], 'transition');
    if (!HEX64.test(transition.key ?? '') || keys.has(transition.key) ||
        typeof transition.kind !== 'string' || transition.kind.length > 80 ||
        (transition.outcome != null && typeof transition.outcome !== 'string') ||
        (transition.action_id != null && !HEX64.test(transition.action_id)) ||
        (transition.run_id != null && !positive(transition.run_id)) ||
        (transition.attempt != null && !positive(transition.attempt)) ||
        (transition.target_sha != null && !SHA40.test(transition.target_sha)) ||
        (transition.evidence_generation != null &&
         !HEX64.test(transition.evidence_generation)) ||
        !positive(transition.recorded_version) ||
        transition.recorded_version > state.version + 1) {
      reject('invalid/duplicate transition');
    }
    keys.add(transition.key);
  }
  if (!Array.isArray(state.outbox) || state.outbox.length > DEFAULT_CONFIG.max_actions) {
    reject('invalid v2 outbox');
  }
  const seen = new Set();
  const active = state.outbox.filter((action) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(action.status));
  if (active.length > 1) {
    // A logical Thread executes one business action at a time. Parallel roles
    // are forbidden because the Reviewer must run after the CI barrier.
    reject('multiple active v2 actions');
  }
  for (const action of state.outbox) validateAction(action, state, seen);
  return state;
}

export function assertExecutionTransition(from, to, role = null) {
  // A local notification action has no external execution: it is committed in
  // the same atomic state write that creates it.
  if (role == null && from === 'pending' && to === 'committed') return;
  if (!EXECUTION_EDGES[from]?.includes(to)) {
    reject('illegal execution state transition: ' + from + ' -> ' + to);
  }
}

export function nextActionOrdinal(state, role, action) {
  return state.outbox.filter((entry) =>
    entry.role === role && entry.action === action).length + 1;
}

export function activeAction(state) {
  return state.outbox.find((entry) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(entry.status)) ?? null;
}

export function blocked(reason, evidenceRef = null) {
  return { reason, evidence_ref: evidenceRef, owner_action_required: true };
}
