#!/usr/bin/env node
// Trusted verification tier vocabulary and risk floor. Labels are intentions,
// never CI/SC verdicts; a mutable Issue label is not a signed execution ticket.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const VERIFICATION_TIERS = Object.freeze([
  'verification:scoped',
  'verification:integration',
  'verification:full',
]);
const RANK = Object.freeze({
  'verification:scoped': 1,
  'verification:integration': 2,
  'verification:full': 3,
});
const SHA = /^[0-9a-f]{40}$/;
// Container build context and deployment runtime inputs are explicitly L2,
// not unaudited unknown paths. Keep root Dockerfile variants narrow.
const DEPLOYMENT_INPUT = /^(?:deploy\/|Dockerfile(?:\.[A-Za-z0-9_-]+)*$)/;

function names(issue) {
  return (issue?.labels ?? []).map(label =>
    typeof label === 'string' ? label : label?.name).filter(Boolean);
}

// Legacy Issues without a tier remain valid. Multiple tiers are *not* a default.
export function readVerificationTier(issue) {
  const hits = names(issue).filter(label => Object.hasOwn(RANK, label));
  if (hits.length > 1) throw new Error('conflicting verification tier labels: ' + hits.join(', '));
  return { tier: hits[0] ?? VERIFICATION_TIERS[0], explicit: hits.length === 1 };
}

export function combineVerificationTiers(...tiers) {
  if (!tiers.length || tiers.some(t => !Object.hasOwn(RANK, t))) {
    throw new Error('invalid verification tier');
  }
  return tiers.reduce((a,b) => RANK[a] >= RANK[b] ? a : b);
}

// This is a minimum impact floor, not a replacement for Issue E2E selection.
// Unknown paths require an Audit review; they must not produce "not required".
export function assessChangedPaths(paths) {
  if (!Array.isArray(paths) || !paths.length ||
      paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('..'))) {
    throw new Error('unverified changed paths');
  }
  let floor = VERIFICATION_TIERS[0];
  const reasons = [];
  const components = new Set();
  let unknown = false;
  for (const p of paths) {
    // Repository documentation is not a runtime/build input wherever it lives.
    // The canonical instruction files include `.github/AGENTS.md` (with its
    // CLAUDE.md compatibility link); leaving them unclassified made every
    // merged PR that touched scope guidance fail the merge-selection audit
    // even though it could not affect E2E (#2478).
    if (/^(docs\/|\.claude\/|README\.md$|CHANGELOG\.md$|\.github\/[^/]+\.md$)/.test(p)) continue;
    if (/^crates\/nession-(agent|server|protocol|common)\//.test(p)) {
      components.add('agent-server-protocol');
    } else if (/^web\//.test(p)) {
      components.add('web');
    } else if (/^e2e\//.test(p)) {
      components.add('e2e');
    } else if (/^pages\//.test(p)) {
      // The public Pages app is its own runtime/build component (#1782).
      components.add('pages');
    } else if (DEPLOYMENT_INPUT.test(p)) {
      components.add('deployment');
    } else if (/^\.github\/workflows\//.test(p)) {
      components.add('workflow');
    } else if (/^(scripts\/|gates\/|automation\/|Cargo\.|justfile$)/.test(p)) {
      components.add('build-policy');
    } else if (/^crates\//.test(p)) {
      components.add('rust');
    } else {
      unknown = true;
    }
    if (DEPLOYMENT_INPUT.test(p) ||
      /^(crates\/nession-(protocol|common)\/|scripts\/(issue-e2e|acceptance-|requirement-acceptance)|e2e\/runner\/|\.github\/workflows\/(e2e-|acceptance-|ci-quality))/.test(p)) {
      floor = VERIFICATION_TIERS[1];
      reasons.push('shared-contract-or-test-infrastructure:' + p);
    }
  }
  if (components.size > 1) {
    floor = VERIFICATION_TIERS[1];
    reasons.push('cross-component-diff');
  }
  if (unknown) {
    floor = VERIFICATION_TIERS[1];
    reasons.push('unclassified-change-requires-audit');
  }
  return { floor, reasons: [...new Set(reasons)], components: [...components].sort(), needsAudit: unknown };
}

// A parent L3 Issue does NOT infect a small child merely mentioned by "Refs".
// A full parent gate becomes due only on an explicit closing/milestone action.
export function planVerification({ issues = [], closingIssueNumbers = [], changedPaths,
  audit = null, fullMilestone = false } = {}) {
  const impact = assessChangedPaths(changedPaths);
  const closing = new Set(closingIssueNumbers);
  const tiers = [impact.floor];
  const fullIssues = [];
  for (const issue of issues) {
    const { tier } = readVerificationTier(issue);
    if (tier === VERIFICATION_TIERS[2]) {
      if (closing.has(issue.number) && fullMilestone) {
        fullIssues.push(issue.number);
        tiers.push(tier);
      }
    } else {
      tiers.push(tier);
    }
  }
  // Audit result is only a *proposal*. Its caller must authenticate the SHA,
  // source run/attempt, issue binding and policy digest before trusting it.
  if (audit != null) {
    if (!audit.verified || !SHA.test(audit.target_sha ?? '') ||
        !Object.hasOwn(RANK, audit.tier)) {
      throw new Error('unverified verification audit');
    }
    if (audit.tier === VERIFICATION_TIERS[2]) {
      if (audit.fullApproved === true) tiers.push(audit.tier);
      else tiers.push(VERIFICATION_TIERS[1]);
    } else tiers.push(audit.tier);
  }
  const effectiveTier = combineVerificationTiers(...tiers);
  return {
    schema_version: 1, effective_tier: effectiveTier, changed_path_floor: impact.floor,
    reasons: impact.reasons, components: impact.components,
    needs_audit: impact.needsAudit && !audit,
    full_required: fullIssues.length > 0 || audit?.fullApproved === true && audit.tier === VERIFICATION_TIERS[2],
    full_issue_numbers: fullIssues.sort((a,b) => a-b),
  };
}

