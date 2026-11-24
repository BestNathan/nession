#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAcceptancePlan, isProofEligible, deploymentProofEligible, canonicalAcceptanceStage } from './acceptance-plan.mjs';
import { parseAcceptanceSources } from './acceptance-sources.mjs';
import { deploymentRecord } from '../e2e/acceptance/evaluator/run-case.mjs';
import { normalizeAcceptanceResult, normalizeCriterion } from './acceptance-result-contract.mjs';
import {enforceLiveFullFailure,requiresLiveFullFailureProof} from './acceptance-main-full-failure-bug-evidence.mjs';
import { explicitlyImplementsIssue, isMainMergeAncestorOfStaging,
  independentReplacementContract, independentReplacementSourceEvidence,
} from './issue-lifecycle-reconcile.mjs';
import { verifiedIssueAuditCriterion, verifiedIssueAudit3843Criterion, SIDEBAR_AUDIT_REPAIR_PROOF, ISSUE_AUDIT_3843_PROOF } from './acceptance-issue-audit-readback.mjs';
import { verified4342AuditCriterion } from './acceptance-4342-metrics-evidence.mjs';
import { verified4342DownstreamCriterion } from './acceptance-4342-downstream-evidence.mjs';
import { verified4342HistoryCriterion } from './acceptance-4342-historical-evidence.mjs';
import {
  collectPrWebQuality, collectPrToolingQuality, collectPrRustQuality,
  enforcePrWebQuality, enforcePrRustQuality, requiresWebIntegrationExecution,
  requiresPrToolingEvidence, requiresPrRustQualityEvidence,
  requiresExactHeadRustQuality, validWebQualityReceipt, validRustQualityReceipt,
  collectPrRequiredQuality, validPrRequiredQualityReceipt, enforcePrRequiredQuality,
  requiresPrRequiredQualityEvidence,
} from './acceptance-pr-web-quality-receipt.mjs';
import { acceptanceModelView } from './lib/agent/tasks/acceptance.mjs';
import {enforceConvergenceWriter4059,mayProjectConvergenceWriter4059}
  from './acceptance-convergence-writer-4137.mjs';


import {collectPrCiTriad, requiresPrCiTriad, requiresPrVisualEvidenceCriterion,
  validPrCiTriadReceipt, enforcePrCiTriad, selfTestPrCiTriad}
  from './acceptance-pr-ci-triad.mjs';
import {validPagesMigrationReceipt}
  from './acceptance-pr-pages-migration-evidence.mjs';

export { normalizeAcceptanceResult };
import {
  extractSection,
  isAcceptanceIssue,
  parseAcceptanceReport,
  parseSuccessCriteria,
  validateRequirementBody,
} from './requirement-acceptance.mjs';

const STAGES = new Set(['pr', 'staging', 'post-merge']);

function stageOf(value) {
  const stage = canonicalAcceptanceStage(String(value ?? '').trim().toLowerCase());
  if (!STAGES.has(stage)) throw new Error('unsupported acceptance stage: ' + (value || '(empty)'));
  return stage;
}

function runIdOf(value) {
  const runId = Number(value);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('acceptance run id must be a positive integer');
  return runId;
}

function parseContract(body) {
  const success = parseSuccessCriteria(extractSection(body, 'Success Criteria'));
  const report = parseAcceptanceReport(extractSection(body, 'Acceptance Report'));
  const errors = [...success.errors, ...report.errors];
  for (const criterion of success.criteria.values()) {
    const row = report.rows.get(criterion.id);
    if (!row) errors.push(criterion.id + ' has no Acceptance Report row');
    else if (!STAGES.has(canonicalAcceptanceStage(row.stage))) errors.push(criterion.id + ' has unsupported acceptance stage ' + row.stage);
  }
  for (const row of report.rows.values()) {
    if (!success.criteria.has(row.id)) errors.push('Acceptance Report contains unknown criterion ' + row.id);
  }
  const acceptedPlan = validateAcceptancePlan(body, success.criteria.keys(), report.rows);
  errors.push(...acceptedPlan.errors);
  if (errors.length) throw new Error('invalid acceptance contract:\n- ' + errors.join('\n- '));
  const sources = parseAcceptanceSources(body, success.criteria.keys(), acceptedPlan.plan);
  return { criteria: success.criteria, rows: report.rows, plan: acceptedPlan.plan, sources };
}

function contractDigest(contract) {
  const canonical = [...contract.criteria.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      // Maintain the pre-v3 digest identity for previously authored PR Plans
      // without emitting the old stage in new acceptance contexts or records.
      stage: contract.plan?.get(criterion.id)?.when === 'pr' &&
        contract.rows.get(criterion.id).stage === 'pr'
        ? 'pre-merge' : contract.rows.get(criterion.id).stage,
      ...(contract.plan ? {
        acceptance_plan: contract.plan.get(criterion.id),
      } : {}),
    }));
  // No declaration must retain the historical digest byte-for-byte.
  const payload = contract.sources ? { criteria: canonical, acceptance_sources: contract.sources } : canonical;
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildAcceptanceContext(issue, stage, options = {}) {
  const normalizedStage = stageOf(stage);
  const runId = runIdOf(options.runId);
  const contract = parseContract(issue.body);
  const deploymentBinding = deploymentBindingOf(options.deploymentBinding);
  const eligible = (entry) => {
    if (entry?.when === 'deployed') {
      if (!deploymentBinding) return false;
      if (!options.method) return true;
      return deploymentProofEligible(entry, {
        environment: deploymentBinding.environment_id,
        attested: deploymentBinding.attested === true,
        method: options.method,
      });
    }
    // A deployed run selects only the criteria bound to its environment.
    if (deploymentBinding) return false;
    if (!options.method) return true;
    return isProofEligible(entry, normalizedStage, options.method);
  };
  const criteria = [...contract.criteria.values()]
    .filter((criterion) => canonicalAcceptanceStage(contract.rows.get(criterion.id).stage) === normalizedStage)
    .filter((criterion) => eligible(contract.plan?.get(criterion.id)))
    // An independently accepted PR-stage SC is pinned to its original
    // implementing PR head. A later linked PR must not re-evaluate or
    // overwrite that receipt unless an explicit trusted supersession exists.
    // Keep Pending/Fail and inconsistent checkbox/report states selectable.
    .filter((criterion) => options.skipAcceptedPrCriteria!==true ||
      normalizedStage!=='pr' ||
      !acceptedPrSourceRef(criterion,contract.rows.get(criterion.id)))
    .map((criterion) => {
      const row = contract.rows.get(criterion.id);
      return {
        criterion: criterion.id,
        text: criterion.text,
        stage: canonicalAcceptanceStage(row.stage),
        current_result: row.result,
        current_evidence: row.evidence,
      };
    });
  return {
    schema_version: 1,
    issue: { number: Number(issue.number), title: issue.title ?? '', url: issue.url ?? '',
      created_at: issue.createdAt ?? issue.created_at ?? null },
    stage: normalizedStage,
    contract_sha256: contractDigest(contract),
    run_id: runId,
    target_ref: (() => {
      const ref = String(options.targetRef ?? '').trim();
      if (!ref) throw new Error('target_ref is required');
      return ref;
    })(),
    deployment: options.deployment ? String(options.deployment).trim() : null,
    deployment_binding: deploymentBinding,
    ci_evidence: options.ciEvidence ?? null,
    criteria,
    ...(contract.sources ? { acceptance_sources: contract.sources } : {}),
    requirement_body: String(issue.body ?? ''),
  };
}

// A deployed execution must present the trusted identity of the environment it
// observed: the environment id plus an `attested` flag supplied by the trusted
// workflow after verifying the deployment attestation record.
function deploymentBindingOf(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('deployment binding must be an object');
  }
  const environment = String(value.environment_id ?? '');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(environment)) {
    throw new Error('deployment binding environment is invalid');
  }
  if (typeof value.attested !== 'boolean') {
    throw new Error('deployment binding attested must be a boolean');
  }
  return {
    ...value,
    environment_id: environment,
  };
}


export function normalizeAcceptanceCaseResult(context, record, source = 'case-runner') {
  if (!record || typeof record !== 'object') throw new Error('Case result must be an object');
  const criterion = String(record.criterion ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid Case criterion');
  if (Number(record.issue) !== Number(context.issue.number)) throw new Error('Case result Issue does not match Acceptance context');
  if (canonicalAcceptanceStage(record.stage) !== context.stage) throw new Error('Case result stage does not match Acceptance context');
  if (String(record.contract_sha256) !== String(context.contract_sha256)) {
    throw new Error('Case result contract digest does not match Acceptance context');
  }
  if (String(record.target_sha) !== String(context.target_ref)) {
    throw new Error('Case result target SHA does not match Acceptance context');
  }
  if (!context.criteria.some((item) => item.criterion === criterion)) {
    throw new Error('Case result criterion is absent from requested Acceptance stage');
  }

  const caseResult = String(record.result ?? '');
  const projected = caseResult === 'Pass'
    ? 'Pass'
    : caseResult === 'Fail'
      ? 'Fail'
      : 'Pending';
  const evidence = [
    {
      type: 'case',
      value: 'execution=' + String(record.execution_id ?? '(missing)') +
        ' tree=' + String(record.case_tree_sha ?? '(missing)') +
        ' revision=' + String(record.case_revision ?? '(missing)'),
    },
  ];
  for (const verifier of record.verifiers ?? []) {
    for (const item of verifier.evidence ?? []) {
      evidence.push({
        type: String(item.type ?? verifier.type ?? 'case'),
        value: String(item.value ?? '').trim(),
      });
    }
  }
  if (record.provenance?.workflow_url) {
    evidence.push({ type: 'workflow', value: String(record.provenance.workflow_url) });
  }
  if (record.provenance?.record_path) {
    evidence.push({ type: 'record', value: String(record.provenance.record_path) });
  }

  return {
    schema_version: 1,
    issue: context.issue.number,
    stage: context.stage,
    contract_sha256: context.contract_sha256,
    run_id: context.run_id,
    target_ref: context.target_ref,
    deployment: context.deployment,
    source: String(source || 'case-runner'),
    selected_criteria: [criterion],
    criteria: [normalizeCriterion({
      criterion,
      result: projected,
      evidence,
      summary: caseResult === 'Error'
        ? 'Acceptance Case infrastructure error: ' + String(record.infrastructure_error ?? 'unknown error')
        : String((record.verifiers ?? []).map((item) => item.summary).filter(Boolean).join(' | ') || caseResult),
    })],
  };
}

function replaceSection(body, heading, transform) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const wanted = heading.toLowerCase();
  let header = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/);
    if (match && match[2].trim().toLowerCase() === wanted) {
      header = i;
      level = match[1].length;
      break;
    }
  }
  if (header < 0) throw new Error('missing ' + heading + ' section');
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{2,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  const changed = transform(lines.slice(header + 1, end));
  return [...lines.slice(0, header + 1), ...changed, ...lines.slice(end)].join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function evidenceText(result, meta) {
  const pieces = result.evidence.map((entry) => entry.type + ': ' + entry.value);
  if (result.summary) pieces.push('summary: ' + result.summary);
  const deployment = meta.deployment ? '; deployment ' + meta.deployment : '';
  return escapeCell(
    'run ' + meta.run_id +
    '; ref ' + (meta.target_ref || '(unspecified)') +
    '; source ' + meta.source +
    deployment +
    '; ' + (pieces.join('; ') || 'no additional evidence')
  );
}

function automatedRunId(evidence) {
  const match = String(evidence ?? '').match(/^run\s+(\d+)\s*;/i);
  return match ? Number(match[1]) : null;
}

const SHA = /^[a-f0-9]{40}$/i;

// Only trusted projected Pass/N/A receipts, paired with a checked SC, anchor
// the accepted source. Human prose or an unaccepted Pending is not a lock.
function acceptedPrSourceRef(criterion, row) {
  if (!criterion?.checked || !['pass', 'n/a'].includes(String(row?.result || '').toLowerCase()))
    return null;
  return /^run [1-9]\d*; ref ([a-f0-9]{40}); source (?:agent(?:-[a-z0-9-]+)?|case-runner);/i
    .exec(String(row?.evidence || ''))?.[1] ?? null;
}

// A newer Run ID is never sufficient proof to replace an authenticated SC
// evaluated at a different PR head. The trusted updater supplies the actual
// REST source-commit associations and compare metadata, not model prose.
export function verifiedPrSourceSupersession(issueNumber, previous, next, proof) {
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      previous === next || !proof ||
      proof.issue !== Number(issueNumber) || proof.previous !== previous ||
      proof.next !== next || !/^[-\w.]+\/[-\w.]+$/.test(String(proof.repo || '')) ||
      !isMainMergeAncestorOfStaging(previous, next, proof.comparison) ||
      proof.comparison.ahead_by < 1 ||
      !Array.isArray(proof.previous_pulls) || !Array.isArray(proof.next_pulls) ||
      proof.previous_pulls.length >= 100 || proof.next_pulls.length >= 100)
    return false;
  const [owner, name] = proof.repo.split('/');
  const valid = p => Number.isSafeInteger(p?.number) && p.number > 0 &&
    p.head?.repo?.full_name === proof.repo &&
    p.base?.repo?.full_name === proof.repo &&
    ['main','staging'].includes(p.base?.ref) &&
    explicitlyImplementsIssue(p, issueNumber, owner, name);
  const predecessors = proof.previous_pulls.filter(valid);
  const successors = proof.next_pulls.filter(p => valid(p) && p.head.sha === next);
  return predecessors.some(old => successors.some(current =>
    current.number === old.number ||
    // Different PRs can explicitly supersede an original implementation,
    // but they must also carry independently authenticated commit ancestry.
    new RegExp('^\\s*Supersedes\\s+#' + old.number + '\\b', 'im')
      .test(String(current.body || ''))));
}

