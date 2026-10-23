import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z][a-z0-9-]{1,80}$/;
const PHASES = new Set(['ready', 'review', 'repair', 'quality', 'acceptance', 'waiting-merge', 'post-merge-acceptance', 'done', 'blocked']);
const OUTCOMES = {
  developer: new Set(['implementation_ready']),
  // A publication is host-attested, never model-supplied: the caller proves the
  // Publisher Run produced the exact PR head before offering this event.
  publisher: new Set(['published']),
  reviewer: new Set(['approved', 'changes_requested']),
  quality: new Set(['passed', 'failed']),
  acceptance: new Set(['passed', 'failed', 'pending']),
  merge: new Set(['completed']),
};
function reject(message) { throw new Error('agent orchestration: ' + message); }
function integer(v) { return Number.isInteger(v) && v > 0; }
function eventKey(e) {
  return createHash('sha256').update([e.kind, e.issue, e.run_id, e.run_attempt, e.target_sha, e.outcome].join(':')).digest('hex');
}

// The caller authenticates trusted evidence from the actual workflow run.
// Neither Issue comment content nor the model chooses the next role.
export function advanceWorkflow(state, event, trusted, config = {}) {
  if (!trusted || trusted.workflow_run_id !== event?.run_id ||
      trusted.attempt !== event?.run_attempt || trusted.issue !== event?.issue ||
      trusted.source_sha !== event?.target_sha || trusted.role !== event?.kind) {
    reject('untrusted source provenance');
  }
  if (!integer(event.issue) || !integer(event.run_id) || !integer(event.run_attempt) ||
      !SHA.test(event.target_sha ?? '') || !OUTCOMES[event.kind]?.has(event.outcome)) {
    reject('invalid event envelope');
  }
  if (Object.hasOwn(event, 'next_role') || Object.hasOwn(event, 'nextRole')) reject('model cannot select the next role');
  if (event.reviewer_agent_id != null) {
    // An owner-authorized publication may bind a different registered
    // Reviewer. The outbox acceptance validates that identity against the
    // registry before this policy records it.
    if (event.kind !== 'publisher') reject('reviewer binding only applies to publication');
    if (!ID.test(event.reviewer_agent_id)) reject('invalid replacement reviewer');
  }
  const current = state ?? { issue: event.issue, phase: 'ready', target_sha: null, repair_attempts: 0, transitions: [] };
  if (!PHASES.has(current.phase) || current.issue !== event.issue || !Array.isArray(current.transitions)) reject('invalid current state');
  const key = eventKey(event);
  const prior = current.transitions.find((x) => x.key === key);
  if (prior) {
    if ((prior.reviewer_agent_id ?? null) !== (event.reviewer_agent_id ?? null))
      reject('conflicting reviewer replay');
    return { state: current, actions: [], duplicate: true };
  }
  const next = { ...current, transitions: [...current.transitions] };
  const maxRepairs = config.max_repairs ?? 3;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) reject('invalid retry policy');
  let actions;
  if (event.kind === 'developer' && event.outcome === 'implementation_ready' &&
      ['ready', 'repair'].includes(current.phase)) {
    next.phase = 'review';
    next.target_sha = event.target_sha;
    actions = [{ type: 'dispatch', role: 'reviewer', task: 'review', sha: event.target_sha }];
  } else if (event.kind === 'publisher' && event.outcome === 'published' &&
      current.phase === 'ready' && current.target_sha == null) {
    // The trusted provenance for a publication binds the Publisher Run to the
    // published PR head, not to that Run's own main checkout SHA. The handoff
    // policy therefore transitions to review only; it never infers a role or a
    // second PR from the result. An owner-authorized override changes the
    // recorded Reviewer assignment before the dispatch action is materialized.
    if (event.reviewer_agent_id != null) {
      if (!current.assignments || typeof current.assignments.reviewer !== 'string')
        reject('replacement reviewer requires an initialized assignment');
      next.assignments = { ...current.assignments, reviewer: event.reviewer_agent_id };
    }
    next.phase = 'review';
    next.target_sha = event.target_sha;
    actions = [{ type: 'dispatch', role: 'reviewer', task: 'review', sha: event.target_sha }];
  } else if (event.kind === 'reviewer' && current.phase === 'review' && current.target_sha === event.target_sha) {
    if (event.outcome === 'changes_requested') {
      next.repair_attempts++;
      next.phase = next.repair_attempts > maxRepairs ? 'blocked' : 'repair';
      actions = next.phase === 'blocked' ? [{ type: 'notify', reason: 'repair_limit' }] :
        [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }];
    } else {
      next.phase = 'quality';
      actions = [{ type: 'verify', gate: 'quality', sha: event.target_sha }];
    }
  } else if (event.kind === 'quality' && current.phase === 'quality' && current.target_sha === event.target_sha) {
    if (event.outcome === 'passed') {
      next.phase = 'acceptance';
      // Existing Acceptance Orchestrator selects each SC by target and proof method.
      actions = [{ type: 'verify', gate: 'sc-acceptance', when: 'pr', sha: event.target_sha }];
    } else {
      next.repair_attempts++;
      next.phase = next.repair_attempts > maxRepairs ? 'blocked' : 'repair';
      actions = next.phase === 'blocked' ? [{ type: 'notify', reason: 'repair_limit' }] :
        [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }];
    }
  } else if (event.kind === 'acceptance' && current.phase === 'acceptance' && current.target_sha === event.target_sha) {
    if (event.outcome === 'failed') next.repair_attempts++;
    next.phase = event.outcome === 'passed' ? 'waiting-merge' :
      event.outcome === 'failed' && next.repair_attempts <= maxRepairs ? 'repair' : 'blocked';
    actions = event.outcome === 'passed' ? [{ type: 'notify', reason: 'requires_authorized_merge' }] :
      next.phase === 'repair' ? [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }] :
      [{ type: 'notify', reason: event.outcome === 'pending' ? 'acceptance_pending' : 'repair_limit' }];
  } else if (event.kind === 'merge' && current.phase === 'waiting-merge' &&
      event.outcome === 'completed') {
    next.phase = 'post-merge-acceptance';
    next.merged_sha = event.target_sha;
    next.target_sha = event.target_sha;
    actions = [{ type: 'verify', gate: 'sc-acceptance', when: 'merged', sha: event.target_sha }];
  } else if (event.kind === 'acceptance' && current.phase === 'post-merge-acceptance' &&
      current.target_sha === event.target_sha) {
    next.phase = event.outcome === 'passed' ? 'done' : 'blocked';
    actions = event.outcome === 'passed' ? [] :
      [{ type: 'notify', reason: event.outcome === 'pending' ? 'merged_acceptance_pending' : 'merged_acceptance_failed' }];
  } else {
    reject('stale SHA or illegal state transition: ' + current.phase + ' / ' + event.kind);
  }
  next.transitions.push({ key, kind: event.kind, run_id: event.run_id, attempt: event.run_attempt,
    target_sha: event.target_sha, outcome: event.outcome,
    ...(event.reviewer_agent_id != null ? { reviewer_agent_id: event.reviewer_agent_id } : {}) });
  return { state: next, actions, duplicate: false };
}

export function authorizeCommentCommand(comment, authorPermission) {
  if (!['admin', 'maintain', 'write'].includes(authorPermission)) reject('comment author lacks repository write authority');
  const match = /^\/agent (resume developer|review)$/.exec(comment?.trim() ?? '');
  if (!match) reject('unsupported comment command');
  return { command: match[1] === 'review' ? 'review' : 'resume', role: match[1] === 'review' ? 'reviewer' : 'developer' };
}
