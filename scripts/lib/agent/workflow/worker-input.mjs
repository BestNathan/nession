// Issue #4528 — signed Developer repair input.
//
// Reconcile owns the decision; this module renders the one input a resumed
// Developer is allowed to receive. It binds the exact Thread/checkpoint, the
// immutable feedback bundle, BOTH CI and Review receipts (including the passed
// side), prior unresolved findings and the signed repair intent. It never
// schedules a repair, launches a model or holds a credential.
import { activeAction, stableDigest, validateLifecycleState } from './contract.mjs';
import { verifyFeedbackBundle } from './feedback.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[a-f0-9]{64,256}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{1,80}$/;
const MAX_BYTES = 256 * 1024;

function reject(message) {
  throw new Error('agent workflow worker-input: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateCheckpoint(checkpoint) {
  if (checkpoint == null) return null;
  if (!positive(checkpoint.version) || !SHA40.test(checkpoint.commit_sha ?? '') ||
      !HEX64.test(checkpoint.ciphertext_sha256 ?? '') ||
      !(checkpoint.native_session_id == null ||
        (typeof checkpoint.native_session_id === 'string' &&
         checkpoint.native_session_id.length > 0 &&
         checkpoint.native_session_id.length <= 256))) {
    reject('invalid checkpoint reference');
  }
  // The native provider session identity stays with the trusted dispatch
  // composition. The worker receives the exact commit/ciphertext binding and
  // the fact that the checkpoint is session-bound.
  return {
    version: checkpoint.version,
    commit_sha: checkpoint.commit_sha,
    ciphertext_sha256: checkpoint.ciphertext_sha256,
    session_bound: checkpoint.native_session_id != null,
  };
}

// `signer` is a trusted injected port (the existing dispatch-ticket owner in a
// real composition). It receives the exact canonical payload and returns an
// authenticated signature plus its signer identity. This module does not
// invent a second signing scheme.
export function renderRepairWorkerInput({ state, action_id = null, signer, max_bytes = MAX_BYTES }) {
  validateLifecycleState(state);
  if (typeof signer !== 'function') reject('trusted repair signer required');
  if (!Number.isSafeInteger(max_bytes) || max_bytes < 1024 || max_bytes > MAX_BYTES) {
    reject('invalid worker-input bound');
  }
  const action = action_id == null ? activeAction(state) :
    state.outbox.find((entry) => entry.id === action_id) ?? null;
  if (action == null) reject('no repair action');
  if (action.role !== 'developer' || action.action !== 'repair') {
    reject('worker input requires a Developer repair action');
  }
  if (action.status !== 'pending') reject('repair action is not pending');
  if (action.resume !== true) reject('repair action must resume the same Thread');
  if (state.pr == null || state.thread.head_sha == null) reject('repair without a published PR');
  if (action.sha !== state.thread.head_sha || state.pr.head_sha !== action.sha) {
    reject('repair input for a stale PR HEAD');
  }
  const feedback = state.feedback;
  if (feedback == null) reject('repair without an accepted feedback bundle');
  if (feedback.head_sha !== action.sha) reject('feedback HEAD differs from the repair HEAD');
  if (action.feedback_sha256 !== feedback.bundle_sha256) {
    reject('repair action does not bind the accepted feedback bundle');
  }
  const content = verifyFeedbackBundle({
    bundle: feedback, issue: state.issue, pr: state.pr.number,
  });
  if (state.ci == null || state.review == null) {
    reject('repair requires both CI and Review receipts');
  }
  if (!feedback.sources.includes('ci') || !feedback.sources.includes('review') ||
      feedback.ci_digest == null || feedback.review_digest == null) {
    reject('feedback bundle must carry both CI and Review receipts');
  }
  if (feedback.ci_digest !== state.ci.digest || feedback.review_digest !== state.review.digest) {
    reject('feedback receipts differ from the accepted evidence');
  }
  if (state.ci.head_sha !== action.sha || state.review.head_sha !== action.sha) {
    reject('feedback evidence is bound to another HEAD');
  }
  if (state.ci.status !== 'pass' && state.ci.status !== 'actionable_fail') {
    reject('feedback CI evidence is not terminal');
  }
  for (const finding of content.findings) {
    if (finding.severity !== 'blocking') {
      reject('nonblocking findings cannot enter a repair gate');
    }
  }
  const payload = {
    schema_version: 1,
    kind: 'agent_workflow_v2_repair_input',
    issue: state.issue,
    pr: state.pr.number,
    base_sha: state.pr.base_sha,
    head_sha: action.sha,
    thread_id: state.thread.id,
    fencing_generation: state.thread.fencing_generation,
    action_id: action.id,
    predecessor: action.predecessor,
    repair_round: feedback.repair_round,
    resume: true,
    checkpoint: validateCheckpoint(state.thread.checkpoint),
    ci: {
      status: state.ci.status,
      digest: state.ci.digest,
      obligation_sha256: state.ci.obligation_sha256,
      checks: state.ci.checks,
    },
    review: {
      outcome: state.review.outcome,
      digest: state.review.digest,
      run_id: state.review.run_id,
      attempt: state.review.attempt,
      findings: state.review.findings,
    },
    feedback: {
      bundle_sha256: feedback.bundle_sha256,
      sources: feedback.sources,
      parent_sha256: feedback.parent_sha256,
      findings: content.findings,
      prior_finding_ids: feedback.prior_finding_ids,
      finding_ids: feedback.finding_ids,
    },
  };
  const intentSha256 = stableDigest(payload);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > max_bytes) reject('worker input exceeds bound');
  const signed = signer({
    payload: Object.freeze(JSON.parse(serialized)),
    intent_sha256: intentSha256,
    state,
    action,
  });
  if (signed == null || typeof signed !== 'object' ||
      !SIGNATURE.test(signed.signature ?? '') ||
      !AGENT_ID.test(signed.signer_id ?? '')) {
    reject('invalid repair signature');
  }
  return {
    ...payload,
    intent_sha256: intentSha256,
    signature: signed.signature,
    signer_id: signed.signer_id,
  };
}