// #4146: a checked PR-stage Pass at a *failed* Quality source is historical
// evidence, not a permanent lock against correcting the SAME implementing PR.
// Every input here is independently fetched from GitHub on trusted main.
// A different implementing PR, newer Run ID alone, PR prose or a green status
// on a different SHA cannot authorize replacement.
export function verifiedFailedPrQualityRecovery(issueNumber, previous, next, {
  previousQuality, nextQuality, sourceProof,
} = {}) {
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      previous === next || previousQuality?.status !== 'fail' ||
      nextQuality?.status !== 'pass' ||
      !validPrRequiredQualityReceipt(nextQuality.receipt, next) ||
      !verifiedPrSourceSupersession(issueNumber, previous, next, sourceProof)) return null;
  const from = sourceProof.previous_pulls;
  const to = sourceProof.next_pulls;
  const matches = from.filter(old => to.some(current =>
    old.number === current.number &&
    current.head?.sha === next &&
    current.base?.ref === old.base?.ref &&
    current.base?.repo?.full_name === sourceProof.repo &&
    current.head?.repo?.full_name === sourceProof.repo &&
    // Both merged and still-open implementing PRs may be re-evaluated, but
    // abandoned closed-unmerged PRs cannot reopen their accepted evidence.
    (current.state === undefined || current.state === 'open' ||
      Boolean(current.merged_at))));
  if (matches.length !== 1) return null;
  return Object.freeze({
    issue: Number(issueNumber), previous, next, pr_number: matches[0].number,
    qualified_quality_run_id: nextQuality.receipt.run_id,
    qualified_quality_attempt: nextQuality.receipt.run_attempt,
    reason: 'prior accepted PR-stage source has failed exact-HEAD Quality',
  });
}

export function liveFailedPrQualityRecovery(issueNumber, previous, next, {
  qualityReader = collectPrRequiredQuality, sourceReader = livePrSourceSupersession,
} = {}) {
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      previous === next) return null;
  const previousQuality = qualityReader(previous);
  // Fail-closed when the original Run is missing/unknown rather than
  // rewriting an authenticated positive source.
  if (previousQuality?.status !== 'fail') return null;
  const nextQuality = qualityReader(next);
  if (nextQuality?.status !== 'pass') return null;
  const proof = sourceReader(issueNumber, previous, next);
  return verifiedFailedPrQualityRecovery(issueNumber, previous, next,
    {previousQuality, nextQuality, sourceProof: proof});
}

// This is only a *selection* adapter. It never edits an Issue or claims
// a reviewer result. The updater re-attests the exact same recovery later.
export function recoverFailedQualityPrCriteria(issue, context, {
  recoveryReader = liveFailedPrQualityRecovery,
} = {}) {
  if (context.stage !== 'pr' || !SHA.test(context.target_ref)) return context;
  const complete = buildAcceptanceContext(issue, 'pr', {
    targetRef: context.target_ref, runId: context.run_id, method: 'agent',
    skipAcceptedPrCriteria: false,
  });
  const contract = parseContract(issue.body);
  const already = new Set(context.criteria.map(x => x.criterion));
  const locked = complete.criteria.filter(x =>
    !already.has(x.criterion) &&
    contract.rows.get(x.criterion)?.result === 'Pass' &&
    acceptedPrSourceRef(contract.criteria.get(x.criterion),
      contract.rows.get(x.criterion)));
  const previous = [...new Set(locked.map(x =>
    acceptedPrSourceRef(contract.criteria.get(x.criterion),
      contract.rows.get(x.criterion))))];
  if (previous.length !== 1 || previous[0] === context.target_ref ||
      locked.length > 16) return context;
  const recovery = recoveryReader(Number(issue.number), previous[0], context.target_ref);
  if (!recovery) return context;
  const restore = new Set(locked.map(x => x.criterion));
  return {
    ...context,
    criteria: complete.criteria.filter(x => already.has(x.criterion) ||
      restore.has(x.criterion)),
    pr_quality_recovery: {
      ...recovery, criteria: locked.map(x => x.criterion),
    },
  };
}

// A PR-stage Pass is normally pinned to its accepted source. When the SAME
// implementing PR advances to a descendant head after acceptance, the merged
// head is what the close guard must verify; re-evaluate the locked criteria
// there instead of leaving the Issue permanently blocked (#4204). A different
// PR, a non-descendant head or missing/failed Quality still selects nothing.
export function verifiedSamePrHeadAdvance(issueNumber, previous, next, {
  previousQuality, nextQuality, sourceProof,
} = {}) {
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      previous === next ||
      previousQuality?.status !== 'pass' ||
      nextQuality?.status !== 'pass' ||
      !validPrRequiredQualityReceipt(nextQuality.receipt, next) ||
      !verifiedPrSourceSupersession(issueNumber, previous, next, sourceProof)) {
    return null;
  }
  const from = sourceProof.previous_pulls;
  const to = sourceProof.next_pulls;
  // The exact accepted commit must belong to the one implementing PR whose
  // current head is `next`; same PR number, same base, no unrelated successor.
  const matches = from.filter(old => to.some(current =>
    old.number === current.number &&
    current.head?.sha === next &&
    current.base?.ref === old.base?.ref &&
    current.base?.repo?.full_name === sourceProof.repo &&
    current.head?.repo?.full_name === sourceProof.repo &&
    // Both merged and still-open implementing PRs may advance; an abandoned
    // closed-unmerged PR cannot reopen its accepted evidence.
    (current.state === undefined || current.state === 'open' ||
      Boolean(current.merged_at))));
  if (matches.length !== 1) return null;
  return Object.freeze({
    issue: Number(issueNumber), previous, next, pr_number: matches[0].number,
    qualified_quality_run_id: nextQuality.receipt.run_id,
    qualified_quality_attempt: nextQuality.receipt.run_attempt,
    reason: 'same implementing PR advanced its accepted source head',
  });
}

export function liveSamePrHeadAdvance(issueNumber, previous, next, {
  qualityReader = collectPrRequiredQuality, sourceReader = livePrSourceSupersession,
} = {}) {
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      previous === next) return null;
  // The accepted source must have been green when accepted; a failed source
  // stays on the #4146 failed-Quality recovery path below.
  if (qualityReader(previous)?.status !== 'pass') return null;
  const nextQuality = qualityReader(next);
  if (nextQuality?.status !== 'pass') return null;
  const proof = sourceReader(issueNumber, previous, next);
  return verifiedSamePrHeadAdvance(issueNumber, previous, next,
    {previousQuality: {status: 'pass'}, nextQuality, sourceProof: proof});
}

// Selection adapter only; the deterministic updater re-attests the same
// same-PR lineage from independent GitHub data before projecting.
export function recoverAdvancedGreenPrCriteria(issue, context, {
  recoveryReader = liveSamePrHeadAdvance,
} = {}) {
  if (context.stage !== 'pr' || !SHA.test(context.target_ref)) return context;
  const complete = buildAcceptanceContext(issue, 'pr', {
    targetRef: context.target_ref, runId: context.run_id, method: 'agent',
    skipAcceptedPrCriteria: false,
  });
  const contract = parseContract(issue.body);
  const already = new Set(context.criteria.map(x => x.criterion));
  const locked = complete.criteria.filter(x =>
    !already.has(x.criterion) &&
    contract.rows.get(x.criterion)?.result === 'Pass' &&
    acceptedPrSourceRef(contract.criteria.get(x.criterion),
      contract.rows.get(x.criterion)));
  const previous = [...new Set(locked.map(x =>
    acceptedPrSourceRef(contract.criteria.get(x.criterion),
      contract.rows.get(x.criterion))))];
  if (previous.length !== 1 || previous[0] === context.target_ref ||
      locked.length > 16) return context;
  const recovery = recoveryReader(Number(issue.number), previous[0], context.target_ref);
  if (!recovery) return context;
  const restore = new Set(locked.map(x => x.criterion));
  return {
    ...context,
    criteria: complete.criteria.filter(x => already.has(x.criterion) ||
      restore.has(x.criterion)),
    pr_head_advance: {
      ...recovery, criteria: locked.map(x => x.criterion),
    },
  };
}

// #4253. Only a fresh, unedited Owner Issue comment can opt into a distinct,
// already merged replacement. GitHub REST independently proves both PRs,
// exact replacement HEAD association, two-parent merge and branch ancestry.
// This never reclassifies the old accepted PR receipt as replacement evidence.
export function liveIndependentReplacement(issue, targetRef, commentId,
  read = path => JSON.parse(execFileSync('gh',['api',path],
    {encoding:'utf8',env:process.env,maxBuffer:4*1024*1024}))) {
  const repo = String(process.env.GITHUB_REPOSITORY || '');
  const n = Number(commentId);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !Number.isSafeInteger(n) || n <= 0 ||
      !SHA.test(String(targetRef || ''))) return null;
  const base = 'repos/' + repo;
  const comment = read(base+'/issues/comments/'+n);
  const match = /^\/accept replace ([1-9][0-9]{0,8}) ([1-9][0-9]{0,8})$/
    .exec(String(comment?.body || ''));
  if (!match) return null;
  const previous = read(base+'/pulls/'+match[1]);
  const replacement = read(base+'/pulls/'+match[2]);
  const proof = independentReplacementContract(issue,previous,replacement,repo,comment);
  if (!proof || proof.target_ref !== targetRef) return null;
  const associated = read(base+'/commits/'+targetRef+'/pulls?per_page=100');
  const branch = read(base+'/branches/'+replacement.base.ref);
  const merge = read(base+'/commits/'+replacement.merge_commit_sha);
  if (!SHA.test(String(branch?.commit?.sha || ''))) return null;
  const compare = read(base+'/compare/'+replacement.merge_commit_sha+
    '...'+branch.commit.sha);
  return independentReplacementSourceEvidence(proof,replacement,
    associated,branch,merge,compare,repo) ? proof : null;
}

function priorAcceptedPrRefs(body, normalized) {
  if (stageOf(normalized.stage) !== 'pr') return [];
  const contract = parseContract(body);
  return (normalized.criteria || []).flatMap(({ criterion }) => {
    const id = String(criterion || '').toUpperCase();
    const previous = acceptedPrSourceRef(contract.criteria.get(id), contract.rows.get(id));
    return previous && previous !== normalized.target_ref ? [previous] : [];
  });
}

// #3581: a compare response carries commits/files and a PR object carries
// unrelated fields; buffering the whole payload into one spawnSync result
// overflowed the historical default buffer. Project only the provenance
// fields the verifier consumes and keep an explicit safe child-buffer cap.
const GITHUB_EVIDENCE_MAX_BUFFER = 8 * 1024 * 1024;
const COMPARE_EVIDENCE_JQ =
  '{status: .status, ahead_by: .ahead_by, behind_by: .behind_by, ' +
  'base_commit: {sha: .base_commit.sha}, ' +
  'merge_base_commit: {sha: .merge_base_commit.sha}}';
const PULLS_EVIDENCE_JQ =
  '[.[] | {number: .number, body: .body, title: .title, state: .state, merged_at: .merged_at, ' +
  'head: {sha: .head.sha, repo: {full_name: .head.repo.full_name}}, ' +
  'base: {ref: .base.ref, repo: {full_name: .base.repo.full_name}}}]';

function githubEvidenceExecute(args, options) {
  return execFileSync('gh', args, options);
}

export function collectGithubEvidence(path, jq, execute = githubEvidenceExecute) {
  let raw;
  try {
    raw = execute(['api', path, '--jq', jq], {
      encoding: 'utf8', env: process.env, maxBuffer: GITHUB_EVIDENCE_MAX_BUFFER,
    });
  } catch (error) {
    if (error && error.code === 'ENOBUFS') {
      throw new Error('GitHub evidence for ' + path +
        ' exceeded the ' + GITHUB_EVIDENCE_MAX_BUFFER + '-byte bound');
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GitHub evidence for ' + path + ' is truncated or not valid JSON');
  }
}

function incompleteEvidence(detail) {
  throw new Error('GitHub provenance evidence is incomplete: ' + detail);
}

function boundedCompareEvidence(comparison, path) {
  if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison) ||
      typeof comparison.status !== 'string' ||
      !Number.isSafeInteger(comparison.ahead_by) ||
      !Number.isSafeInteger(comparison.behind_by) ||
      !SHA.test(String(comparison.base_commit?.sha ?? '')) ||
      !SHA.test(String(comparison.merge_base_commit?.sha ?? ''))) {
    incompleteEvidence('comparison metadata for ' + path);
  }
  return comparison;
}

function boundedPullEvidence(pulls, label) {
  if (!Array.isArray(pulls)) incompleteEvidence(label + ' is not a PR list');
  if (pulls.length >= 100) {
    incompleteEvidence(label + ' pagination is incomplete (100 returned)');
  }
  return pulls;
}

export function livePrSourceSupersession(
  issueNumber, previous, next, execute = githubEvidenceExecute,
) {
  const repo = String(process.env.GITHUB_REPOSITORY || '');
  if (!SHA.test(String(previous || '')) || !SHA.test(String(next || '')) ||
      !/^[-\w.]+\/[-\w.]+$/.test(repo)) return null;
  const base = 'repos/' + repo;
  const comparePath = base + '/compare/' + previous + '...' + next;
  const previousPath = base + '/commits/' + previous + '/pulls?per_page=100';
  const nextPath = base + '/commits/' + next + '/pulls?per_page=100';
  return {
    issue: Number(issueNumber), previous, next, repo,
    comparison: boundedCompareEvidence(
      collectGithubEvidence(comparePath, COMPARE_EVIDENCE_JQ, execute), comparePath),
    previous_pulls: boundedPullEvidence(
      collectGithubEvidence(previousPath, PULLS_EVIDENCE_JQ, execute), 'previous pulls'),
    next_pulls: boundedPullEvidence(
      collectGithubEvidence(nextPath, PULLS_EVIDENCE_JQ, execute), 'next pulls'),
  };
}

