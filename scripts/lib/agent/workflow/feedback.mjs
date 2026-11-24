// Issue #4482 — one immutable feedback bundle per exact PR HEAD, CI evidence
// generation and accepted Reviewer result. The Developer is resumed ONCE with
// this bundle; CI-triggered and Review-triggered repairs are never split.
import { stableDigest } from './contract.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function reject(message) {
  throw new Error('agent workflow feedback: ' + message);
}

function ciFindings(ci) {
  if (ci == null) return [];
  const findings = [];
  for (const check of ci.checks ?? []) {
    if (check.conclusion === 'failure' || check.conclusion === 'timed_out') {
      findings.push({
        id: 'ci:' + check.workflow + ':' + check.name,
        severity: 'blocking',
        category: 'ci',
        message: check.workflow + ' / ' + check.name + ' concluded ' + check.conclusion +
          (check.evidence_ref ? ' (' + check.evidence_ref + ')' : ''),
        file: null,
        sc: null,
      });
    }
  }
  return findings;
}

function dedupeFindings(findings) {
  const byId = new Map();
  for (const finding of findings) {
    const prior = byId.get(finding.id);
    if (!prior) {
      byId.set(finding.id, finding);
      continue;
    }
    if (prior.severity !== finding.severity ||
        prior.category !== finding.category ||
        prior.message !== finding.message) {
      // Distinct findings must carry distinct stable IDs; silently collapsing
      // them would hide a real blocker from the repair round.
      reject('conflicting findings share the stable ID ' + finding.id);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Build the single repair bundle. `review` is the accepted read-only Reviewer
// result; `ci` is the accepted CI evidence; `acceptance` may carry an
// actionable acceptance failure. Nonblocking suggestions are recorded by the
// Reviewer but never become repair gates.
export function buildFeedbackBundle({
  issue, pr, head_sha, ci = null, review = null, acceptance = null,
  prior = null, repair_round,
}) {
  if (!Number.isSafeInteger(issue) || issue < 1) reject('invalid Issue');
  if (!Number.isSafeInteger(pr) || pr < 1) reject('invalid PR');
  if (!SHA40.test(head_sha ?? '')) reject('invalid feedback HEAD');
  if (!Number.isSafeInteger(repair_round) || repair_round < 1 || repair_round > 32) {
    reject('invalid repair round');
  }
  const sources = [];
  const findings = [];
  let ciDigest = null;
  let reviewDigest = null;
  if (ci != null) {
    if (!HEX64.test(ci.digest ?? '')) reject('invalid CI evidence digest');
    if (ci.head_sha !== head_sha) reject('CI evidence for another HEAD');
    sources.push('ci');
    ciDigest = ci.digest;
    findings.push(...ciFindings(ci));
  }
  if (review != null) {
    if (!HEX64.test(review.digest ?? '')) reject('invalid Review digest');
    if (review.head_sha !== head_sha) reject('Review evidence for another HEAD');
    if (!['approved', 'changes_requested'].includes(review.outcome)) {
      reject('Review has no accepted outcome');
    }
    sources.push('review');
    reviewDigest = review.digest;
    for (const finding of review.findings ?? []) {
      if (finding.severity !== 'blocking') continue;
      findings.push({
        id: 'review:' + finding.id,
        severity: 'blocking',
        category: finding.category,
        message: finding.message,
        file: finding.file ?? null,
        sc: finding.sc ?? null,
      });
    }
  }
  if (acceptance != null) {
    if (!HEX64.test(acceptance.digest ?? '')) reject('invalid acceptance digest');
    if (acceptance.head_sha !== head_sha) reject('acceptance evidence for another HEAD');
    sources.push('acceptance');
    const failed = Array.isArray(acceptance.failed_criteria) ?
      acceptance.failed_criteria : [];
    for (const criterion of failed) {
      if (!/^SC-[0-9]{2}$/.test(criterion ?? '')) reject('invalid failed criterion');
      findings.push({
        id: 'acceptance:' + criterion,
        severity: 'blocking',
        category: 'acceptance',
        message: 'Acceptance criterion ' + criterion + ' is not proven at ' + head_sha,
        file: null,
        sc: criterion,
      });
    }
    if (!failed.length) {
      findings.push({
        id: 'acceptance:pr',
        severity: 'blocking',
        category: 'acceptance',
        message: 'PR Acceptance failed for ' + head_sha,
        file: null,
        sc: null,
      });
    }
  }
  if (!sources.length) reject('feedback bundle requires a result source');
  sources.sort();
  const merged = dedupeFindings(findings);
  const priorFindingIds = Array.isArray(prior?.finding_ids) ? prior.finding_ids : [];
  const missingPrior = priorFindingIds.filter((id) =>
    !merged.some((finding) => finding.id === id));
  // A prior unresolved finding stays visible unless the current evidence
  // explicitly re-bound it; the bundle is additive history, not a reset.
  for (const id of missingPrior) {
    if (typeof id !== 'string' || id.length > 200) reject('invalid prior finding ID');
  }
  const content = {
    kind: 'agent_workflow_v2_feedback',
    issue,
    pr,
    head_sha,
    ci_digest: ciDigest,
    review_digest: reviewDigest,
    parent_sha256: prior?.bundle_sha256 ?? null,
    repair_round,
    sources,
    findings: merged,
    prior_finding_ids: missingPrior,
  };
  const bundleSha = stableDigest(content);
  return {
    bundle_sha256: bundleSha,
    head_sha,
    ci_digest: ciDigest,
    review_digest: reviewDigest,
    parent_sha256: prior?.bundle_sha256 ?? null,
    repair_round,
    finding_ids: [...new Set([...merged.map((finding) => finding.id), ...missingPrior])],
    sources,
  };
}

// Explicitly forbid two repair actions for one evaluation. The decision engine
// calls this before materializing Developer work.
export function assertSingleRepairIntent(intents) {
  const repairs = intents.filter((intent) =>
    intent.type === 'dispatch' && intent.role === 'developer' && intent.action === 'repair');
  if (repairs.length > 1) reject('two repair actions for one evaluation');
  return repairs[0] ?? null;
}