function selfTest() {
  const issue = (number, label) => ({ number, labels: label ? [{name:label}] : [] });
  assert.deepEqual(readVerificationTier(issue(1)), { tier: 'verification:scoped', explicit: false });
  assert.equal(readVerificationTier(issue(2, VERIFICATION_TIERS[2])).tier, VERIFICATION_TIERS[2]);
  assert.throws(() => readVerificationTier({labels: VERIFICATION_TIERS}), /conflicting/);
  assert.equal(assessChangedPaths(['crates/nession-agent/src/a.rs']).floor, VERIFICATION_TIERS[0]);
  assert.equal(assessChangedPaths(['crates/nession-agent/src/a.rs','web/src/App.tsx']).floor, VERIFICATION_TIERS[1]);
  assert.equal(assessChangedPaths(['.github/workflows/acceptance-cases.yml']).floor, VERIFICATION_TIERS[1]);
  // #2566: all root Dockerfile variants and canonical deploy scripts are
  // known high-risk build/deploy inputs, not no-op metadata or unknowns.
  const deployment = [
    'Dockerfile.agent', 'Dockerfile.agent.prebuilt',
    'Dockerfile.server', 'Dockerfile.server.prebuilt',
    'deploy/docker-compose.yml', 'deploy/entrypoint-agent.sh',
    'deploy/entrypoint-server.sh', 'deploy/render-server-config.sh',
  ];
  for (const p of deployment) {
    const outcome = assessChangedPaths([p]);
    assert.equal(outcome.needsAudit, false, p);
    assert.equal(outcome.floor, VERIFICATION_TIERS[1], p);
    assert.deepEqual(outcome.components, ['deployment'], p);
  }
  assert.equal(assessChangedPaths([...deployment,'web/src/terminalConfig.ts']).needsAudit, false);
  assert.equal(assessChangedPaths(['Dockerfile.unknown/child']).needsAudit, true);
  assert.throws(() => assessChangedPaths(['deploy/../untrusted']), /unverified/);
  assert.equal(assessChangedPaths(['container/Dockerfile.server']).needsAudit, true);
  assert.equal(assessChangedPaths(['pages/scripts/build.mjs']).needsAudit, false);
  assert.deepEqual(assessChangedPaths(['pages/scripts/build.mjs']).components,['pages']);
  assert.equal(assessChangedPaths(['pages/scripts/build.mjs','e2e/helpers/pagesStandalone.ts']).floor,
    VERIFICATION_TIERS[1]);
  assert.equal(assessChangedPaths(['unmapped/file']).needsAudit, true);
  // Scope documentation under .github/ is documentation, not an audited path.
  assert.equal(assessChangedPaths(['.github/AGENTS.md']).needsAudit, false);
  assert.deepEqual(assessChangedPaths(['.github/AGENTS.md']).components, []);
  assert.equal(assessChangedPaths(['.github/AGENTS.md', '.github/CLAUDE.md']).floor,
    VERIFICATION_TIERS[0]);
  // Non-documentation governance files still fail closed.
  assert.equal(assessChangedPaths(['.github/CODEOWNERS']).needsAudit, true);
  assert.equal(assessChangedPaths(['.github/ISSUE_TEMPLATE/bug.md']).needsAudit, true);
  assert.throws(() => assessChangedPaths([]), /unverified/);
  const parent = issue(1645, VERIFICATION_TIERS[2]);
  const child = issue(1953, VERIFICATION_TIERS[0]);
  const base = { issues:[parent,child], changedPaths:['web/src/Terminal.tsx'] };
  assert.equal(planVerification(base).full_required, false);
  assert.equal(planVerification({...base,closingIssueNumbers:[1645]}).full_required, false);
  assert.equal(planVerification({...base,closingIssueNumbers:[1645],fullMilestone:true}).full_required, true);
  assert.equal(planVerification({...base,closingIssueNumbers:[1953],fullMilestone:true}).full_required, false);
  assert.throws(() => planVerification({...base,audit:{tier:'verification:scoped',verified:false,target_sha:'a'.repeat(40)}}), /unverified/);
  const verified = {tier:'verification:full',verified:true,target_sha:'a'.repeat(40)};
  assert.equal(planVerification({...base,audit:verified}).full_required, false);
  assert.equal(planVerification({...base,audit:{...verified,fullApproved:true}}).full_required, true);
  assert.equal(combineVerificationTiers(VERIFICATION_TIERS[0],VERIFICATION_TIERS[1]),VERIFICATION_TIERS[1]);
  console.log('verification-tier-policy: conflict, scoped defaults, risk floor, full milestone and audit negatives passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'self-test') throw new Error('usage: verification-tier-policy.mjs self-test');
  selfTest();
}