function updateCheckboxes(body, resultMap) {
  return replaceSection(body, 'Success Criteria', (lines) => lines.map((line) => {
    const match = line.match(/^(\s*-\s+\[)[ xX](\]\s+(SC-\d{2,})\b.*)$/i);
    if (!match) return line;
    const result = resultMap.get(match[3].toUpperCase());
    if (!result) return line;
    const checked = result.result === 'Pass' || result.result === 'N/A' ? 'x' : ' ';
    return match[1] + checked + match[2];
  }));
}

function updateReport(body, contract, resultMap, meta) {
  return replaceSection(body, 'Acceptance Report', (lines) => lines.map((line) => {
    const match = line.match(/^\s*\|\s*(SC-\d{2,})\s*\|/i);
    if (!match) return line;
    const id = match[1].toUpperCase();
    const result = resultMap.get(id);
    if (!result) return line;
    const row = contract.rows.get(id);
    const evidence = evidenceText(result, meta);
    return row.explicitStage
      ? '| ' + id + ' | ' + row.stage + ' | ' + result.result + ' | ' + evidence + ' |'
      : '| ' + id + ' | ' + result.result + ' | ' + evidence + ' |';
  }));
}

// One historical integration PR was incorrectly re-evaluated by a *later,
// unrelated* PR that referenced the Issue. Run-number precedence must not
// suppress the authenticated original-PR Pass. This narrow, immutable
// migration does not weaken the normal newest-Run rule for any other Issue,
// source ref, criterion, result, or attempted deterministic override.
function originalStagingPrRecovery(body, normalized, criterion, currentEvidence, result) {
  const head='91af0907d508224d55e469adfa6442f440b70432';
  const marker='<!-- nession-convergence-batch:v1 branch=staging main='+
    '8352d3abb6f3c73b07db2fed1357566aa17f74b2 lane='+
    'f7e2d008ed497d85554b2aa88801f4d86177f873 head='+head+' -->';
  const currentRef=/\bref ([0-9a-f]{40});/.exec(String(currentEvidence ?? ''))?.[1];
  return normalized.issue===2984 && criterion==='SC-01' &&
    ['pr', 'pre-merge'].includes(normalized.stage) && normalized.target_ref===head &&
    normalized.run_id===42461722784 &&
    normalized.source==='agent-qwen' && result?.result==='Pass' &&
    body.includes(marker) && currentRef!=null && currentRef!==head &&
    /^run [1-9][0-9]*; ref [0-9a-f]{40}; source agent-/.test(currentEvidence);
}

export function applyAcceptanceResultToBody(body, normalized, options = {}) {
  const contract = parseContract(body);
  if (contractDigest(contract) !== normalized.contract_sha256) {
    throw new Error('requirement contract changed after acceptance started; refusing stale result');
  }
  const stage = stageOf(normalized.stage);
  const runId = runIdOf(normalized.run_id);
  if (!Array.isArray(normalized.criteria)) throw new Error('acceptance result criteria must be an array');

  const stageExpected = [...contract.criteria.values()]
    .filter((criterion) => canonicalAcceptanceStage(contract.rows.get(criterion.id).stage) === stage)
    .map((criterion) => criterion.id);
  const expected = Array.isArray(normalized.selected_criteria)
    ? normalized.selected_criteria.map((id) => String(id).trim().toUpperCase())
    : stageExpected;
  if (expected.length === 0) throw new Error('acceptance result selects no criteria');
  if (new Set(expected).size !== expected.length) throw new Error('acceptance result has duplicate selected criteria');
  const deploymentBinding = options.deploymentBinding ?? null;
  const proofSource = String(normalized.source ?? '');
  const proofMethod = /^agent(?:-|$)/.test(proofSource) ? 'agent'
    : proofSource === 'case-runner' ? 'case' : null;
  for (const id of expected) {
    if (!stageExpected.includes(id)) throw new Error('selected criterion ' + id + ' is unknown or belongs to another stage');
    if (contract.plan) {
      const entry = contract.plan.get(id);
      const eligible = proofMethod && (entry?.when === 'deployed'
        ? deploymentProofEligible(entry, {
          environment: deploymentBinding?.environment_id,
          attested: deploymentBinding?.attested === true,
          method: proofMethod,
        })
        : isProofEligible(entry, stage, proofMethod));
      if (!eligible) {
        throw new Error(id + ' selected method does not match authenticated Acceptance Plan proof source ' + proofSource);
      }
    }
  }
  const resultMap = new Map();
  for (const raw of normalized.criteria) {
    const result = normalizeCriterion(raw);
    if (resultMap.has(result.criterion)) throw new Error('duplicate criterion ' + result.criterion);
    const row = contract.rows.get(result.criterion);
    if (!row) throw new Error('unknown criterion ' + result.criterion);
    if (canonicalAcceptanceStage(row.stage) !== stage) throw new Error(result.criterion + ' belongs to ' + row.stage + ', not requested stage ' + stage);
    if (!expected.includes(result.criterion)) throw new Error('criterion ' + result.criterion + ' was not selected for this partial acceptance result');
    resultMap.set(result.criterion, result);
  }
  const missing = expected.filter((id) => !resultMap.has(id));
  if (missing.length) throw new Error('acceptance result is missing criteria: ' + missing.join(', '));

  // The frozen, trusted-main result must carry independent exact-head Web
  // execution proof when a PR criterion requires that integration test.
  // Never allow a model/caller-crafted Pass to skip the normalization barrier.
  for (const [id, result] of resultMap) {
    if (stage === 'pr' && result.result === 'Pass' &&
        requiresWebIntegrationExecution(contract.criteria.get(id), body) &&
        !validWebQualityReceipt(normalized.pr_web_quality_receipt, normalized.target_ref)) {
      throw new Error(id + ' Pass lacks authenticated exact-head Web Quality receipt');
    }
    if (stage === 'pr' && result.result === 'Pass' &&
        requiresExactHeadRustQuality(contract.criteria.get(id)) &&
        !validRustQualityReceipt(normalized.pr_rust_quality_receipt, normalized.target_ref)) {
      throw new Error(id + ' Pass lacks authenticated exact-head Rust Quality receipt');
    }
  }

  for (const [id] of resultMap) {
    if (stage === 'pr') {
      const oldRef = acceptedPrSourceRef(contract.criteria.get(id), contract.rows.get(id));
      const replacement = options.prSourceReplacement;
      const independentlyReplaced = replacement &&
        JSON.stringify(replacement) === JSON.stringify(normalized.pr_source_replacement) &&
        replacement.issue === normalized.issue &&
        replacement.target_ref === normalized.target_ref &&
        replacement.criteria.includes(id) && replacement.old_sources.includes(oldRef);
      if (oldRef && oldRef !== normalized.target_ref &&
          !independentlyReplaced &&
          !verifiedPrSourceSupersession(normalized.issue, oldRef,
            normalized.target_ref, options.prSourceSupersession)) {
        throw new Error(id + ' accepted PR source ' + oldRef +
          ' cannot be overwritten by unrelated exact head ' + normalized.target_ref +
          '; requires authenticated implementing PR supersession lineage');
      }
    }
    const previous = automatedRunId(contract.rows.get(id).evidence);
    if (previous != null && previous > runId &&
        !originalStagingPrRecovery(body, normalized, id, contract.rows.get(id).evidence, resultMap.get(id))) {
      throw new Error(id + ' has newer acceptance run ' + previous + '; refusing stale run ' + runId);
    }
  }

  let updated = updateCheckboxes(body, resultMap);
  updated = updateReport(updated, contract, resultMap, { ...normalized, run_id: runId });
  // Preserve the prior accepted SC row verbatim in a separate non-authority
  // history section; current Acceptance Report remains the only active row.
  // Without a trusted same-PR failed-Quality recovery selector, retain the
  // existing ordinary supersession behavior and do not add recovery history.
  const recovery = normalized.pr_quality_recovery;
  if (stage === 'pr' && recovery && Array.isArray(recovery.criteria) &&
      recovery.issue === normalized.issue && recovery.next === normalized.target_ref) {
    const replaced = recovery.criteria.filter(id =>
      resultMap.has(id) &&
      acceptedPrSourceRef(contract.criteria.get(id),contract.rows.get(id)) === recovery.previous);
    if (replaced.length) {
      const heading = '## Acceptance Source Recovery History';
      const marker = 'quality-recovery:'+recovery.previous+':'+normalized.target_ref+
        ':'+runId;
      if (!updated.includes(marker)) {
        const rows = replaced.map(id => {
          const row = contract.rows.get(id);
          return '- '+id+' prior '+row.result+' at '+recovery.previous+
            ' (evidence: '+escapeCell(row.evidence)+'); superseded by '+
            normalized.target_ref+' at acceptance run '+runId;
        });
        updated += '\n\n'+(updated.includes(heading)?'':heading+'\n')+
          '<!-- '+marker+' -->\n'+rows.join('\n');
      }
    }
  }
  // Keep the original SC evidence verbatim in immutable historical context.
  // The NEW active Pass is evaluated at an independent, verified source.
  const separate = options.prSourceReplacement;
  if (stage === 'pr' && separate &&
      JSON.stringify(separate) === JSON.stringify(normalized.pr_source_replacement) &&
      separate.issue === normalized.issue &&
      separate.target_ref === normalized.target_ref) {
    const historical = separate.criteria.filter(id => resultMap.has(id) &&
      separate.old_sources.includes(acceptedPrSourceRef(
        contract.criteria.get(id),contract.rows.get(id))));
    if (historical.length !== separate.criteria.length)
      throw new Error('independent replacement must cover every original accepted PR criterion');
    const heading = '## Acceptance Source Recovery History';
    const marker = 'independent-replacement:'+separate.previous_pr+':'+
      separate.replacement_pr+':'+runId;
    if (!updated.includes(marker)) {
      const rows = historical.map(id => {
        const row=contract.rows.get(id);
        return '- '+id+' historical '+row.result+' at '+
          acceptedPrSourceRef(contract.criteria.get(id),row)+
          ' (evidence: '+escapeCell(row.evidence)+'); independently re-attested by merged PR #'+
          separate.replacement_pr+' at '+normalized.target_ref+' in run '+runId;
      });
      updated += '\n\n'+(updated.includes(heading)?'':heading+'\n')+
        '<!-- '+marker+' -->\n'+rows.join('\n');
    }
  }
  // A green accepted source that the same PR advanced past keeps its prior
  // authenticated row in the same non-authority history section (#4204).
  const advance = normalized.pr_head_advance;
  if (stage === 'pr' && advance && Array.isArray(advance.criteria) &&
      advance.issue === normalized.issue && advance.next === normalized.target_ref) {
    const replaced = advance.criteria.filter(id =>
      resultMap.has(id) &&
      acceptedPrSourceRef(contract.criteria.get(id),contract.rows.get(id)) === advance.previous);
    if (replaced.length) {
      const heading = '## Acceptance Source Recovery History';
      const marker = 'head-advance:'+advance.previous+':'+normalized.target_ref+
        ':'+runId;
      if (!updated.includes(marker)) {
        const rows = replaced.map(id => {
          const row = contract.rows.get(id);
          return '- '+id+' prior '+row.result+' at '+advance.previous+
            ' (evidence: '+escapeCell(row.evidence)+'); superseded by '+
            normalized.target_ref+' at acceptance run '+runId+
            ' after the same implementing PR advanced its head';
        });
        updated += '\n\n'+(updated.includes(heading)?'':heading+'\n')+
          '<!-- '+marker+' -->\n'+rows.join('\n');
      }
    }
  }
  return updated;
}

// Only the canonical, currently OPEN Issue can accept a projected result.
// Unknown states are an API/contract error, not a silent success.
function isOpenAcceptanceIssue(issue) {
  const state = String(issue?.state ?? '').toUpperCase();
  if (state === 'OPEN') return true;
  if (state === 'CLOSED') return false;
  throw new Error('unexpected Issue state at Acceptance write boundary: ' + (state || '(missing)'));
}

// Keep the final read adjacent to the sole Issue mutation. This is purposely
// separate from prepare's Open check: verification can outlive Issue closure.
// Reject body drift too; gh issue edit replaces the WHOLE body, not just SC rows.
function commitOpenAcceptanceIssue(initial, readCurrent, write) {
  if (!isOpenAcceptanceIssue(initial)) return false;
  const current = readCurrent();
  if (!isOpenAcceptanceIssue(current)) return false;
  if (current.number !== initial.number || current.body !== initial.body) {
    throw new Error('Issue changed during Acceptance verification; refusing stale body overwrite');
  }
  write();
  return true;
}

function fetchIssue(issueNumber) {
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) <= 0) throw new Error('issue number must be a positive integer');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,title,body,state,url,labels,createdAt'],
    { encoding: 'utf8', env: process.env }
  );
  return JSON.parse(raw);
}

function implicitCiEvidenceFile(outFile) {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  const root = String(process.env.GITHUB_WORKSPACE ?? '').trim().replace(/\/+$/, '');
  if (!root) return null;

  const workspace = root + '/workspace';
  if (!fs.existsSync(workspace)) return null;

  const evidenceFile = outFile + '.ci-evidence.json';
  const collector = fileURLToPath(new URL('./acceptance-ci-evidence.mjs', import.meta.url));
  execFileSync(process.execPath, [collector, 'collect', workspace, evidenceFile], {
    env: process.env,
    stdio: 'inherit',
  });
  return evidenceFile;
}

// A source-bound batch was already accepted on its original PR, but the old
// workflow definition intentionally supplied "-" (no generic PR CI readback).
// GitHub re-runs load that original workflow definition. The trusted main
// harness alone may recover *this exact historical PR* after authenticating
// its owner-approved E2E digest, native PR merge and four original check Runs.
// Do not turn on the full post-merge collector for ordinary PRs.
function originalStagingPrEvidence(issueNumber, stage, targetRef, outFile, explicitFile) {
  if (Number(issueNumber) !== 2984 || !['pr', 'pre-merge'].includes(stage) ||
      targetRef !== '91af0907d508224d55e469adfa6442f440b70432' ||
      explicitFile !== '-') return null;
  const output=outFile+'.original-staging-pr.json';
  const source=fileURLToPath(new URL('./acceptance-staging-batch-pr-evidence.mjs',import.meta.url));
  execFileSync(process.execPath,[source,'collect',targetRef,output],{
    env:process.env,stdio:'inherit',
  });
  return output;
}

