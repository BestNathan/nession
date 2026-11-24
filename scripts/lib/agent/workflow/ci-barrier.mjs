// Issue #4482 — the CI barrier is the deterministic owner of "what CI evidence
// is required for this exact PR HEAD, and did it finish?".
//
// CI truth is never delegated to the model and a missing/unknown/cancelled
// check is never a pass. The barrier only classifies authenticated facts
// supplied by trusted observation code; it performs no GitHub access itself.
import { stableDigest, CI_STATUSES } from './contract.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const TERMINAL_FAILURES = new Set(['failure', 'timed_out']);
const TERMINAL_NON_SUCCESS = new Set(['cancelled', 'missing', 'unknown']);

function reject(message) {
  throw new Error('agent workflow ci-barrier: ' + message);
}
function onlyKeys(value, allowed, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) reject('invalid ' + label);
}

// The obligation is the frozen, sorted identity of the checks that MUST reach
// a terminal result for this exact HEAD. Proven not-applicable checks are
// excluded; an unknown applicability is retained (fail closed).
export function freezeCiObligation({ head_sha, checks }) {
  if (!SHA40.test(head_sha ?? '')) reject('invalid obligation HEAD');
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 128) {
    reject('invalid obligation checks');
  }
  const seen = new Set();
  const eligible = [];
  for (const check of checks) {
    onlyKeys(check, ['name', 'workflow', 'applicability', 'category', 'source_run_id',
      'source_attempt', 'required'], 'obligation check');
    if (typeof check.name !== 'string' || check.name.length < 1 || check.name.length > 200 ||
        typeof check.workflow !== 'string' || check.workflow.length < 1 ||
        check.workflow.length > 200 ||
        !['applicable', 'not_applicable', 'unknown'].includes(check.applicability) ||
        !['source', 'infrastructure'].includes(check.category) ||
        typeof check.required !== 'boolean') {
      reject('invalid obligation check');
    }
    if (!check.required) continue;
    if (check.applicability === 'not_applicable') continue;
    const key = check.workflow + '\u0000' + check.name;
    if (seen.has(key)) reject('duplicate obligation check');
    seen.add(key);
    eligible.push({
      name: check.name,
      workflow: check.workflow,
      applicability: check.applicability,
      category: check.category,
    });
  }
  if (!eligible.length) reject('empty applicable CI obligation');
  eligible.sort((a, b) =>
    (a.workflow + '\u0000' + a.name).localeCompare(b.workflow + '\u0000' + b.name));
  return {
    head_sha,
    obligation_sha256: stableDigest(['agent-workflow-v2-ci-obligation', head_sha, eligible]),
    checks: eligible,
  };
}

// Classify the snapshot for one frozen obligation.
//
// Priority is deliberate:
//   pending          -> still running, wait
//   missing          -> cancelled/unknown/absent evidence is NOT success
//   actionable_fail  -> at least one source-owned check failed
//   infrastructure   -> only infrastructure-owned checks failed; recover/retry
//   pass             -> every required check finished successfully
export function classifyCiResults({ obligation, head_sha, results, observed_at }) {
  if (!obligation || !HEX64.test(obligation.obligation_sha256 ?? '')) {
    reject('invalid frozen obligation');
  }
  if (obligation.head_sha !== head_sha) reject('CI results do not match the obligation HEAD');
  if (!Array.isArray(results)) reject('invalid CI results');
  if (results.length > 256) reject('CI result bound exceeded');
  const byKey = new Map();
  for (const result of results) {
    onlyKeys(result, ['name', 'workflow', 'conclusion', 'evidence_ref'], 'CI result');
    if (typeof result.name !== 'string' || typeof result.workflow !== 'string' ||
        !['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped',
          'pending', 'missing', 'unknown'].includes(result.conclusion) ||
        (result.evidence_ref != null &&
         (typeof result.evidence_ref !== 'string' || result.evidence_ref.length > 500))) {
      reject('invalid CI result');
    }
    const key = result.workflow + '\u0000' + result.name;
    if (byKey.has(key)) reject('duplicate CI result');
    byKey.set(key, result);
  }
  const checks = [];
  let pending = false;
  let missing = false;
  let actionable = false;
  let infrastructure = false;
  for (const required of obligation.checks) {
    const key = required.workflow + '\u0000' + required.name;
    const observed = byKey.get(key);
    const conclusion = observed?.conclusion ?? 'missing';
    checks.push({
      name: required.name,
      workflow: required.workflow,
      conclusion,
      applicability: required.applicability,
      evidence_ref: observed?.evidence_ref ?? null,
    });
    if (conclusion === 'pending') pending = true;
    else if (TERMINAL_NON_SUCCESS.has(conclusion)) missing = true;
    else if (TERMINAL_FAILURES.has(conclusion)) {
      if (required.category === 'infrastructure') infrastructure = true;
      else actionable = true;
    } else if (conclusion === 'success' || conclusion === 'neutral' ||
               conclusion === 'skipped') {
      // `skipped` is accepted ONLY because the obligation excluded proven
      // not-applicable checks; an applicable required job that skipped is
      // rejected below.
      if (conclusion === 'skipped' && required.applicability !== 'not_applicable') missing = true;
    } else {
      missing = true;
    }
  }
  const status = pending ? 'pending' :
    missing ? 'missing' :
    actionable ? 'actionable_fail' :
    infrastructure ? 'infrastructure' : 'pass';
  if (!CI_STATUSES.includes(status)) reject('internal CI status');
  return {
    head_sha,
    obligation_sha256: obligation.obligation_sha256,
    status,
    digest: stableDigest(['agent-workflow-v2-ci-digest', head_sha,
      obligation.obligation_sha256, checks]),
    checks,
    observed_at,
  };
}

// A rerun that materially changes the accepted evidence for the same HEAD is a
// new evidence generation. Callers must invalidate the old aggregate instead of
// mixing results from two generations.
export function sameEvidenceGeneration(previous, next) {
  if (previous == null || next == null) return false;
  return previous.head_sha === next.head_sha &&
    previous.obligation_sha256 === next.obligation_sha256 &&
    previous.digest === next.digest;
}