function prepareCommand(issueNumber, stage, targetRef, outFile, deployment, ciEvidenceFile) {
  const issue = fetchIssue(issueNumber);
  if (String(issue.state).toUpperCase() !== 'OPEN') throw new Error('requirement #' + issueNumber + ' is not open');
  if (!isAcceptanceIssue(issue)) throw new Error('issue #' + issueNumber + ' must be labeled bug or requirement');

  // Current Acceptance workflows pass a trusted CI-evidence file explicitly.
  // Older workflow runs do not. GitHub re-runs preserve the workflow definition
  // from the original run, while this trusted harness is checked out from main.
  // Recover the same evidence from the already checked-out target workspace so
  // historical re-runs cannot silently degrade to ci_evidence=null.
  // An explicit '-' suppresses the old implicit collector for PR-stage proof.
  // An omitted argument still preserves historical rerun compatibility.
  const evidencePath = originalStagingPrEvidence(issueNumber, stage, targetRef, outFile, ciEvidenceFile) ||
    (ciEvidenceFile === '-' ? null : (ciEvidenceFile || implicitCiEvidenceFile(outFile)));
  const ciEvidence = evidencePath
    ? JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
    : null;
  const replacementCommentId = process.env.ACCEPTANCE_REPLACEMENT_COMMENT_ID || '';
  if (replacementCommentId && (stage !== 'pr' ||
      process.env.DETERMINISTIC_RESULT_JSON))
    throw new Error('independent PR replacement requires real PR-stage Agent evidence');
  const replacement = replacementCommentId
    ? liveIndependentReplacement(issue,targetRef,replacementCommentId) : null;
  if (replacementCommentId && !replacement)
    throw new Error('independent PR replacement lacks current Owner/PR/merge proof');
  let context = buildAcceptanceContext(issue, stage, {
    targetRef,
    deployment,
    ciEvidence,
    method: 'agent',
    // Only a LIVE PR Agent evaluation skips previously source-accepted SCs.
    // Historical Case/CI readback must still see those original criteria.
    skipAcceptedPrCriteria: !replacement,
    runId: process.env.ACCEPTANCE_RUN_ID ?? process.env.GITHUB_RUN_ID,
  });
  context = recoverFailedQualityPrCriteria(issue, context);
  // A green accepted source whose SAME PR advanced is re-evaluated at the
  // merged head; the updater re-attests the lineage before projecting (#4204).
  context = recoverAdvancedGreenPrCriteria(issue, context);
  // #4448: expose the trusted-main CI / Pages Run/Job/Step and bounded
  // frozen-baseline parity artifact receipt. Evidence only; the Agent and the
  // normalizer still decide each criterion.
  if (context.stage === 'pr' && ciEvidence?.kind === 'verified_pr_pages_migration_v1' &&
      validPagesMigrationReceipt(ciEvidence, context.target_ref)) {
    context.pr_pages_migration = {status: 'pass', receipt: ciEvidence};
  }
  if (replacement) {
    const selected = context.criteria.map(x=>x.criterion).sort();
    if (JSON.stringify(selected) !== JSON.stringify(replacement.criteria))
      throw new Error('independent replacement must re-evaluate every historical PR SC');
    context.pr_source_replacement = replacement;
  }
  // Every PR-stage model Pass must be independently Quality-qualified even
  // when the SC text does not explicitly name test execution (#4146).
  if (context.stage === 'pr' && context.criteria.length > 0) {
    context.pr_required_quality = collectPrRequiredQuality(context.target_ref);
    // #4231: expose the aggregate receipt to the model only when a criterion
    // explicitly names it; the normalizer's enforcePrRequiredQuality barrier
    // still rejects any Pass without a valid exact-head receipt.
    context.pr_required_quality_exposed =
      requiresPrRequiredQualityEvidence(context);
  }
  // The trusted prepare step has read-only Actions credentials. Read the
  // required Web Gate only for executable Web integration SCs, not every PR.
  if (context.stage === 'pr' && context.criteria.some(item =>
    requiresWebIntegrationExecution(item, context.requirement_body))) {
    context.pr_web_quality = collectPrWebQuality(context.target_ref);
  }
  if (requiresPrToolingEvidence(context)) {
    context.pr_tooling_quality = collectPrToolingQuality(context.target_ref);
  }
  // Same trusted read-only readback for a criterion that explicitly makes
  // exact-head Rust Quality execution its proof obligation (#3584 SC-02).
  if (requiresPrRustQualityEvidence(context)) {
    context.pr_rust_quality = collectPrRustQuality(context.target_ref);
  }
  if (requiresPrCiTriad(context)) {
    const visual = context.criteria.some(requiresPrVisualEvidenceCriterion);
    context.pr_ci_triad = collectPrCiTriad(context.target_ref, undefined, {visual});
    if (visual && context.pr_ci_triad?.status === 'pass' &&
        context.pr_ci_triad?.receipt?.variant === 'visual' &&
        validPrCiTriadReceipt(context.pr_ci_triad.receipt, context.target_ref)) {
      // Trusted-main verifier, never model/PR code, supplies these five
      // GitHub-bound Quality + browser evidence receipts to the Agent.
      context.ci_evidence = {
        kind: 'verified_pr_visual_ci_v1',
        target_sha: context.target_ref,
        receipt: context.pr_ci_triad.receipt,
      };
    }
  }
  if (replacement && (context.pr_required_quality?.status !== 'pass' ||
      !validPrRequiredQualityReceipt(context.pr_required_quality.receipt,
        replacement.target_ref)))
    throw new Error('independent replacement lacks exact-head required Quality');
  fs.writeFileSync(outFile, JSON.stringify(context, null, 2) + '\n');
  console.log('prepared ' + context.criteria.length + ' ' + context.stage + ' criteria for requirement #' + issueNumber);
}

function normalizeCommand(contextFile, rawFile, outFile, source) {
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const normalized = verified4342HistoryCriterion(context,
    verified4342DownstreamCriterion(context,
      verified4342AuditCriterion(context,
      verifiedIssueAudit3843Criterion(context, verifiedIssueAuditCriterion(
        context, normalizeAcceptanceResult(context, raw, source))))));
  // The trusted normalizer—not the model—decides whether a claimed live
  // failed-Full publication has authenticated source/Store/Bug receipts.
  const gated = enforceConvergenceWriter4059(context,
    enforcePrRequiredQuality(context,
      enforceLiveFullFailure(context,
        enforcePrRustQuality(context, enforcePrWebQuality(context,
          enforcePrCiTriad(context, normalized))))));
  // Trusted prepare-time source lineage is retained only as a locator;
  // the Issue writer re-authenticates it from independent GitHub REST.
  const frozen = {
    ...gated,
    ...(context.pr_quality_recovery
      ? {pr_quality_recovery: context.pr_quality_recovery} : {}),
    ...(context.pr_head_advance
      ? {pr_head_advance: context.pr_head_advance} : {}),
    ...(context.pr_source_replacement
      ? {pr_source_replacement: context.pr_source_replacement} : {}),
  };
  fs.writeFileSync(outFile, JSON.stringify(frozen, null, 2) + '\n');
}

function isSupersededRunError(error) {
  return error instanceof Error && /^SC-\d{2,} has newer acceptance run \d+; refusing stale run \d+$/.test(error.message);
}

function applyCommand(issueNumber, resultFile) {
  const issue = fetchIssue(issueNumber);
  // A prepared Acceptance result is not authority to rewrite an Issue that
  // the native lifecycle has already closed while this Run was in flight.
  if (!isOpenAcceptanceIssue(issue)) {
    console.log('requirement #' + issueNumber + ' is closed; skipping stale Acceptance update');
    return;
  }
  if (!isAcceptanceIssue(issue)) throw new Error('issue #' + issueNumber + ' must be labeled bug or requirement');
  const normalized = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (Number(normalized.issue) !== Number(issueNumber)) throw new Error('result targets issue #' + normalized.issue + ', not #' + issueNumber);
  if (!mayProjectConvergenceWriter4059(normalized))
    throw new Error('Convergence workflow-writer Pass lacks authenticated operation-level proof (#4137)');
  // A downloadable normalized result is not permission to project Pass. The
  // trusted Issue writer MUST independently re-read the latest exact-run
  // Quality status and compare its identity with the prepare-time receipt.
  // A rerun/new attempt invalidates the old normalization (#4146).
  if (stageOf(normalized.stage) === 'pr' &&
      (normalized.criteria ?? []).some(item => item.result === 'Pass')) {
    const actual = collectPrRequiredQuality(normalized.target_ref);
    const claimed = normalized.pr_required_quality_receipt;
    if (actual.status !== 'pass' ||
        !validPrRequiredQualityReceipt(claimed, normalized.target_ref) ||
        !validPrRequiredQualityReceipt(actual.receipt, normalized.target_ref) ||
        claimed.run_id !== actual.receipt.run_id ||
        claimed.run_attempt !== actual.receipt.run_attempt ||
        claimed.scope_job_id !== actual.receipt.scope_job_id ||
        claimed.web_check_job_id !== actual.receipt.web_check_job_id ||
        JSON.stringify(claimed.job_outcomes) !== JSON.stringify(actual.receipt.job_outcomes)) {
      throw new Error('PR Acceptance Pass lacks current independent exact-HEAD required Quality qualification');
    }
  }
  // An old accepted source can be re-evaluated only after independent proof
  // that its Quality failed and a SAME-PR descendant now passes Quality.
  // Never trust a prepared Artifact's claimed recovery selector by itself.
  if (normalized.pr_quality_recovery) {
    const recovery = normalized.pr_quality_recovery;
    const readback = liveFailedPrQualityRecovery(issueNumber,
      recovery.previous, normalized.target_ref);
    if (!readback || readback.pr_number !== recovery.pr_number ||
        recovery.next !== normalized.target_ref ||
        recovery.issue !== issueNumber ||
        !Array.isArray(recovery.criteria) ||
        recovery.criteria.length === 0 || recovery.criteria.length > 16 ||
        recovery.criteria.some(id => !normalized.selected_criteria.includes(id)) ||
        recovery.qualified_quality_run_id !== readback.qualified_quality_run_id ||
        recovery.qualified_quality_attempt !== readback.qualified_quality_attempt) {
      throw new Error('PR Quality recovery lacks current authenticated same-PR source lineage');
    }
  }
  // The same implementing PR may advance a green accepted source to its merged
  // head. Re-attest same-PR ancestry and exact-HEAD Quality; never trust the
  // prepared Artifact's claimed advance by itself (#4204).
  if (normalized.pr_head_advance) {
    const advance = normalized.pr_head_advance;
    const readback = liveSamePrHeadAdvance(issueNumber,
      advance.previous, normalized.target_ref);
    if (!readback || readback.pr_number !== advance.pr_number ||
        advance.next !== normalized.target_ref ||
        advance.issue !== issueNumber ||
        !Array.isArray(advance.criteria) ||
        advance.criteria.length === 0 || advance.criteria.length > 16 ||
        advance.criteria.some(id => !normalized.selected_criteria.includes(id)) ||
        advance.qualified_quality_run_id !== readback.qualified_quality_run_id ||
        advance.qualified_quality_attempt !== readback.qualified_quality_attempt) {
      throw new Error('PR head advance lacks current authenticated same-PR green Quality lineage');
    }
  }
  let replacementReadback = null;
  if (normalized.pr_source_replacement) {
    // An authenticated, already projected same Run is a no-op. Replayed
    // delivery never consumes the historical one-shot replacement again.
    const prior = normalized.pr_source_replacement;
    const marker = 'independent-replacement:'+prior.previous_pr+':'+
      prior.replacement_pr+':'+normalized.run_id;
    const report = parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
    if (issue.body.includes('<!-- '+marker+' -->') &&
        normalized.selected_criteria?.every(id =>
          new RegExp('^run '+normalized.run_id+'; ref '+normalized.target_ref+
            '; source agent(?:-[a-z0-9-]+)?;','i').test(
              String(report.rows.get(id)?.evidence || '')))) {
      console.log('replacement Acceptance '+normalized.run_id+' already projected; no-op');
      return;
    }
    replacementReadback = liveIndependentReplacement(issue,normalized.target_ref,
      normalized.pr_source_replacement.comment_id);
    if (!replacementReadback ||
        JSON.stringify(replacementReadback) !==
          JSON.stringify(normalized.pr_source_replacement) ||
        normalized.source === 'deterministic-caller')
      throw new Error('replacement Acceptance result lacks independent current Owner/PR/source attestation');
  }
  // Concurrent Acceptance runs may finish out of order. Never project older
  // evidence over a newer run, but treat the superseded updater as a no-op.
  // All other contract, provenance and result validation errors still fail.
  let updated;
  try {
    const conflicts = [...new Set(priorAcceptedPrRefs(issue.body, normalized))];
    // One explicit source lineage proof may authorize multiple SCs anchored
    // to the same prior head; multiple predecessors are ambiguous and rejected.
    const proof = !replacementReadback && conflicts.length === 1
      ? livePrSourceSupersession(issueNumber, conflicts[0], normalized.target_ref)
      : null;
    updated = applyAcceptanceResultToBody(issue.body, normalized,
      { prSourceSupersession: proof,
        prSourceReplacement: replacementReadback });
  } catch (error) {
    if (isSupersededRunError(error)) {
      console.log('superseded acceptance run ' + normalized.run_id + ' for requirement #' + issueNumber + '; newer Issue evidence preserved');
      return;
    }
    throw error;
  }
  if (updated === issue.body) {
    console.log('requirement #' + issueNumber + ' already matches acceptance run ' + normalized.run_id);
    return;
  }
  // Quality/source readback may take minutes. Re-fetch at the LAST write
  // boundary: a successful closed-Issue reconciliation supersedes this pending
  // Run. A changed body also cannot be replaced by a stale whole-body edit.
  const applied = commitOpenAcceptanceIssue(issue,
    () => fetchIssue(issueNumber),
    () => execFileSync(
      'gh',
      ['issue', 'edit', String(issueNumber), '--repo', process.env.GITHUB_REPOSITORY, '--body-file', '-'],
      { input: updated, encoding: 'utf8', env: process.env }
    ));
  if (!applied) {
    console.log('requirement #' + issueNumber + ' closed during Acceptance verification; no Issue edit');
    return;
  }
  const counts = normalized.criteria.reduce((acc, item) => {
    acc[item.result] = (acc[item.result] ?? 0) + 1;
    return acc;
  }, {});
  console.log('updated requirement #' + issueNumber + ': ' + JSON.stringify(counts));
}

function fixtureBody() {
  return [
    '## Requirements: fixture',
    '',
    'Keep this paragraph exactly.',
    '',
    '### Success Criteria',
    '',
    '- [ ] SC-01 deterministic update works',
    '- [ ] SC-02 failing acceptance stays unchecked',
    '',
    '## Acceptance Report',
    '',
    '| Criterion | Stage | Result | Evidence |',
    '|---|---|---|---|',
    '| SC-01 | staging | Pending | implementation pending |',
    '| SC-02 | post-merge | Pending | requires production deployment; verify after release |',
    '',
    '## Product alignment',
    '',
    '- [x] aligned',
    '',
    '---',
    '**Status:** Approved',
  ].join('\n');
}

function selfTestClosedIssueGuard() {
  const open = { number: 4297, state: 'OPEN', body: 'accepted evidence' };
  const closed = { ...open, state: 'CLOSED' };
  assert.equal(isOpenAcceptanceIssue(open), true);
  assert.equal(isOpenAcceptanceIssue(closed), false);
  assert.throws(() => isOpenAcceptanceIssue({ ...open, state: 'UNKNOWN' }),
    /unexpected Issue state/);
  let reads = 0;
  let writes = 0;
  const readOpen = () => { reads++; return open; };
  const write = () => { writes++; };
  assert.equal(commitOpenAcceptanceIssue(closed, readOpen, write), false,
    'a closed Issue at entry must not even re-read or write');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(commitOpenAcceptanceIssue(open, () => {
    reads++;
    return closed;
  }, write), false, 'closure during source verification must not write');
  assert.equal(writes, 0);
  assert.throws(() => commitOpenAcceptanceIssue(open, () =>
    ({ ...open, body: 'newer SC evidence' }), write),
  /refusing stale body overwrite/, 'concurrent report updates must not be overwritten');
  assert.equal(writes, 0);
  assert.throws(() => commitOpenAcceptanceIssue(open, () =>
    ({ ...open, number: 4241 }), write),
  /refusing stale body overwrite/, 'an unrelated Issue snapshot must never authorize an edit');
  assert.equal(writes, 0);
  assert.equal(commitOpenAcceptanceIssue(open, readOpen, write), true,
    'an unchanged open Issue must still use the native updater');
  assert.equal(writes, 1);
  assert.equal(commitOpenAcceptanceIssue(closed, readOpen, write), false,
    'late replay after closure remains a no-op');
  assert.equal(writes, 1);
}

function selfTest() {
  selfTestClosedIssueGuard();
  assert.equal(selfTestPrCiTriad(), true);
  // #4231: the aggregate Quality receipt is visible to the model only for an
  // explicitly activated PR criterion; unactivated/staging views omit it.
  const aggregateView = {
    stage: 'pr',
    pr_required_quality: { status: 'pass', receipt: { kind: 'pr_required_quality_v1' } },
    pr_required_quality_exposed: true,
    criteria: [],
    requirement_body: '',
  };
  assert.equal(acceptanceModelView(aggregateView).pr_required_quality?.status, 'pass');
  assert.equal(acceptanceModelView({
    ...aggregateView, pr_required_quality_exposed: false }).pr_required_quality, null);
  assert.equal(acceptanceModelView({
    ...aggregateView, stage: 'staging' }).pr_required_quality, null);
  // Both issue kinds use the same trusted Acceptance context/projector.
  // Discussions without an eligible label remain out of scope.
  for (const labels of [['bug'], [{ name: 'bug' }], ['requirement'], [{ name: 'requirement' }]]) {
    assert.equal(isAcceptanceIssue({ labels }), true);
  }
  for (const labels of [[], ['ci'], ['test', 'documentation']]) {
    assert.equal(isAcceptanceIssue({ labels }), false);
  }
  const issue = { number: 1360, title: 'Requirement: fixture', url: 'https://example.test/1360', body: fixtureBody() };
  const staging = buildAcceptanceContext(issue, 'staging', {
    targetRef: 'abc123',
    deployment: 'staging',
    runId: 100,
    ciEvidence: {
      schema_version: 1,
      kind: 'acceptance_ci_evidence',
      target_sha: 'abc123',
      direct_runs: [{ id: 42, name: 'E2E Tests', status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
      pull_requests: [],
    },
  });
  assert.deepEqual(staging.criteria.map((item) => item.criterion), ['SC-01']);
  assert.equal(staging.ci_evidence.target_sha, 'abc123');
  assert.equal(staging.ci_evidence.direct_runs[0].id, 42);
  const pass = normalizeAcceptanceResult(staging, {
    criteria: [{
      criterion: 'SC-01',
      result: 'pass',
      evidence: [{ type: 'test', value: 'node scripts/acceptance-executor.mjs self-test' }],
      summary: 'fixture passed',
    }],
  }, 'deterministic');
  const passedBody = applyAcceptanceResultToBody(issue.body, pass);
  assert.match(passedBody, /- \[x\] SC-01 deterministic update works/);
  assert.match(passedBody, /\| SC-01 \| staging \| Pass \| run 100; ref abc123;/);
  assert.match(passedBody, /Keep this paragraph exactly\./);
  assert.equal(validateRequirementBody(passedBody, { mode: 'merge' }).ok, true);

  // #4253: a force-pushed/orphaned historical SC can be re-evaluated only
  // after an independently validated replacement. Preserve exact old receipt
  // in history; NEVER copy old "Pass" into a new unsigned result.
  const oldPrSha='a'.repeat(40), newPrSha='b'.repeat(40);
  const replacementBody=[
    '## Success Criteria',
    '- [x] SC-01 original behavior must be proved again',
    '',
    '## Acceptance Plan',
    '```yaml','acceptance:','  SC-01:','    when: pr',
    '    method: agent','```','',
    '## Acceptance Report','| Criterion | Result | Evidence |',
    '|---|---|---',
    '| SC-01 | Pass | run 100; ref '+oldPrSha+
      '; source agent-qwen; test: historical source |',
  ].join('\n');
  const replaceIssue={number:19,title:'historical',body:replacementBody};
  const replaceContext=buildAcceptanceContext(replaceIssue,'pr',{
    targetRef:newPrSha,runId:207,skipAcceptedPrCriteria:false,method:'agent'});
  const replacementProof={issue:19,previous_pr:31,replacement_pr:32,
    target_ref:newPrSha,comment_id:501,
    old_sources:[oldPrSha],criteria:['SC-01']};
  const replacementRaw=normalizeAcceptanceResult(replaceContext,{
    criteria:[{criterion:'SC-01',result:'Pass',
      evidence:[{type:'test',value:'new independent source fixture'}],
      summary:'independently re-run at replacement head'}]},
    'agent-qwen');
  const replacementResult={...replacementRaw,pr_source_replacement:replacementProof};
  assert.throws(()=>applyAcceptanceResultToBody(replacementBody,replacementResult),
    /cannot be overwritten by unrelated exact head/);
  assert.throws(()=>applyAcceptanceResultToBody(replacementBody,replacementResult,
    {prSourceReplacement:{...replacementProof,comment_id:502}}),
    /cannot be overwritten by unrelated exact head/);
  const replaced=applyAcceptanceResultToBody(replacementBody,replacementResult,
    {prSourceReplacement:replacementProof});
  assert.match(replaced,/\| SC-01 \| Pass \| run 207; ref b{40}; source agent-qwen;/);
  assert.match(replaced,/independent-replacement:31:32:207/);
  assert.match(replaced,/run 100; ref a{40}; source agent-qwen; test: historical source/);
  assert.equal(validateRequirementBody(replaced,{mode:'closure'}).ok,true);
  assert.throws(()=>applyAcceptanceResultToBody(replacementBody,
    {...replacementResult,pr_source_replacement:{...replacementProof,
      criteria:[]}},
    {prSourceReplacement:replacementProof}),/cannot be overwritten/);
  assert.equal(buildAcceptanceContext(replaceIssue,'pr',{
    targetRef:newPrSha,runId:207,method:'agent',
    skipAcceptedPrCriteria:true}).criteria.length,0,
    'normal acceptance never overwrites accepted sources without explicit recovery');

  // #3857: a later PR addressing only a pending post-merge criterion
  // must not redispatch already accepted PR-head SCs on a foreign SHA.
  const exactA='a'.repeat(40),exactB='b'.repeat(40);
  const anchoredBody=[
    '## Success Criteria',
    '- [x] SC-01 original behavior accepted',
    '- [x] SC-02 immutable E2E protection accepted',
    '- [ ] SC-03 live post-merge Audit readback pending',
    '- [x] SC-04 exact-head CI accepted',
    '## Acceptance Plan',
    '\x60\x60\x60yaml',
    'acceptance:',
    '  SC-01:','    when: pr','    method: agent',
    '  SC-02:','    when: pr','    method: agent',
    '  SC-03:','    when: merged','    branch: main','    method: agent',
    '  SC-04:','    when: pr','    method: agent',
    '\x60\x60\x60',
    '## Acceptance Report',
    '| Criterion | Result | Evidence |',
    '|---|---|---|',
    '| SC-01 | Pass | run 1; ref '+exactA+'; source agent-qwen; evidence |',
    '| SC-02 | Pass | run 1; ref '+exactA+'; source agent-qwen; evidence |',
    '| SC-03 | Pending | trusted main readback pending |',
    '| SC-04 | Pass | run 1; ref '+exactA+'; source agent-qwen; evidence |',
  ].join('\n');
  const anchoredIssue={number:3843,title:'Bug: audit readback',body:anchoredBody};
  const foreignPr=buildAcceptanceContext(anchoredIssue,'pr',{
    targetRef:exactB,runId:2,skipAcceptedPrCriteria:true,
  });
  assert.deepEqual(foreignPr.criteria,[],'accepted PR receipts are not re-evaluated');
  assert.deepEqual(buildAcceptanceContext(anchoredIssue,'pr',{
    targetRef:exactA,runId:1,method:'agent',
  }).criteria.map(x=>x.criterion),['SC-01','SC-02','SC-04'],
  'historical readers must retain accepted source criteria; Case-mode contract is exercised separately');
  const pendingPr=buildAcceptanceContext({...anchoredIssue,
    body:anchoredBody.replace('- [x] SC-02 immutable',
      '- [ ] SC-02 immutable').replace('| SC-02 | Pass |','| SC-02 | Pending |')},'pr',{
    targetRef:exactB,runId:2,skipAcceptedPrCriteria:true,
  });
  assert.deepEqual(pendingPr.criteria.map(x=>x.criterion),['SC-02']);
  assert.deepEqual(buildAcceptanceContext(anchoredIssue,'post-merge',{
    targetRef:exactB,runId:3,
  }).criteria.map(x=>x.criterion),['SC-03']);
  // A user-edited Pass without a canonical projected exact-source receipt
  // is NOT an accepted result and must not disappear from audit visibility.
  const inventedPass=anchoredBody.replace(
    'run 1; ref '+exactA+'; source agent-qwen; evidence',
    'human-provided text without source Run');
  assert.deepEqual(buildAcceptanceContext({...anchoredIssue,body:inventedPass},
    'pr',{targetRef:exactB,runId:2,skipAcceptedPrCriteria:true}).criteria.map(x=>x.criterion),['SC-01']);
  // Only checkbox+accepted outcome freezes a prior source; an inconsistent
  // checkbox/report pair does not silently disappear from repair visibility.
  assert.deepEqual(buildAcceptanceContext({...anchoredIssue,
    body:anchoredBody.replace('- [x] SC-04','- [ ] SC-04')},'pr',{
    targetRef:exactB,runId:2,skipAcceptedPrCriteria:true,
  }).criteria.map(x=>x.criterion),['SC-04']);

  // #4146: old model Pass at failing PR Quality is neither immutable success
  // nor a reason to borrow a newer, unrelated PR's green CI. The same
  // implementing PR can be re-evaluated only with actual GitHub ancestry,
  // exact-head Quality success and fully retained historical row evidence.
  const recoveryPr={number:4188,title:'fix (#3843)',body:'Refs #3843',
    state:'closed',merged_at:'2026-11-20T10:17:54Z',
    head:{sha:exactB,repo:{full_name:'BestNathan/nession'}},
    base:{ref:'main',repo:{full_name:'BestNathan/nession'}}};
  const recoveryProof={
    issue:3843,previous:exactA,next:exactB,repo:'BestNathan/nession',
    comparison:{status:'ahead',ahead_by:2,behind_by:0,
      base_commit:{sha:exactA},merge_base_commit:{sha:exactA}},
    previous_pulls:[recoveryPr],next_pulls:[recoveryPr],
  };
  const qualitySucceeded={status:'pass',receipt:{
    kind:'pr_required_quality_v1',
    repository:'BestNathan/nession',workflow:'.github/workflows/ci-quality.yml',
    head_sha:exactB,result:'success',run_id:99,run_attempt:1,
    scope_job_id:98,web_check_job_id:97,
    scope_step:'Classify the exact PR or main-push change',
    web_check_step:'Enforce applicable Quality results at the stable check name',
    job_outcomes:{'instruction-check':'skipped','workflow-check':'skipped',
      'rust-check':'skipped','tooling-check':'success','web-tests':'skipped'},
  }};
  const qualityRecover=verifiedFailedPrQualityRecovery(3843,exactA,exactB,{
    previousQuality:{status:'fail',reason:'old web-check failed'},
    nextQuality:qualitySucceeded,sourceProof:recoveryProof});
  assert.equal(qualityRecover.pr_number,4188);
  for (const bad of [
    {previousQuality:{status:'pass'},nextQuality:qualitySucceeded,sourceProof:recoveryProof},
    {previousQuality:{status:'pending'},nextQuality:qualitySucceeded,sourceProof:recoveryProof},
    {previousQuality:{status:'fail'},nextQuality:{status:'pending'},sourceProof:recoveryProof},
    {previousQuality:{status:'fail'},nextQuality:{...qualitySucceeded,
      receipt:{...qualitySucceeded.receipt,head_sha:exactA}},sourceProof:recoveryProof},
    {previousQuality:{status:'fail'},nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,comparison:{...recoveryProof.comparison,behind_by:1}}},
    {previousQuality:{status:'fail'},nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,next_pulls:[{...recoveryPr,number:4189,
        body:'Supersedes #4188'}]}},
    {previousQuality:{status:'fail'},nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,next_pulls:[{...recoveryPr,
        merged_at:null,state:'closed'}]}},
  ])assert.equal(verifiedFailedPrQualityRecovery(3843,exactA,exactB,bad),null);
  const recoverContext=recoverFailedQualityPrCriteria(anchoredIssue,
    buildAcceptanceContext(anchoredIssue,'pr',{
      targetRef:exactB,runId:200,method:'agent',skipAcceptedPrCriteria:true}),
    {recoveryReader:()=>qualityRecover});
  assert.deepEqual(recoverContext.criteria.map(x=>x.criterion),
    ['SC-01','SC-02','SC-04']);
  const recoveredResult=normalizeAcceptanceResult(recoverContext,{
    criteria:recoverContext.criteria.map(c=>({criterion:c.criterion,result:'Pass',
      evidence:'test: independent Quality and same-PR source proof'})),
  },'agent-qwen');
  const recoveredBody=applyAcceptanceResultToBody(anchoredBody,{
    ...recoveredResult,pr_quality_recovery:{...qualityRecover,criteria:['SC-01','SC-02','SC-04']}},
    {prSourceSupersession:recoveryProof});
  assert.match(recoveredBody,/Acceptance Source Recovery History/);
  assert.match(recoveredBody,/SC-01 prior Pass at a{40}/);
  assert.match(recoveredBody,/SC-04 prior Pass at a{40}/);
  assert.match(recoveredBody,/SC-01 \| Pass \| run 200; ref b{40};/);
  assert.equal(validateRequirementBody(recoveredBody,{mode:'closure'}).ok,false,
    'merged-stage SC-03 remains independently Pending after PR recovery');
  const stillLocked=recoverFailedQualityPrCriteria(anchoredIssue,
    buildAcceptanceContext(anchoredIssue,'pr',{
      targetRef:exactB,runId:200,method:'agent',skipAcceptedPrCriteria:true}),
    {recoveryReader:()=>null});
  assert.deepEqual(stillLocked.criteria,[]);
  // #4204: a GREEN accepted source may advance to its same implementing PR's
  // descendant merged head. Selection restores the locked criteria and the
  // updater rebinds them while preserving the prior row. A different PR,
  // non-descendant head, closed-unmerged PR or failed/pending Quality at
  // either end selects nothing.
  const previousGreen={status:'pass',receipt:{...qualitySucceeded.receipt,
    head_sha:exactA}};
  const advance=verifiedSamePrHeadAdvance(3843,exactA,exactB,{
    previousQuality:previousGreen,nextQuality:qualitySucceeded,
    sourceProof:recoveryProof});
  assert.equal(advance.pr_number,4188);
  assert.equal(advance.qualified_quality_run_id,99);
  for (const bad of [
    {previousQuality:{status:'fail'},nextQuality:qualitySucceeded,sourceProof:recoveryProof},
    {previousQuality:{status:'pending'},nextQuality:qualitySucceeded,sourceProof:recoveryProof},
    {previousQuality:previousGreen,nextQuality:{status:'pending'},sourceProof:recoveryProof},
    {previousQuality:previousGreen,nextQuality:{...qualitySucceeded,
      receipt:{...qualitySucceeded.receipt,head_sha:exactA}},sourceProof:recoveryProof},
    {previousQuality:previousGreen,nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,comparison:{...recoveryProof.comparison,behind_by:1}}},
    {previousQuality:previousGreen,nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,next_pulls:[{...recoveryPr,number:4189,
        body:'Supersedes #4188'}]}},
    {previousQuality:previousGreen,nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,next_pulls:[{...recoveryPr,
        merged_at:null,state:'closed'}]}},
    {previousQuality:previousGreen,nextQuality:qualitySucceeded,
      sourceProof:{...recoveryProof,next_pulls:[{...recoveryPr,head:{...recoveryPr.head,
        sha:exactA}}]}},
  ])assert.equal(verifiedSamePrHeadAdvance(3843,exactA,exactB,bad),null,
    'only the same PR, descendant, green-Quality advance may re-select');
  const advancedContext=recoverAdvancedGreenPrCriteria(anchoredIssue,
    buildAcceptanceContext(anchoredIssue,'pr',{
      targetRef:exactB,runId:300,method:'agent',skipAcceptedPrCriteria:true}),
    {recoveryReader:()=>advance});
  assert.deepEqual(advancedContext.criteria.map(x=>x.criterion),
    ['SC-01','SC-02','SC-04']);
  assert.equal(advancedContext.pr_head_advance.pr_number,4188);
  const noAdvance=recoverAdvancedGreenPrCriteria(anchoredIssue,
    buildAcceptanceContext(anchoredIssue,'pr',{
      targetRef:exactB,runId:300,method:'agent',skipAcceptedPrCriteria:true}),
    {recoveryReader:()=>null});
  assert.deepEqual(noAdvance.criteria,[]);
  const advancedResult=normalizeAcceptanceResult(advancedContext,{
    criteria:advancedContext.criteria.map(c=>({criterion:c.criterion,result:'Pass',
      evidence:'test: source-aligned tests at the advanced head'})),
  },'agent-qwen');
  const advancedBody=applyAcceptanceResultToBody(anchoredBody,{
    ...advancedResult,
    pr_head_advance:{...advance,criteria:['SC-01','SC-02','SC-04']}},
    {prSourceSupersession:recoveryProof});
  assert.match(advancedBody,/SC-01 prior Pass at a{40}/);
  assert.match(advancedBody,/same implementing PR advanced its head/);
  assert.match(advancedBody,/SC-01 \| Pass \| run 300; ref b{40};/);
  assert.equal(validateRequirementBody(advancedBody,{mode:'closure'}).ok,false,
    'merged-stage SC-03 remains independently Pending after the head advance');
  // The old Issue is never silently accepted just because a new Run exists.
  const post = buildAcceptanceContext({ ...issue, body: passedBody }, 'post-merge', {
    targetRef: 'def456', deployment: 'production', runId: 101,
  });
  const fail = normalizeAcceptanceResult(post, {
    criteria: [{
      criterion: 'SC-02',
      result: 'Fail',
      evidence: [{ type: 'smoke', value: 'production reconnect failed' }],
      summary: 'observable failure',
    }],
  }, 'agent-cursor');
  const failedBody = applyAcceptanceResultToBody(passedBody, fail);
  assert.match(failedBody, /- \[ \] SC-02 failing acceptance stays unchecked/);
  assert.match(failedBody, /\| SC-02 \| post-merge \| Fail \| run 101; ref def456;/);
  assert.equal(validateRequirementBody(failedBody, { mode: 'closure' }).ok, false);
  // A rerun retains the workflow run ID but has a different attempt.
  // Only exact-attempt artifact lookup prevents reusing the prior verdict.
  const corrected=normalizeAcceptanceResult(post,{
    criteria:[{criterion:'SC-02',result:'Pass',
      evidence:[{type:'workflow',value:'new attempt independently passed'}],
      summary:'verified correction'}],
  },'agent-cursor');
  const correctedBody=applyAcceptanceResultToBody(failedBody,corrected);
  assert.match(correctedBody, /- \[x\] SC-02 failing acceptance stays unchecked/);
  assert.match(correctedBody, /\| SC-02 \| post-merge \| Pass \| run 101;/);
  assert.equal(applyAcceptanceResultToBody(correctedBody,corrected),correctedBody);
  const workflow=fs.readFileSync(new URL('../.github/workflows/agent-sc-acceptance.yml',
    import.meta.url),'utf8');
  const receipts=[...workflow.matchAll(/^\s*name: (acceptance-result-[^\r\n]+)$/gm)]
    .map(match=>match[1]);
  const exact='acceptance-result-${{ inputs.issue_number }}-${{ inputs.stage }}-${{ github.run_id }}-${{ github.run_attempt }}';
  assert.deepEqual(receipts,[exact,exact],
    'Acceptance upload and download must bind both Run ID and Attempt');
  const renderReceipt=(attempt)=>exact
    .replace('${{ inputs.issue_number }}','1702')
    .replace('${{ inputs.stage }}','post-merge')
    .replace('${{ github.run_id }}','38516094498')
    .replace('${{ github.run_attempt }}',String(attempt));
  assert.equal(renderReceipt(1),'acceptance-result-1702-post-merge-38516094498-1');
  assert.equal(renderReceipt(2),'acceptance-result-1702-post-merge-38516094498-2');
  assert.notEqual(renderReceipt(1),renderReceipt(2));

  assert.throws(
    () => normalizeAcceptanceResult(staging, { criteria: [{ criterion: 'SC-99', result: 'Pass', evidence: 'ghost' }] }),
    /unknown or wrong-stage/
  );
  assert.throws(() => normalizeAcceptanceResult(staging, { criteria: [] }), /missing criteria: SC-01/);
  assert.throws(() => applyAcceptanceResultToBody(issue.body, { ...pass, criteria: [] }), /missing criteria: SC-01/);
  assert.throws(
    () => normalizeAcceptanceResult(staging, { criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: 'implementation pending' }] }),
    /requires concrete evidence/
  );

  // #2860: a model's text about a successful Issue Audit is NOT proof. An
  // exact-target, exact-run attested receipt is required and owns the final
  // evidence rather than allowing a wrong/skipped run in model prose.
  const pinned=SIDEBAR_AUDIT_REPAIR_PROOF;
  const sourceProof={
    status:'authenticated-historical-repair-readback',
    source_run_id:pinned.sourceRunId,source_attempt:pinned.sourceAttempt,
    target_issue:pinned.targetIssueNumber,source_event:pinned.event,
    provider:'qwen',issue_contract_pass:true,
    owner_trigger_verified:true,source_main_ancestry_confirmed:true,
    verified_risk_tier:'verification:scoped',
    source_job_id:927,source_sha:'a'.repeat(40),
    label_event_ids:[123,124],protected_e2e_selected_ids:pinned.expectedE2EIds,
  };
  const auditContext={
    issue:{number:pinned.acceptanceIssue},stage:'post-merge',
    ci_evidence:{authenticated_issue_audit_repair_readback:sourceProof},
  };
  const forged={
    criteria:[{criterion:pinned.criterion,result:'Pass',evidence:[
      {type:'workflow',value:'wrong successful run 42219064219 with skipped agent'}
    ],summary:'wrong run passed'}],
  };
  const fixed=verifiedIssueAuditCriterion(auditContext,forged);
  assert.deepEqual(fixed.criteria[0].evidence,[{
    type:'authenticated-issue-audit',
    value:'run '+pinned.sourceRunId+'/'+pinned.sourceAttempt+
      ', agent job 927, target #'+pinned.targetIssueNumber+
      ', source '+sourceProof.source_sha+
      ', owner-triggered main ancestor, tier verification:scoped'+
      ', verified canonical Issue/E2E and bot label writes',
  }]);
  assert.doesNotMatch(fixed.criteria[0].summary,/42219064219/);
  for(const invalid of [
    null,{...sourceProof,source_run_id:42219064219},
    {...sourceProof,target_issue:2855},
    {...sourceProof,source_job_id:0},
    {...sourceProof,source_attempt:2},
    {...sourceProof,label_event_ids:[]},
    {...sourceProof,owner_trigger_verified:false},
    {...sourceProof,source_main_ancestry_confirmed:false},
    {...sourceProof,verified_risk_tier:null},
    {...sourceProof,protected_e2e_selected_ids:['unrelated']},
  ])assert.throws(()=>verifiedIssueAuditCriterion({...auditContext,
    ci_evidence:{authenticated_issue_audit_repair_readback:invalid}},forged),
    /lacks authenticated exact-target/);
  assert.equal(verifiedIssueAuditCriterion({...auditContext,ci_evidence:null},{
    criteria:[{criterion:pinned.criterion,result:'Pending',evidence:[],summary:'Not proven'}],
  }).criteria[0].result,'Pending');

  // Live #42224832591: a historical source was attested by the dedicated
  // collector, but the model returned Pending solely because an unrelated
  // generic source_ancestry array was empty. The trusted exact-source proof
  // owns this historical assertion, so normalize it to Pass deterministically.
  const uncertain={criteria:[{
    criterion:pinned.criterion,result:'Pending',
    evidence:[{type:'workflow',value:'source_ancestry was empty'}],
    summary:'Model cannot infer historical ancestry from the generic list',
  }]};
  const proven=verifiedIssueAuditCriterion(auditContext,uncertain);
  assert.equal(proven.criteria[0].result,'Pass');
  assert.deepEqual(proven.criteria[0].evidence,fixed.criteria[0].evidence);
  const without=verifiedIssueAuditCriterion({...auditContext,ci_evidence:null},uncertain);
  assert.equal(without.criteria[0].result,'Pending');
  assert.equal(verifiedIssueAuditCriterion(auditContext,{
    criteria:[{criterion:pinned.criterion,result:'Fail',evidence:[],summary:'Contradictory live failure'}],
  }).criteria[0].result,'Fail');
  for(const tampered of [
    {...sourceProof,owner_trigger_verified:false},
    {...sourceProof,source_main_ancestry_confirmed:false},
    {...sourceProof,verified_risk_tier:'verification:integration'},
  ])assert.equal(verifiedIssueAuditCriterion({...auditContext,
    ci_evidence:{authenticated_issue_audit_repair_readback:tampered}},
    uncertain).criteria[0].result,'Pending');

  // #3843: An exact owner-command, Agent job and repaired target readback
  // can decide SC-03 independently; a model's unsupported Pass is rejected.
  const repair3843=ISSUE_AUDIT_3843_PROOF,repairSha='e50fa7672740164222c1168416c1e5784927847a';
  const completeProof={
    status:'authenticated-repair-readback',
    source_run_id:repair3843.sourceRunId,source_attempt:repair3843.sourceAttempt,
    target_issue:repair3843.targetIssueNumber,source_event:'workflow_dispatch',
    source_sha:repairSha,target_sha:repairSha,provider:'qwen',
    source_comment_id:repair3843.sourceCommentId,
    repair_comment_id:repair3843.repairCommentId,
    owner_trigger_verified:true,repair_ack_verified:true,
    issue_contract_pass:true,verified_risk_tier:'verification:integration',
    protected_e2e_rows:0,protected_e2e_selected_ids:[],
    protected_e2e_none_verified:true,label_event_ids:[1,2,3,4],
    source_job_id:42,
  };
  const repairedContext={issue:{number:repair3843.acceptanceIssue},
    target_ref:repairSha,stage:'post-merge',
    ci_evidence:{authenticated_issue_audit_3843_readback:completeProof}};
  const pendingRepair={criteria:[{criterion:'SC-03',result:'Pending',evidence:[],
    summary:'model cannot see the cross-Issue source Run'}]};
  assert.equal(verifiedIssueAudit3843Criterion(repairedContext,pendingRepair)
    .criteria[0].result,'Pass');
  assert.equal(verifiedIssueAudit3843Criterion({...repairedContext,ci_evidence:null},
    pendingRepair).criteria[0].result,'Pending');
  assert.throws(()=>verifiedIssueAudit3843Criterion(
    {...repairedContext,ci_evidence:null},{criteria:[{
      criterion:'SC-03',result:'Pass',evidence:[],summary:'untrusted claim'}]}),
    /lacks authenticated #3837/);
  for(const tampered of [
    {source_run_id:0},{target_issue:3843},{source_sha:'f'.repeat(40)},
    {source_comment_id:1},{repair_ack_verified:false},
    {protected_e2e_rows:1},{protected_e2e_none_verified:false},
    {label_event_ids:[]},
  ])assert.equal(verifiedIssueAudit3843Criterion({...repairedContext,
    ci_evidence:{authenticated_issue_audit_3843_readback:{...completeProof,...tampered}}},
    pendingRepair).criteria[0].result,'Pending');
  assert.equal(verifiedIssueAudit3843Criterion(repairedContext,{criteria:[{
    criterion:'SC-03',result:'Fail',evidence:[],summary:'trusted conflicting failure'}]})
    .criteria[0].result,'Fail');

  // #3545: a later read-only Agent on tooling PR #3540 cannot downgrade the
  // already accepted implementation PR #3529, even with a larger run ID.
  const hostingHead = '7c7d36f9456d901d252abcfbbe5d2a991f202ba7';
  const toolingHead = '06857762ece34cf9cbcd50c21454470ed39456f1';
  const prBody = fixtureBody()
    .replace('staging | Pending', 'pr | Pending')
    .replace('staging | Pass', 'pr | Pass');
  const prIssue = { ...issue, body: prBody };
  const first = normalizeAcceptanceResult(buildAcceptanceContext(prIssue, 'pr',
    {targetRef: hostingHead,runId: 43607237629}), {
    criteria:[{criterion:'SC-01',result:'Pass',
      evidence:'test: exact-head source aligned Web acceptance'}]}, 'agent-qwen');
  const accepted = applyAcceptanceResultToBody(prBody, first);
  const later = normalizeAcceptanceResult(buildAcceptanceContext(prIssue, 'pr',
    {targetRef: toolingHead,runId: 43611457037}), {
    criteria:[{criterion:'SC-01',result:'Fail',evidence:'test: unrelated source'}]},
  'agent-qwen');
  assert.throws(()=>applyAcceptanceResultToBody(accepted,later),
    /accepted PR source .* cannot be overwritten/);
  const properRetry = normalizeAcceptanceResult(buildAcceptanceContext(prIssue, 'pr',
    {targetRef: hostingHead,runId: 43611749900}), {
    criteria:[{criterion:'SC-01',result:'Pass',evidence:'test: recovered exact-head check'}]},
  'agent-qwen');
  assert.match(applyAcceptanceResultToBody(accepted,properRetry),/run 43611749900/);
  const sourcePr=(number,sha,body='Fixes #1360')=>({
    number,body,title:'fix (#1360)',head:{sha,repo:{full_name:'BestNathan/nession'}},
    base:{ref:'staging',repo:{full_name:'BestNathan/nession'}}});
  const compare={status:'ahead',ahead_by:1,behind_by:0,
    base_commit:{sha:hostingHead},merge_base_commit:{sha:hostingHead}};
  const proof={issue:1360,previous:hostingHead,next:toolingHead,
    repo:'BestNathan/nession',comparison:compare,
    previous_pulls:[sourcePr(3529,hostingHead)],
    next_pulls:[sourcePr(3540,toolingHead)]};
  assert.equal(verifiedPrSourceSupersession(1360,hostingHead,toolingHead,proof),false,
    'a later implementing PR must explicitly supersede the original');
  const successor={...sourcePr(3540,toolingHead,'Fixes #1360\nSupersedes #3529')};
  assert.equal(verifiedPrSourceSupersession(1360,hostingHead,toolingHead,
    {...proof,next_pulls:[successor]}),true);
  assert.match(applyAcceptanceResultToBody(accepted,later,
    {prSourceSupersession:{...proof,next_pulls:[successor]}}),/run 43611457037/);
  for(const bad of [
    {...proof,comparison:{...compare,behind_by:1},next_pulls:[successor]},
    {...proof,next_pulls:[{...successor,body:'Refs #1360\nSupersedes #3529',
      title:'tooling (#3479)'}]},
    {...proof,previous_pulls:[],next_pulls:[successor]},
    {...proof,next_pulls:[successor],issue:1361},
  ]) assert.equal(verifiedPrSourceSupersession(1360,hostingHead,toolingHead,bad),false);
  // #3581: GitHub evidence is projected and buffered. A large compare/PR
  // response overflowed the historical unbounded spawnSync buffer; the
  // collector must request only the needed fields and cap its child buffer.
  const savedRepo=process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY='BestNathan/nession';
  const evidenceCalls=[];
  const boundedEvidence=(args,options)=>{
    evidenceCalls.push({args,options});
    const path=args[1];
    assert.ok(args.includes('--jq'),'the evidence request must project only required fields: '+path);
    assert.equal(options?.maxBuffer,GITHUB_EVIDENCE_MAX_BUFFER,
      'the evidence child buffer must use the explicit safe cap');
    if(path.includes('/compare/')) return JSON.stringify(compare);
    if(path.endsWith('/pulls?per_page=100')) {
      return JSON.stringify(path.includes(hostingHead)
        ? [sourcePr(3529,hostingHead)] : [successor]);
    }
    throw new Error('unexpected evidence path '+path);
  };
  const live=livePrSourceSupersession(1360,hostingHead,toolingHead,boundedEvidence);
  assert.equal(live.comparison.ahead_by,1);
  assert.equal(live.previous_pulls.length,1);
  assert.equal(live.next_pulls.length,1);
  assert.equal(verifiedPrSourceSupersession(1360,hostingHead,toolingHead,live),true);
  assert.equal(evidenceCalls.length,3);
  // A response larger than the cap, invalid JSON, a missing comparison or an
  // incomplete PR page must fail closed instead of projecting fabricated
  // evidence.
  const enobufs=Object.assign(new Error('spawnSync gh ENOBUFS'),{code:'ENOBUFS'});
  assert.throws(()=>livePrSourceSupersession(1360,hostingHead,toolingHead,()=>{throw enobufs}),
    /exceeded the 8388608-byte bound/);
  assert.throws(()=>livePrSourceSupersession(1360,hostingHead,toolingHead,()=>'{"status":'),
    /truncated or not valid JSON/);
  const noCompare=args=>args[1].includes('/compare/')
    ? JSON.stringify({status:'ahead'}) : JSON.stringify([]);
  assert.throws(()=>livePrSourceSupersession(1360,hostingHead,toolingHead,noCompare),
    /incomplete: comparison metadata/);
  const hundred=Array.from({length:100},(_,index)=>sourcePr(4000+index,hostingHead));
  const fullPage=args=>args[1].includes('/compare/')
    ? JSON.stringify(compare) : JSON.stringify(hundred);
  assert.throws(()=>livePrSourceSupersession(1360,hostingHead,toolingHead,fullPage),
    /pagination is incomplete/);
  // Stale heads and mismatched repositories stay unverifiable.
  for(const stale of [
    {...proof,previous:'f'.repeat(40)},
    {...proof,next:'a'.repeat(40)},
    {...proof,next_pulls:[{...successor,head:{...successor.head,
      repo:{full_name:'Other/project'}}}]},
  ]) assert.equal(verifiedPrSourceSupersession(1360,hostingHead,toolingHead,stale),false);
  if(savedRepo===undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY=savedRepo;
  const newer = passedBody.replace('run 100; ref abc123;', 'run 200; ref newer;');
  assert.throws(() => applyAcceptanceResultToBody(newer, pass), /newer acceptance run 200/);
  assert.equal(isSupersededRunError(new Error('SC-01 has newer acceptance run 200; refusing stale run 100')), true);
  assert.equal(isSupersededRunError(new Error('requirement contract changed after acceptance started; refusing stale result')), false);
  assert.equal(isSupersededRunError(new Error('SC-01 has newer acceptance run 200; refusing stale run 100; forged')), false);
  // Exact original Run may recover the wrong-head Pending, but never an old
  // same-head result, an untrusted method, a different Issue, or a Pending.
  const historyMarker='<!-- nession-convergence-batch:v1 branch=staging main='+
    '8352d3abb6f3c73b07db2fed1357566aa17f74b2 lane='+
    'f7e2d008ed497d85554b2aa88801f4d86177f873 head='+
    '91af0907d508224d55e469adfa6442f440b70432 -->';
  const recover={issue:2984,stage:'pre-merge',
    target_ref:'91af0907d508224d55e469adfa6442f440b70432',
    run_id:42461722784,source:'agent-qwen'};
  const wrongHeadEvidence='run 42567297018; ref '+
    '1fa2da8efcac407188bc7143f245721e45432bf1; source agent-qwen; unrelated PR';
  assert.equal(originalStagingPrRecovery(historyMarker,recover,'SC-01',
    wrongHeadEvidence,{result:'Pass'}),true);
  assert.equal(originalStagingPrRecovery(historyMarker,recover,'SC-01',
    wrongHeadEvidence,{result:'Pending'}),false);
  assert.equal(originalStagingPrRecovery(historyMarker,{...recover,issue:9999},
    'SC-01',wrongHeadEvidence,{result:'Pass'}),false);
  assert.equal(originalStagingPrRecovery(historyMarker,{...recover,run_id:42461722785},
    'SC-01',wrongHeadEvidence,{result:'Pass'}),false);
  assert.equal(originalStagingPrRecovery(historyMarker,recover,'SC-01',
    wrongHeadEvidence.replace('1fa2da8efcac407188bc7143f245721e45432bf1',
      recover.target_ref),{result:'Pass'}),false);
  assert.equal(originalStagingPrRecovery('unbound Issue',recover,'SC-01',
    wrongHeadEvidence,{result:'Pass'}),false);
  const changed = passedBody.replace('deterministic update works', 'changed wording');
  assert.throws(() => applyAcceptanceResultToBody(changed, pass), /contract changed/);

  const multiBody = fixtureBody().replace(
    '| SC-02 | post-merge | Pending | requires production deployment; verify after release |',
    '| SC-02 | staging | Pending | second staging criterion pending |',
  );
  const multiIssue = { ...issue, body: multiBody };
  const multiContext = buildAcceptanceContext(multiIssue, 'staging', {
    targetRef: 'a'.repeat(40),
    deployment: 'staging',
    runId: 300,
  });
  assert.deepEqual(multiContext.criteria.map((item) => item.criterion), ['SC-01', 'SC-02']);
  const caseProjection = normalizeAcceptanceCaseResult(multiContext, {
    issue: 1360,
    criterion: 'SC-01',
    stage: 'staging',
    target_sha: 'a'.repeat(40),
    contract_sha256: multiContext.contract_sha256,
    execution_id: 'b'.repeat(64),
    case_tree_sha: 'c'.repeat(40),
    case_revision: 'a'.repeat(40),
    result: 'Pass',
    verifiers: [{
      type: 'runtime',
      result: 'Pass',
      summary: 'runtime proof',
      evidence: [{ type: 'runtime', value: 'proof=ok' }],
    }],
  });
  assert.deepEqual(caseProjection.selected_criteria, ['SC-01']);
  const partialBody = applyAcceptanceResultToBody(multiBody, caseProjection);
  assert.match(partialBody, /\| SC-01 \| staging \| Pass \| run 300;/);
  assert.match(partialBody, /\| SC-02 \| staging \| Pending \| second staging criterion pending \|/);
  assert.throws(
    () => applyAcceptanceResultToBody(multiBody, { ...caseProjection, selected_criteria: ['SC-99'] }),
    /unknown or belongs to another stage/,
  );

  // Explicit SC plan: Agent-only and executable proofs are disjoint.
  // Deployed cases must NOT be verified merely by a main merged SHA.
  const plannedBody = fixtureBody().replace('## Product alignment', [
    '## Acceptance Plan', '',
    '\x60\x60\x60yaml',
    'acceptance:',
    '  SC-01:',
    '    when: merged',
    '    branch: staging',
    '    method: case',
    '  SC-02:',
    '    when: deployed',
    '    environment: production',
    '    method: case',
    '\x60\x60\x60', '', '## Product alignment',
  ].join('\n').replace(/\\x60/g, '\x60'));
  const plannedIssue = { ...issue, body: plannedBody };
  const agentOnly = buildAcceptanceContext(plannedIssue, 'staging', {
    targetRef: 'a'.repeat(40), runId: 400, method: 'agent',
  });
  const caseOnly = buildAcceptanceContext(plannedIssue, 'staging', {
    targetRef: 'a'.repeat(40), runId: 400, method: 'case',
  });
  assert.deepEqual(agentOnly.criteria, []);
  assert.deepEqual(caseOnly.criteria.map((entry) => entry.criterion), ['SC-01']);
  assert.notEqual(caseOnly.contract_sha256, staging.contract_sha256);
  const mainMergedCase = buildAcceptanceContext(plannedIssue, 'post-merge', {
    targetRef: 'b'.repeat(40), runId: 401, method: 'case',
  });
  assert.deepEqual(mainMergedCase.criteria, []);
  // A deployed run selects only the criteria bound to its exact environment,
  // and only when the caller supplies a trusted attested binding.
  const deployedContext = buildAcceptanceContext(plannedIssue, 'post-merge', {
    targetRef: 'b'.repeat(40), runId: 402, method: 'case',
    deploymentBinding: { environment_id: 'production', attested: true },
  });
  assert.deepEqual(deployedContext.criteria.map((entry) => entry.criterion), ['SC-02']);
  assert.equal(deployedContext.deployment_binding.environment_id, 'production');
  assert.deepEqual(buildAcceptanceContext(plannedIssue, 'post-merge', {
    targetRef: 'b'.repeat(40), runId: 403, method: 'case',
    deploymentBinding: { environment_id: 'production', attested: false },
  }).criteria, []);
  assert.deepEqual(buildAcceptanceContext(plannedIssue, 'post-merge', {
    targetRef: 'b'.repeat(40), runId: 404, method: 'case',
    deploymentBinding: { environment_id: 'staging-01', attested: true },
  }).criteria, []);
  // A deployed binding never selects branch-stage criteria as well.
  assert.deepEqual(buildAcceptanceContext(plannedIssue, 'staging', {
    targetRef: 'b'.repeat(40), runId: 405, method: 'case',
    deploymentBinding: { environment_id: 'production', attested: true },
  }).criteria, []);
  assert.throws(() => buildAcceptanceContext(plannedIssue, 'post-merge', {
    targetRef: 'b'.repeat(40), runId: 406, method: 'case',
    deploymentBinding: { environment_id: 'Bad Lane', attested: true },
  }), /deployment binding environment is invalid/);

  // The Case runner emits the same deployment block the ingester validates.
  const deploymentFixture = {
    environment_id: 'staging-01', attested: true,
    attestation_execution_id: 'e'.repeat(64),
    gitops_revision: 'f'.repeat(40),
    image_digests: {
      agent: 'sha256:' + '1'.repeat(64),
      server: 'sha256:' + '2'.repeat(64),
      ui: 'sha256:' + '3'.repeat(64),
    },
  };
  const boundRecord = deploymentRecord(deploymentFixture, 'b'.repeat(40));
  assert.equal(boundRecord.environment_id, 'staging-01');
  assert.equal(boundRecord.deployed_source_sha, 'b'.repeat(40));
  assert.equal(deploymentRecord(null, 'b'.repeat(40)), null);
  assert.throws(() => deploymentRecord({ ...deploymentFixture, attested: false }, 'b'.repeat(40)),
    /must be attested/);
  assert.throws(() => deploymentRecord({ ...deploymentFixture, image_digests: { agent: 'latest' } },
    'b'.repeat(40)), /not immutable/);
  assert.throws(() => deploymentRecord({ ...deploymentFixture, gitops_revision: 'short' },
    'b'.repeat(40)), /40-character/);
  assert.throws(() => normalizeAcceptanceCaseResult(agentOnly, {
    issue: 1360, stage: 'staging', criterion: 'SC-01',
    contract_sha256: agentOnly.contract_sha256, target_sha: agentOnly.target_ref,
  }), /criterion is absent/);

  const mixedBody = plannedBody
    .replace('| SC-02 | post-merge | Pending |', '| SC-02 | staging | Pending |')
    .replace('    method: case\n  SC-02:', '    method: agent\n  SC-02:')
    .replace('    when: deployed\n    environment: production\n    method: case',
      '    when: merged\n    branch: staging\n    method: case');
  const mixedIssue = { ...issue, body: mixedBody };
  const mixedAgent = buildAcceptanceContext(mixedIssue, 'staging', {
    targetRef: 'c'.repeat(40), runId: 420, method: 'agent',
  });
  const mixedCase = buildAcceptanceContext(mixedIssue, 'staging', {
    targetRef: 'c'.repeat(40), runId: 421, method: 'case',
  });
  assert.deepEqual(mixedAgent.criteria.map((x) => x.criterion), ['SC-01']);
  assert.deepEqual(mixedCase.criteria.map((x) => x.criterion), ['SC-02']);
  const mixedAgentResult = normalizeAcceptanceResult(mixedAgent, {
    criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: 'test: exact SHA static proof' }],
  }, 'agent-cursor');
  assert.deepEqual(mixedAgentResult.selected_criteria, ['SC-01']);
  const mixedAgentBody = applyAcceptanceResultToBody(mixedBody, mixedAgentResult);
  assert.match(mixedAgentBody, /\| SC-02 \| staging \| Pending \|/);
  const forgedCase = normalizeAcceptanceResult(mixedCase, {
    criteria: [{ criterion: 'SC-02', result: 'Pass', evidence: 'test: runtime execution proof' }],
  }, 'agent-cursor');
  assert.throws(() => applyAcceptanceResultToBody(mixedAgentBody, forgedCase), /selected method does not match/);
  const mixedCaseResult = { ...forgedCase, source: 'case-runner' };
  const fullyAccepted = applyAcceptanceResultToBody(mixedAgentBody, mixedCaseResult);
  assert.match(fullyAccepted, /\| SC-01 \| staging \| Pass \|/);
  assert.match(fullyAccepted, /\| SC-02 \| staging \| Pass \|/);

  // Plan is the only source of timing/method in the canonical v2 format.
  // The read-only plan and trusted projector must derive exactly the same
  // compatibility stage as the old explicit four-column representation.
  const v2Body = mixedBody
    .replace('| Criterion | Stage | Result | Evidence |', '| Criterion | Result | Evidence |')
    .replace('|---|---|---|---|', '|---|---|---|')
    .replace('| SC-01 | staging | Pending |', '| SC-01 | Pending |')
    .replace('| SC-02 | staging | Pending |', '| SC-02 | Pending |');
  const v2Issue = { ...issue, body: v2Body };
  const v2Agent = buildAcceptanceContext(v2Issue, 'staging', {
    targetRef: 'c'.repeat(40), runId: 420, method: 'agent',
  });
  const v2Case = buildAcceptanceContext(v2Issue, 'staging', {
    targetRef: 'c'.repeat(40), runId: 421, method: 'case',
  });
  assert.equal(v2Agent.contract_sha256, mixedAgent.contract_sha256);
  assert.equal(v2Case.contract_sha256, mixedCase.contract_sha256);
  assert.deepEqual(v2Agent.criteria.map((x) => x.criterion), ['SC-01']);
  assert.deepEqual(v2Case.criteria.map((x) => x.criterion), ['SC-02']);
  const v2Accepted = applyAcceptanceResultToBody(v2Body,
    normalizeAcceptanceResult(v2Agent, {
      criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: 'test: source and CI tied to SHA' }],
    }, 'agent-cursor'));
  assert.match(v2Accepted, /\| SC-01 \| Pass \| run 420;/);
  assert.match(v2Accepted, /\| SC-02 \| Pending \|/);
  assert.doesNotMatch(v2Accepted, /\| SC-01 \| staging \|/);
  assert.throws(() => applyAcceptanceResultToBody(v2Body,
    normalizeAcceptanceResult(v2Agent, {
      criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: 'test: source and CI tied to SHA' }],
    }, 'case-runner')), /selected method does not match/);

  // The projector must not accept a raw Pass without a source-bound Web
  // execution receipt; pure static SCs keep their normal source-proof path.
  // Here a text claim is intentional: 'source' is reserved for a declared,
  // pinned orphan-branch manifest, independently rejected by #3068's owner.
  const webBody = fixtureBody()
    .replace('SC-01 deterministic update works',
      'SC-01 A deterministic integration test records Web navigation requests and verifies retries')
    .replace('## Product alignment', 'Scenario: Web integration fixtures\n\n## Product alignment')
    .replace('| SC-01 | staging |', '| SC-01 | pr |');
  const webIssue = { ...issue, body: webBody };
  const webContext = buildAcceptanceContext(webIssue, 'pr', {
    targetRef: 'a'.repeat(40), runId: 700, method: 'agent',
  });
  const rawWebPass = normalizeAcceptanceResult(webContext, {
    criteria: [{ criterion: 'SC-01', result: 'Pass',
      evidence: [{ type: 'text', value: 'Code inspection alone is not an authenticated exact-head Web Quality receipt' }] }],
  }, 'agent-cursor');
  assert.throws(() => applyAcceptanceResultToBody(webBody, rawWebPass),
    /lacks authenticated exact-head Web Quality receipt/);
  const downgraded = enforcePrWebQuality(webContext, rawWebPass);
  assert.equal(downgraded.criteria[0].result, 'Pending');
  assert.match(applyAcceptanceResultToBody(webBody, downgraded),
    /\| SC-01 \| pr \| Pending \|/);
  // The same barrier applies to an explicit exact-head Rust Quality
  // obligation: source review alone cannot project Pass (#3584 SC-02).
  const rustBody = fixtureBody()
    .replace('SC-01 deterministic update works',
      'SC-01 Exact-head Rust coverage/Quality on the repair PR completes successfully')
    .replace('| SC-01 | staging |', '| SC-01 | pr |');
  const rustBodyContext = buildAcceptanceContext({ ...issue, body: rustBody }, 'pr', {
    targetRef: 'a'.repeat(40), runId: 701, method: 'agent',
  });
  const rawRustPass = normalizeAcceptanceResult(rustBodyContext, {
    criteria: [{ criterion: 'SC-01', result: 'Pass',
      evidence: [{ type: 'text', value: 'Source inspection is not an exact-head Rust Quality receipt' }] }],
  }, 'agent-cursor');
  assert.throws(() => applyAcceptanceResultToBody(rustBody, rawRustPass),
    /lacks authenticated exact-head Rust Quality receipt/);
  const rustDowngraded = enforcePrRustQuality(rustBodyContext, rawRustPass);
  assert.equal(rustDowngraded.criteria[0].result, 'Pending');
  assert.match(applyAcceptanceResultToBody(rustBody, rustDowngraded),
    /\| SC-01 \| pr \| Pending \|/);

  // A green publisher job must never be projected as a live failure->Bug Pass.
  const failureText='Full Regression failed exact-Main-SHA observations enter deduplicated Bug repair flow';
  assert.equal(requiresLiveFullFailureProof(failureText),true);
  const failureContext={stage:'post-merge',criteria:[{criterion:'SC-03',text:failureText}],
    ci_evidence:{verified_live_main_full_failure_publication:{status:'Pending',
      reason:'missing authenticated failed Main Full source'}}};
  const fakePublisher={criteria:[{criterion:'SC-03',result:'Pass',
    evidence:[{type:'workflow',value:'successful Acceptance / E2E Failure Bug push run'}],
    summary:'live publication proved'}]};
  assert.equal(enforceLiveFullFailure(failureContext,fakePublisher).criteria[0].result,'Pending');
  assert.equal(enforceLiveFullFailure({...failureContext,ci_evidence:null},fakePublisher)
    .criteria[0].result,'Pending');
  // Existing acceptance-executor-selftest Gate also exercises the exact-PR
  // collector. These fixtures run without GitHub secrets or network calls.
  execFileSync(process.execPath,
    [fileURLToPath(new URL('./acceptance-pr-web-quality-receipt.mjs',import.meta.url)),'self-test'],
    {stdio:'inherit'});
  execFileSync(process.execPath,
    [fileURLToPath(new URL('./acceptance-staging-batch-pr-evidence.mjs',import.meta.url)),'self-test'],
    {stdio:'inherit'});
  execFileSync(process.execPath,
    [fileURLToPath(new URL('./acceptance-pr-quality-waker.mjs',import.meta.url)),'self-test'],
    {stdio:'inherit'});
  console.log('acceptance-executor self-test: legacy, mixed-method and provenance cases passed');
}

function usage() {
  return 'usage: acceptance-executor.mjs <self-test|prepare ISSUE STAGE TARGET_REF OUT [DEPLOYMENT] [CI_EVIDENCE_JSON]|normalize-result CONTEXT RAW OUT SOURCE|apply ISSUE RESULT>';
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'prepare') {
    if (args.length < 4) throw new Error(usage());
    return prepareCommand(Number(args[0]), args[1], args[2], args[3], args[4], args[5]);
  }
  if (command === 'normalize-result') {
    if (args.length < 4) throw new Error(usage());
    return normalizeCommand(args[0], args[1], args[2], args[3]);
  }
  if (command === 'apply') {
    if (args.length < 2) throw new Error(usage());
    return applyCommand(Number(args[0]), args[1]);
  }
  throw new Error(usage());
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
