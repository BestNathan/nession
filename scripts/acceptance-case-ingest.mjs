#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  applyAcceptanceResultToBody,
  buildAcceptanceContext,
  normalizeAcceptanceCaseResult,
} from './acceptance-executor.mjs';
import { extractSection, isAcceptanceIssue, parseAcceptanceReport, parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';
import { artifactEvidence, validateArtifactEvidence } from './run-record-artifact-evidence.mjs';
import { makeRunIndex } from './run-record-index-contract.mjs';
import { enrichReceipt, validateStoredRecord } from './deployment-attestation-ingest.mjs';

const RESULTS = new Set(['Pass', 'Fail', 'Pending', 'Error']);
const STAGES = new Set(['pre-merge', 'staging', 'post-merge']);
const DEPLOYMENT_ROLES = Object.freeze(['agent', 'server', 'ui']);
const DEPLOYMENT_ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(label + ' must be a positive integer');
  return n;
}

function sha(value, length, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!new RegExp('^[0-9a-f]{' + length + '}$').test(text)) {
    throw new Error(label + ' must be a ' + length + '-character hex digest');
  }
  return text;
}

function singleLine(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /[\r\n]/.test(text)) throw new Error(label + ' must be a non-empty single line');
  return text;
}

function aggregate(verifiers) {
  if (verifiers.some((item) => item.result === 'Error')) return 'Error';
  if (verifiers.some((item) => item.result === 'Fail')) return 'Fail';
  if (verifiers.some((item) => item.result === 'Pending')) return 'Pending';
  return verifiers.length > 0 && verifiers.every((item) => item.result === 'Pass')
    ? 'Pass'
    : 'Pending';
}

export function validateCaseRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Case record must be an object');
  if (Number(raw.schema_version) !== 1 || raw.kind !== 'acceptance_case_result') {
    throw new Error('unsupported Case record schema');
  }
  const issue = positiveInt(raw.issue, 'issue');
  const criterion = String(raw.criterion ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid Case criterion');
  const stage = String(raw.stage ?? '').trim();
  if (!STAGES.has(stage)) throw new Error('invalid Case stage');
  const targetSha = sha(raw.target_sha, 40, 'target_sha');
  const caseRevision = sha(raw.case_revision, 40, 'case_revision');
  if (caseRevision !== targetSha) {
    throw new Error('source-aligned Case revision must equal target_sha');
  }
  const caseTreeSha = sha(raw.case_tree_sha, 40, 'case_tree_sha');
  const contractSha256 = sha(raw.contract_sha256, 64, 'contract_sha256');
  const executionId = sha(raw.execution_id, 64, 'execution_id');
  const runId = positiveInt(raw.run_id, 'run_id');
  const runAttempt = positiveInt(raw.run_attempt, 'run_attempt');
  // A deployed proof binds the Case to one attested environment and immutable
  // deployment identity. It is optional for legacy branch-stage records and
  // required only when the SC's plan says `when: deployed`.
  let deployment = null;
  if (raw.deployment !== undefined && raw.deployment !== null) {
    const block = raw.deployment;
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('deployment binding must be an object');
    }
    const environmentId = String(block.environment_id ?? '');
    if (!DEPLOYMENT_ENVIRONMENT.test(environmentId)) {
      throw new Error('invalid deployment environment_id');
    }
    if (block.deployed_source_sha !== targetSha) {
      throw new Error('deployment source SHA must equal the Case target_sha');
    }
    const attestationExecutionId = sha(
      block.attestation_execution_id, 64, 'attestation_execution_id');
    const gitopsRevision = sha(block.gitops_revision, 40, 'gitops_revision');
    const digests = block.image_digests;
    if (!digests || typeof digests !== 'object' || Array.isArray(digests)) {
      throw new Error('deployment image_digests must be an object');
    }
    const unknown = Object.keys(digests).filter((role) => !DEPLOYMENT_ROLES.includes(role));
    if (unknown.length) throw new Error('unknown deployment image role');
    const normalized = {};
    for (const role of DEPLOYMENT_ROLES) {
      const value = String(digests[role] ?? '');
      if (!IMAGE_DIGEST.test(value)) {
        throw new Error(role + ' deployment image digest is not immutable');
      }
      normalized[role] = value;
    }
    deployment = {
      environment_id: environmentId,
      deployed_source_sha: targetSha,
      attestation_execution_id: attestationExecutionId,
      gitops_revision: gitopsRevision,
      image_digests: normalized,
    };
  }
  if (raw.evidence !== undefined) {
    validateArtifactEvidence(raw.evidence, {
      mode: 'acceptance', run_id: runId, run_attempt: runAttempt,
      source_record_sha256: raw.provenance?.source_result_sha256,
      workflow_url: raw.provenance?.workflow_url,
    });
  }
  const result = String(raw.result ?? '');
  if (!RESULTS.has(result)) throw new Error('invalid Case result: ' + result);
  if (!Array.isArray(raw.verifiers) || raw.verifiers.length === 0) {
    throw new Error('Case record requires verifier outcomes');
  }
  for (const [index, verifier] of raw.verifiers.entries()) {
    if (!['browser', 'protocol', 'runtime'].includes(String(verifier.type))) {
      throw new Error('invalid verifier type at index ' + index);
    }
    if (!RESULTS.has(String(verifier.result))) {
      throw new Error('invalid verifier result at index ' + index);
    }
    for (const [evidenceIndex, evidence] of (verifier.evidence ?? []).entries()) {
      singleLine(evidence.type, 'verifier evidence type ' + index + '/' + evidenceIndex);
      singleLine(evidence.value, 'verifier evidence value ' + index + '/' + evidenceIndex);
    }
    if (verifier.result === 'Pass' && (!Array.isArray(verifier.evidence) || verifier.evidence.length === 0)) {
      throw new Error('passing verifier requires concrete evidence');
    }
  }
  const aggregated = aggregate(raw.verifiers);
  if (result !== aggregated) {
    throw new Error('Case result ' + result + ' disagrees with deterministic verifier aggregation ' + aggregated);
  }
  if (result === 'Pass' && raw.infrastructure_status !== 'ready') {
    throw new Error('passing Case requires ready infrastructure');
  }
  singleLine(raw.criterion_text, 'criterion_text');
  singleLine(raw.runtime_profile, 'runtime_profile');

  return {
    ...raw,
    issue,
    criterion,
    stage,
    target_sha: targetSha,
    case_revision: caseRevision,
    case_tree_sha: caseTreeSha,
    contract_sha256: contractSha256,
    execution_id: executionId,
    run_id: runId,
    run_attempt: runAttempt,
    deployment,
  };
}

// Bind untrusted JSON to the actual GitHub workflow_run event before ANY write.
// A digest of user-controlled fields alone is not an attestation.
export function sourceRunIdentity(event, repository) {
  const run = event?.workflow_run;
  if (!run || run.name !== 'Acceptance / Cases') {
    throw new Error('expected a completed Acceptance / Cases workflow_run event');
  }
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion)) {
    throw new Error('source Acceptance / Cases run has no terminal supported conclusion');
  }
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('source workflow repository mismatch');
  }
  const branch = singleLine(run.head_branch, 'workflow_run.head_branch');
  // GitHub's workflow_run.path uses a repository-relative workflow path.
  // Some metadata variants qualify it with repo and ref. Accept precisely
  // these forms, never a suffix/substring match of attacker-controlled text.
  const definition = singleLine(run.path, 'workflow_run.path');
  const [workflowPath, workflowRef, ...extra] = definition.split('@');
  const canonicalPath = '.github/workflows/acceptance-cases.yml';
  if (extra.length || ![canonicalPath, repository + '/' + canonicalPath].includes(workflowPath) ||
      (workflowRef && workflowRef !== 'refs/heads/' + branch)) {
    throw new Error('unexpected source workflow definition path');
  }
  const sourceSha = sha(run.head_sha, 40, 'workflow_run.head_sha');
  const eventName = singleLine(run.event, 'workflow_run.event');
  if (!['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error('unsupported source workflow event ' + eventName);
  }
  if (!['staging', 'main'].includes(branch)) {
    throw new Error('source workflow branch not eligible for ingestion: ' + branch);
  }
  return {
    repository,
    run_id: positiveInt(run.id, 'workflow_run.id'),
    run_attempt: positiveInt(run.run_attempt, 'workflow_run.run_attempt'),
    event: eventName,
    head_sha: sourceSha,
    head_branch: branch,
    workflow_id: positiveInt(run.workflow_id, 'workflow_run.workflow_id'),
  };
}

// Lane-aware proof boundary: a `when: deployed` criterion is eligible only
// with a deployment binding for its declared environment. Legacy branch-stage
// criteria keep their exact behaviour and must not carry a deployment block.
export function assertDeploymentBinding(record, planEntry) {
  const item = validateCaseRecord(record);
  if (planEntry?.when !== 'deployed') {
    if (item.deployment) {
      throw new Error('deployment proof is only valid for a when:deployed criterion');
    }
    return item;
  }
  if (!item.deployment) {
    throw new Error('deployed criterion requires a deployment proof binding');
  }
  const environment = String(planEntry.environment ?? '');
  if (!DEPLOYMENT_ENVIRONMENT.test(environment)) {
    throw new Error('deployed criterion has an invalid environment');
  }
  if (item.deployment.environment_id !== environment) {
    throw new Error('cross-lane deployment proof: ' +
      item.deployment.environment_id + ' != ' + environment);
  }
  return item;
}

export function assertSourceBoundRecord(record, source) {
  const item = assertRunIdentity(record, source);
  // A manually dispatched run may check out a different SHA, but that SHA is
  // not authenticated by workflow_run.head_sha. Reject rather than project it.
  if (item.target_sha !== source.head_sha) {
    throw new Error('Case target SHA is not the authenticated source workflow head');
  }
  const expectedStage = source.head_branch === 'main' ? 'post-merge' : 'staging';
  if (item.stage !== expectedStage) {
    throw new Error('Case stage disagrees with authenticated workflow source branch');
  }
  return assertExecutionIdentity(item);
}

/** The triggering run identity a Case record must belong to. */
function assertRunIdentity(record, source) {
  const item = validateCaseRecord(record);
  if (item.run_id !== source.run_id || item.run_attempt !== source.run_attempt) {
    throw new Error('Case record run identity disagrees with triggering workflow_run');
  }
  return item;
}

/** The deterministic execution digest, checked for every source-bound record. */
function assertExecutionIdentity(item) {
  const canonical = JSON.stringify({
    schema_version: 1,
    run_id: item.run_id,
    run_attempt: item.run_attempt,
    target_sha: item.target_sha,
    issue: item.issue,
    criterion: item.criterion,
    contract_sha256: item.contract_sha256,
    case_tree_sha: item.case_tree_sha,
  });
  const expected = crypto.createHash('sha256').update(canonical).digest('hex');
  if (item.execution_id !== expected) {
    throw new Error('Case execution_id does not match canonical source identity digest');
  }
  return item;
}

/**
 * Source binding for an explicit `when: deployed` run (#2614).
 *
 * A `workflow_dispatch` run reports the ref's tip as `workflow_run.head_sha`,
 * never the deployed source SHA the operator asked it to verify — so the
 * branch-head rule above cannot authenticate a deployed record. The deployment
 * attestation replaces it: the record must carry a binding that
 * `verifyDeployedProof` re-derives byte-for-byte from the trusted store for
 * the same environment, source SHA, GitOps revision and all three image
 * digests. Run identity and the execution digest are still required.
 */
export function assertDeployedSourceRecord(record, source, deploymentRecords) {
  const item = assertRunIdentity(record, source);
  if (item.stage !== 'post-merge') {
    throw new Error('deployed Case record must use the post-merge compatibility stage');
  }
  if (!item.deployment) {
    throw new Error('deployed Case record requires a deployment proof binding');
  }
  if (!Array.isArray(deploymentRecords)) {
    throw new Error('deployed Case attestation requires trusted deployment records');
  }
  verifyDeployedProof(item, deploymentRecords);
  return assertExecutionIdentity(item);
}

async function attestCaseRecord(record, {
  event, repository, token, request = githubRequest, deploymentRecords = null,
}) {
  const source = sourceRunIdentity(event, repository);
  const candidate = validateCaseRecord(record);
  const item = candidate.deployment
    ? assertDeployedSourceRecord(candidate, source, deploymentRecords)
    : assertSourceBoundRecord(candidate, source);
  const [owner, repo] = repository.split('/');
  const commit = await request('/repos/' + owner + '/' + repo + '/git/commits/' + item.target_sha, { token });
  const tree = await request('/repos/' + owner + '/' + repo + '/git/trees/' + commit.tree.sha + '?recursive=1', { token });
  if (tree.truncated) throw new Error('source tree listing is truncated; cannot attest Case tree');
  // A source SHA may contain precisely one authoritative Case tree during
  // the canonical migration. Dual paths are ambiguous, not a fallback signal.
  // Never execute the target's Case discovery module in the trusted ingester.
  const caseSuffix = item.issue + '/' + item.criterion;
  const casePaths = [
    'e2e/acceptance/cases/' + caseSuffix,
    'acceptance/cases/' + caseSuffix,
  ];
  const actual = (tree.tree ?? []).filter((entry) =>
    entry.type === 'tree' && casePaths.includes(entry.path));
  if (actual.length !== 1 || actual[0].sha !== item.case_tree_sha) {
    throw new Error('Case Git tree does not match uniquely authenticated source SHA: ' + casePaths.join(' or '));
  }
  return { item, source };
}

export function recordPath(record) {
  const item = validateCaseRecord(record);
  const date = String(item.finished_at ?? item.started_at ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Case record requires ISO started_at/finished_at');
  return [
    'runs',
    date,
    item.run_id + '-' + item.run_attempt,
    String(item.issue),
    item.criterion + '.json',
  ].join('/');
}

export function enrichCaseRecord(record, { workflowUrl, recordPath: durablePath, source = null }) {
  const item = validateCaseRecord(record);
  const sourceResultSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(item))
    .digest('hex');
  return {
    ...item,
    provenance: {
      ...(item.provenance ?? {}),
      ...(source ? { verified_source: source } : {}),
      workflow_url: singleLine(workflowUrl, 'workflow_url'),
      record_path: singleLine(durablePath, 'record_path'),
      source_result_sha256: sourceResultSha256,
    },
    evidence: artifactEvidence({
      mode: 'acceptance', run_id: item.run_id, run_attempt: item.run_attempt,
      source_record_sha256: sourceResultSha256, workflow_url: workflowUrl,
    }),
  };
}

/**
 * Canonical SHA index compatible with Scenario's indexes/by-sha tree.
 * This is trusted-only: a source Case cannot choose a path or forge metadata.
 */
export function caseIndexPath(record) {
  const item = validateCaseRecord(record);
  return 'indexes/by-sha/' + item.target_sha + '/acceptance/' +
    item.run_id + '-' + item.run_attempt + '-' + item.issue + '-' + item.criterion + '.json';
}
export function caseIndexRecord(record, { deploymentRecords = null } = {}) {
  const item = validateCaseRecord(record);
  const source = item.provenance?.verified_source;
  if (!source || typeof source !== 'object') {
    throw new Error('Case index requires authenticated source workflow identity');
  }
  if (item.deployment) {
    assertDeployedSourceRecord(item, source, deploymentRecords);
  } else {
    assertSourceBoundRecord(item, source);
  }
  const durable = recordPath(item);
  if (item.provenance.record_path !== durable) {
    throw new Error('Case index record path differs from immutable persisted record');
  }
  return makeRunIndex({
    schema_version: 1,
    mode: 'acceptance',
    source,
    record: durable,
    execution_id: item.execution_id,
    target_sha: item.target_sha,
    issue: item.issue,
    criterion: item.criterion,
    stage: item.stage,
    case_tree_sha: item.case_tree_sha,
    contract_sha256: item.contract_sha256,
    // A deployed record's source is bound by the attested deployment, not by
    // the dispatch ref tip (#2614).
    ...(item.deployment ? {
      deployment: {
        environment_id: item.deployment.environment_id,
        source_sha: item.target_sha,
        gitops_revision: item.deployment.gitops_revision,
        attestation_execution_id: item.deployment.attestation_execution_id,
      },
    } : {}),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubRequest(apiPath, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN/GH_TOKEN is required');
  const attempts = 4;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch('https://api.github.com' + apiPath, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nession-acceptance-case-ingest',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) return response.status === 204 ? null : response.json();

      const detail = await response.text();
      const retriable = response.status === 429 || response.status >= 500;
      const error = new Error(
        'GitHub API ' + method + ' ' + apiPath + ' failed: ' + response.status + ' ' + detail,
      );
      if (!retriable || attempt === attempts) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }

    await sleep(250 * (2 ** (attempt - 1)));
  }

  throw lastError ?? new Error('GitHub API request failed without an error');
}

async function issueIsAssociatedWithSha(owner, name, issueNumber, targetSha, token, request = githubRequest) {
  const pulls = await request(
    '/repos/' + owner + '/' + name + '/commits/' + targetSha + '/pulls?per_page=100',
    { token },
  );
  for (const pr of pulls ?? []) {
    const numbers = parsePreMergeIssueNumbers(pr.body, owner, name, pr.title);
    if (numbers.includes(issueNumber)) return true;
  }
  return false;
}

async function currentStageSha(owner, name, stage, token, request = githubRequest) {
  const branch = stage === 'staging' ? 'staging' : stage === 'post-merge' ? 'main' : null;
  if (!branch) return null;
  const ref = await request('/repos/' + owner + '/' + name + '/git/ref/heads/' + branch, { token });
  return String(ref.object?.sha ?? '');
}

/**
 * An authenticated Case proves its merged commit, not whatever unrelated
 * commit becomes the branch tip while an async evidence ingest is running.
 *
 * A historical Case can be projected only when its SHA is verified as a
 * strict ancestor of the current branch tip. A successful workflow or a
 * syntactically valid merge SHA alone does NOT establish ancestry.
 */
export function classifyCaseBranchAncestry(target, current, comparison) {
  const targetSha = sha(target, 40, 'target');
  const currentSha = sha(current, 40, 'current');
  if (targetSha === currentSha) return 'exact-head';
  if (!comparison || comparison.status !== 'ahead' ||
      comparison.base_commit?.sha !== targetSha ||
      comparison.merge_base_commit?.sha !== targetSha ||
      !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 1 ||
      comparison.behind_by !== 0) return 'unproven';
  return 'verified-ancestor';
}

/** Historical merge-SHA proof must not overwrite an existing SC conclusion. */
export function historicalCaseMayProject(issueBody, criterion) {
  const { rows, errors } = parseAcceptanceReport(extractSection(issueBody, 'Acceptance Report'));
  if (errors.length) return false;
  const previous = rows.get(criterion);
  // A previous authenticated result (including a Fail or a Pending result
  // from another run) is never superseded by an older target SHA.
  return !!previous && previous.result.toLowerCase() === 'pending' &&
    !/^run\s+[1-9]\d*\s*;/i.test(previous.evidence);
}

// A deployed Case may project only against the exact attestation it was
// executed under. The binding is re-derived from the trusted store record;
// nothing in the Case result is trusted to name its own environment.
export function verifyDeployedProof(item, deploymentRecords) {
  if (!Array.isArray(deploymentRecords)) {
    throw new Error('deployed Case projection requires trusted deployment records');
  }
  const matches = [];
  for (const entry of deploymentRecords) {
    if (!entry || typeof entry !== 'object') throw new Error('deployment record entry must be an object');
    const stored = validateStoredRecord(entry.record);
    if (stored.execution_id === item.deployment.attestation_execution_id) {
      matches.push({ ...stored, path: String(entry.path ?? '') });
    }
  }
  if (matches.length !== 1) {
    throw new Error('deployed Case attestation is missing or ambiguous');
  }
  const { item: receipt } = matches[0];
  if (receipt.environment_id !== item.deployment.environment_id) {
    throw new Error('deployed Case environment disagrees with the attestation');
  }
  if (receipt.source_sha !== item.target_sha) {
    throw new Error('deployed Case target SHA disagrees with the attestation');
  }
  if (receipt.gitops_revision !== item.deployment.gitops_revision) {
    throw new Error('deployed Case GitOps revision disagrees with the attestation');
  }
  for (const role of ['agent', 'server', 'ui']) {
    const digest = receipt.images.find((image) => image.role === role)?.digest;
    if (digest !== item.deployment.image_digests[role]) {
      throw new Error(role + ' deployed Case digest disagrees with the attestation');
    }
  }
  return {
    environment_id: receipt.environment_id,
    attested: true,
    attestation_execution_id: matches[0].execution_id,
    gitops_revision: receipt.gitops_revision,
    image_digests: Object.fromEntries(receipt.images.map((image) => [image.role, image.digest])),
  };
}

export async function applyCaseRecord(record, { repository, token, request = githubRequest, deploymentRecords = null }) {
  const item = validateCaseRecord(record);
  const [owner, name] = String(repository ?? '').split('/');
  if (!owner || !name) throw new Error('repository must be owner/name');

  if (item.stage === 'pre-merge') {
    return { projected: false, reason: 'pre-merge Case records are evidence-only; PR Acceptance owns pre-merge projection' };
  }

  if (item.deployment) {
    // Deployed proof: the exact attestation replaces branch ancestry and
    // Issue↔SHA association as the authorization for projection.
    const binding = verifyDeployedProof(item, deploymentRecords);
    const issue = await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, { token });
    if (!isAcceptanceIssue(issue)) throw new Error('#' + item.issue + ' must be labeled bug or requirement');
    if (String(issue.state).toLowerCase() !== 'open') {
      return { projected: false, reason: 'Requirement #' + item.issue + ' is not open' };
    }
    const context = buildAcceptanceContext(issue, item.stage, {
      method: 'case',
      targetRef: item.target_sha,
      deployment: item.deployment.environment_id,
      deploymentBinding: binding,
      runId: item.run_id,
    });
    const normalized = normalizeAcceptanceCaseResult(context, item, 'case-runner');
    const updatedBody = applyAcceptanceResultToBody(issue.body, normalized, { deploymentBinding: binding });
    if (updatedBody === issue.body) return { projected: true, changed: false };
    await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, {
      token,
      method: 'PATCH',
      body: { body: updatedBody },
    });
    return { projected: true, changed: true };
  }

  const currentSha = await currentStageSha(owner, name, item.stage, token, request);
  let ancestry = classifyCaseBranchAncestry(item.target_sha, currentSha, null);
  if (ancestry === 'unproven') {
    // GitHub's compare API authenticates the merge-base against the actual
    // current branch tip; off-branch/diverged histories must fail closed.
    const comparison = await request(
      '/repos/' + owner + '/' + name + '/compare/' + item.target_sha + '...' + currentSha,
      { token },
    );
    ancestry = classifyCaseBranchAncestry(item.target_sha, currentSha, comparison);
    if (ancestry !== 'verified-ancestor') {
      return { projected: false, reason: 'historical Case SHA is not an authenticated ancestor of current ' + item.stage + ' tip' };
    }
  }
  if (!await issueIsAssociatedWithSha(owner, name, item.issue, item.target_sha, token, request)) {
    return { projected: false, reason: 'target SHA is not associated with Requirement #' + item.issue };
  }

  const issue = await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, { token });
  if (!isAcceptanceIssue(issue)) throw new Error('#' + item.issue + ' must be labeled bug or requirement');
  if (String(issue.state).toLowerCase() !== 'open') {
    return { projected: false, reason: 'Requirement #' + item.issue + ' is not open' };
  }
  if (ancestry === 'verified-ancestor' && !historicalCaseMayProject(issue.body, item.criterion)) {
    return { projected: false, reason: 'historical merged-SHA Case cannot supersede an existing SC verdict or run' };
  }

  const context = buildAcceptanceContext(issue, item.stage, {
    method: 'case',
    targetRef: item.target_sha,
    deployment: item.stage,
    runId: item.run_id,
  });
  const normalized = normalizeAcceptanceCaseResult(context, item, 'case-runner');
  const updatedBody = applyAcceptanceResultToBody(issue.body, normalized);
  if (updatedBody === issue.body) return { projected: true, changed: false };

  await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, {
    token,
    method: 'PATCH',
    body: { body: updatedBody },
  });
  return { projected: true, changed: true };
}

function fixtureRecord(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'acceptance_case_result',
    execution_id: 'a'.repeat(64),
    run_id: 100,
    run_attempt: 1,
    issue: 1474,
    criterion: 'SC-14',
    criterion_text: 'browser and protocol case completes',
    stage: 'staging',
    target_sha: 'b'.repeat(40),
    contract_sha256: 'c'.repeat(64),
    case_revision: 'b'.repeat(40),
    case_tree_sha: 'd'.repeat(40),
    runtime_profile: 'full-stack-local',
    result_policy: 'all-pass',
    result: 'Pass',
    infrastructure_status: 'ready',
    infrastructure_error: null,
    started_at: '2026-10-08T00:00:00.000Z',
    finished_at: '2026-10-08T00:00:01.000Z',
    duration_ms: 1000,
    verifiers: [{
      type: 'browser',
      entry: 'verify.spec.ts',
      result: 'Pass',
      summary: 'browser passed',
      evidence: [{ type: 'browser', value: 'shell visible' }],
    }],
    ...overrides,
  };
}

async function selfTest() {
  // Async ingestion must recognize validated ancestor evidence but refuse
  // unmerged/foreign refs, incomplete comparisons, or replacement of a later
  // Issue decision. No network or mutable GitHub fixtures required.
  const ancestor = 'a'.repeat(40), latest = 'b'.repeat(40);
  const comparison = {
    status: 'ahead', base_commit: { sha: ancestor },
    merge_base_commit: { sha: ancestor }, ahead_by: 2, behind_by: 0,
  };
  assert.equal(classifyCaseBranchAncestry(ancestor, ancestor, null), 'exact-head');
  assert.equal(classifyCaseBranchAncestry(ancestor, latest, comparison), 'verified-ancestor');
  for (const mutated of [
    { ...comparison, status: 'diverged' },
    { ...comparison, status: 'behind' },
    { ...comparison, merge_base_commit: { sha: latest } },
    { ...comparison, base_commit: { sha: latest } },
    { ...comparison, behind_by: 1 },
    { ...comparison, ahead_by: 0 },
    null,
  ]) {
    assert.equal(classifyCaseBranchAncestry(ancestor, latest, mutated), 'unproven');
  }
  assert.throws(() => classifyCaseBranchAncestry('bad-sha', latest, comparison), /40-character/);
  const report = (result, evidence) =>
    '## Acceptance Report\n| Criterion | Result | Evidence |\n|---|---|---|\n| SC-07 | ' +
    result + ' | ' + evidence + ' |\n';
  assert.equal(historicalCaseMayProject(report('Pending', 'Post-merge proof not yet run'), 'SC-07'), true);
  assert.equal(historicalCaseMayProject(report('Pass', 'proof'), 'SC-07'), false);
  assert.equal(historicalCaseMayProject(report('Fail', 'failure'), 'SC-07'), false);
  assert.equal(historicalCaseMayProject(report('Pending', 'run 900; ref ' + latest), 'SC-07'), false);
  assert.equal(historicalCaseMayProject(report('Pending', '-'), 'SC-08'), false);

  // End-to-end mock of the actual authenticated projector: a newer unrelated
  // main merge must not strand a passed Case for its verified merged ancestor.
  const historicalIssueBody = [
    '## Success Criteria',
    '- [ ] SC-07 Verify the exact merged SHA by a real browser Case.',
    '## Acceptance Plan',
    '```yaml',
    'acceptance:',
    '  SC-07:',
    '    when: merged',
    '    branch: main',
    '    method: case',
    '```',
    '## Acceptance Report',
    '| Criterion | Result | Evidence |',
    '|---|---|---|',
    '| SC-07 | Pending | - |',
  ].join('\n');
  const historicalIssue = {
    number:1792,title:'Pages browser proof',state:'open',
    labels:[{name:'requirement'}],body:historicalIssueBody,
  };
  const historicalContext = buildAcceptanceContext(historicalIssue,'post-merge',{
    targetRef:ancestor,runId:100,
  });
  const historicalRecord = fixtureRecord({
    issue:1792,criterion:'SC-07',
    criterion_text:'Verify the exact merged SHA by a real browser Case.',
    stage:'post-merge',target_sha:ancestor,case_revision:ancestor,
    contract_sha256:historicalContext.contract_sha256,
  });
  historicalRecord.execution_id=crypto.createHash('sha256').update(JSON.stringify({
    schema_version:1,run_id:historicalRecord.run_id,run_attempt:historicalRecord.run_attempt,
    target_sha:historicalRecord.target_sha,issue:historicalRecord.issue,
    criterion:historicalRecord.criterion,contract_sha256:historicalRecord.contract_sha256,
    case_tree_sha:historicalRecord.case_tree_sha,
  })).digest('hex');
  let currentHistoricalIssue={...historicalIssue};
  let historicalWrites=0;
  const historicalApi=async(apiPath, options={})=>{
    if(apiPath.endsWith('/git/ref/heads/main'))return {object:{sha:latest}};
    if(apiPath.includes('/compare/'))return comparison;
    if(apiPath.includes('/commits/'+ancestor+'/pulls'))return [{title:'Pages browser proof',body:'Refs #1792'}];
    if(apiPath.endsWith('/issues/1792')){
      if(options.method==='PATCH'){
        currentHistoricalIssue={...currentHistoricalIssue,body:options.body.body};
        historicalWrites++;
      }
      return currentHistoricalIssue;
    }
    throw Error('Unmocked historical ingest source: '+apiPath);
  };
  const once=await applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',request:historicalApi,
  });
  assert.deepEqual(once,{projected:true,changed:true});
  assert.match(currentHistoricalIssue.body, /- \[x\] SC-07/);
  assert.match(currentHistoricalIssue.body, /\| SC-07 \| Pass \| run 100;/);
  assert.match(currentHistoricalIssue.body, new RegExp(ancestor));
  const replay=await applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',request:historicalApi,
  });
  assert.equal(replay.projected,false);
  assert.equal(historicalWrites,1,'historical Case may never overwrite its existing verdict');

  // Bug-only acceptance Case must follow the identical authenticated source
  // and deterministic projection path; labels do not replace SHA/SC checks.
  currentHistoricalIssue={...historicalIssue,labels:[{name:'bug'}]};
  const bugResult=await applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',request:historicalApi,
  });
  assert.deepEqual(bugResult,{projected:true,changed:true});
  assert.match(currentHistoricalIssue.body, /- \[x\] SC-07/);
  assert.equal(historicalWrites,2);
  currentHistoricalIssue={...historicalIssue,labels:[{name:'ci'}]};
  await assert.rejects(()=>applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',request:historicalApi,
  }),/must be labeled bug or requirement/);
  currentHistoricalIssue={...historicalIssue,labels:[{name:'bug'},{name:'requirement'}]};
  await assert.rejects(()=>applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',request:historicalApi,
  }),/must be labeled bug or requirement/);

  currentHistoricalIssue={...historicalIssue};
  const rejected=await applyCaseRecord(historicalRecord,{
    repository:'BestNathan/nession',token:'offline-proof',
    request:async(apiPath,options)=>apiPath.includes('/compare/')
      ? {...comparison,status:'diverged'}:historicalApi(apiPath,options),
  });
  assert.equal(rejected.projected,false);
  assert.equal(historicalWrites,2,'diverged SHA cannot mutate Issue SC');
  const valid = fixtureRecord();
  const canonical = JSON.stringify({
    schema_version: 1, run_id: valid.run_id, run_attempt: valid.run_attempt,
    target_sha: valid.target_sha, issue: valid.issue, criterion: valid.criterion,
    contract_sha256: valid.contract_sha256, case_tree_sha: valid.case_tree_sha,
  });
  valid.execution_id = crypto.createHash('sha256').update(canonical).digest('hex');
  const source = {
    repository: 'BestNathan/nession', run_id: 100, run_attempt: 1,
    event: 'push', head_sha: valid.target_sha, head_branch: 'staging', workflow_id: 9,
  };
  assert.equal(assertSourceBoundRecord(valid, source).issue, 1474);
  assert.throws(() => assertSourceBoundRecord({ ...valid, run_id: 999 }, source), /run identity/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, target_sha: 'e'.repeat(40), case_revision: 'e'.repeat(40) }, source), /target SHA/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, stage: 'post-merge' }, source), /stage disagrees/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, execution_id: 'a'.repeat(64) }, source), /execution_id/);
  const fixtureEvent = { workflow_run: {
    name: 'Acceptance / Cases', status: 'completed', conclusion: 'success',
    repository: { full_name: 'BestNathan/nession' },
    head_repository: { full_name: 'BestNathan/nession' },
    head_branch: 'staging', head_sha: valid.target_sha, event: 'push',
    path: '.github/workflows/acceptance-cases.yml',
    id: 100, run_attempt: 1, workflow_id: 9,
  }};
  // Exercise the actual attest path without credentials: a fetched source commit
  // must contain the exact Case tree claimed by the immutable record.
  const sourceTree = 'f'.repeat(40);
  const expectedPath = 'acceptance/cases/1474/SC-14';
  const attestationRequest = async (apiPath) => {
    if (apiPath.endsWith('/git/commits/' + valid.target_sha)) return { tree: { sha: sourceTree } };
    if (apiPath.includes('/git/trees/' + sourceTree)) return {
      truncated: false, tree: [{ path: expectedPath, type: 'tree', sha: valid.case_tree_sha }],
    };
    throw new Error('unexpected API path in test: ' + apiPath);
  };
  const attestation = { event: fixtureEvent, repository: 'BestNathan/nession',
    token: 'self-test', request: attestationRequest };
  assert.equal((await attestCaseRecord(valid, attestation)).item.case_tree_sha, valid.case_tree_sha);
  const replaceSourceTrees = (transform) => async (apiPath) => {
    const response = await attestationRequest(apiPath);
    if (response.tree && Array.isArray(response.tree)) return { ...response, tree: transform(response.tree) };
    return response;
  };
  // Canonical path is accepted only when the same source commit Git tree
  // authenticates its blob. No target-supplied manifest or alias is trusted.
  await attestCaseRecord(valid, { ...attestation,
    request: replaceSourceTrees((entries) => entries.map((entry) => ({
      ...entry, path: 'e2e/acceptance/cases/1474/SC-14',
    }))) });
  await assert.rejects(() => attestCaseRecord(valid, { ...attestation,
    request: replaceSourceTrees((entries) => [...entries,
      { ...entries[0], path: 'e2e/acceptance/cases/1474/SC-14' }]) }),
  /uniquely authenticated/);
  await assert.rejects(() => attestCaseRecord(valid, { ...attestation,
    request: replaceSourceTrees(() => []) }),
  /uniquely authenticated/);
  await assert.rejects(() => attestCaseRecord({ ...valid, execution_id: 'a'.repeat(64) }, attestation), /execution_id/);
  await assert.rejects(() => attestCaseRecord(valid, {
    ...attestation,
    request: async (apiPath) => {
      const response = await attestationRequest(apiPath);
      return response.tree && Array.isArray(response.tree)
        ? { ...response, tree: [{ ...response.tree[0], sha: 'e'.repeat(40) }] }
        : response;
    },
  }), /Case Git tree does not match/);
  await assert.rejects(() => attestCaseRecord(valid, {
    ...attestation,
    request: async (apiPath) => {
      const response = await attestationRequest(apiPath);
      return response.tree && Array.isArray(response.tree)
        ? { ...response, truncated: true }
        : response;
    },
  }), /truncated/);
  assert.equal(sourceRunIdentity(fixtureEvent, 'BestNathan/nession').head_sha, valid.target_sha);
  for (const path of [
    '.github/workflows/acceptance-cases.yml',
    'BestNathan/nession/.github/workflows/acceptance-cases.yml',
    '.github/workflows/acceptance-cases.yml@refs/heads/staging',
    'BestNathan/nession/.github/workflows/acceptance-cases.yml@refs/heads/staging',
  ]) {
    assert.equal(sourceRunIdentity({ workflow_run: {
      ...fixtureEvent.workflow_run, path,
    } }, 'BestNathan/nession').run_id, valid.run_id);
  }
  for (const path of [
    'other/.github/workflows/acceptance-cases.yml',
    '.github/workflows/acceptance-cases.yml@refs/heads/main',
    '.github/workflows/other.yml',
    '.github/workflows/acceptance-cases.yml/../acceptance-cases.yml',
    '.github/workflows/acceptance-cases.yml@refs/heads/staging@other',
    undefined,
  ]) {
    assert.throws(() => sourceRunIdentity({ workflow_run: {
      ...fixtureEvent.workflow_run, path,
    } }, 'BestNathan/nession'), /workflow_run.path|unexpected source workflow definition path/);
  }
  assert.throws(() => sourceRunIdentity({ workflow_run: { ...fixtureEvent.workflow_run, repository: {full_name: 'other/repo'} } }, 'BestNathan/nession'), /repository mismatch/);
  assert.equal(validateCaseRecord(valid).result, 'Pass');
  assert.equal(recordPath(valid), 'runs/2026-10-08/100-1/1474/SC-14.json');
  assert.throws(() => validateCaseRecord({ ...valid, case_revision: 'e'.repeat(40) }), /must equal target_sha/);
  assert.throws(() => validateCaseRecord({ ...valid, result: 'Pending' }), /disagrees/);
  assert.throws(
    () => validateCaseRecord({ ...valid, verifiers: [{ ...valid.verifiers[0], evidence: [] }] }),
    /requires concrete evidence/,
  );
  const enriched = enrichCaseRecord(valid, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(valid),
  });
  assert.match(enriched.provenance.source_result_sha256, /^[0-9a-f]{64}$/);
  assert.equal(enriched.evidence.artifact_name, 'acceptance-case-results-100-1');
  assert.equal(enriched.evidence.retention_days, 90);
  assert.equal(enriched.evidence.digest_scope, 'validated-source-record-json');
  assert.match(enriched.evidence.durability, /time-limited/);
  assert.throws(() => validateCaseRecord({ ...enriched, evidence: {
    ...enriched.evidence, retention_days: 3650 } }), /artifact evidence/);
  assert.throws(() => validateCaseRecord({ ...enriched, evidence: {
    ...enriched.evidence, sha256: '0'.repeat(64) } }), /artifact evidence/);
  const sourceEnriched = enrichCaseRecord(valid, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(valid), source,
  });
  const sourceIndex = caseIndexRecord(sourceEnriched);
  assert.equal(sourceIndex.schema_version, 1);
  assert.equal(sourceIndex.mode, 'acceptance');
  assert.equal(sourceIndex.source.head_sha, valid.target_sha);
  assert.equal(sourceIndex.execution_id, valid.execution_id);
  assert.equal(sourceIndex.record, recordPath(valid));
  assert.equal(caseIndexPath(sourceEnriched),
    'indexes/by-sha/' + valid.target_sha + '/acceptance/100-1-1474-SC-14.json');
  assert.throws(() => caseIndexRecord(valid), /authenticated source/);
  assert.throws(() => caseIndexRecord({...sourceEnriched,
    provenance: {...sourceEnriched.provenance, verified_source: {...source, run_id: 999}}}),
    /run identity/);
  assert.throws(() => caseIndexRecord({...sourceEnriched,
    provenance: {...sourceEnriched.provenance, record_path: 'runs/forged.json'}}),
    /record path differs/);
  // Lane-aware proof binding: deployed criteria require the exact environment
  // and immutable deployment identity; legacy criteria must not carry one.
  const deployment = {
    environment_id: 'staging-01',
    deployed_source_sha: 'b'.repeat(40),
    attestation_execution_id: 'e'.repeat(64),
    gitops_revision: 'f'.repeat(40),
    image_digests: {
      agent: 'sha256:' + '1'.repeat(64),
      server: 'sha256:' + '2'.repeat(64),
      ui: 'sha256:' + '3'.repeat(64),
    },
  };
  const deployedEntry = { when: 'deployed', environment: 'staging-01', method: 'case' };
  const bound = fixtureRecord({ deployment });
  assert.equal(assertDeploymentBinding(bound, deployedEntry).deployment.environment_id, 'staging-01');
  assert.throws(() => assertDeploymentBinding(fixtureRecord(), deployedEntry),
    /requires a deployment proof binding/);
  assert.throws(() => assertDeploymentBinding(bound, { when: 'pr', method: 'case' }),
    /only valid for a when:deployed/);
  assert.throws(() => assertDeploymentBinding(
    fixtureRecord({ deployment: { ...deployment, environment_id: 'staging' } }), deployedEntry),
  /cross-lane deployment proof/);
  assert.throws(() => assertDeploymentBinding(
    fixtureRecord({ deployment: { ...deployment, deployed_source_sha: 'c'.repeat(40) } }), deployedEntry),
  /must equal the Case target_sha/);
  assert.throws(() => validateCaseRecord(fixtureRecord({
    deployment: { ...deployment, image_digests: { ...deployment.image_digests, agent: 'latest' } },
  })), /agent deployment image digest is not immutable/);
  assert.throws(() => validateCaseRecord(fixtureRecord({
    deployment: { ...deployment, image_digests: { agent: deployment.image_digests.agent } },
  })), /server deployment image digest is not immutable/);
  assert.throws(() => validateCaseRecord(fixtureRecord({
    deployment: { ...deployment, attestation_execution_id: 'short' },
  })), /attestation_execution_id/);
  assert.throws(() => validateCaseRecord(fixtureRecord({
    deployment: { ...deployment, environment_id: 'Staging_01' },
  })), /invalid deployment environment_id/);
  // Deployed projection: only the exact stored attestation authorizes it.
  const deploySource = 'b'.repeat(40);
  const deployReceipt = {
    schema_version: 1, kind: 'nession_deployment_attestation', status: 'Attested',
    environment_id: 'staging-01', namespace: 'nession-staging-01',
    cluster_context: 'ci', gitops_revision: 'f'.repeat(40),
    observed_at: '2026-10-25T01:00:00Z', source_sha: deploySource,
    images: [
      { role: 'agent', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'agent-bbbbbbb', digest: 'sha256:' + '1'.repeat(64) },
      { role: 'server', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'server-bbbbbbb', digest: 'sha256:' + '2'.repeat(64) },
      { role: 'ui', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'ui-bbbbbbb', digest: 'sha256:' + '3'.repeat(64) },
    ],
    workloads: ['agent', 'server', 'ui'].map((role, index) => ({
      role, name: 'nession-' + role, namespace: 'nession-staging-01',
      uid: 'uid-' + role, generation: 3, observed_generation: 3, ready: true,
      image: 'ghcr.io/bestnathan/nession:' + role + '-bbbbbbb',
      image_id: 'ghcr.io/bestnathan/nession@sha256:' + String(index + 1).repeat(64),
      declared_repository: 'ghcr.io/bestnathan/nession',
      repository: 'ghcr.io/bestnathan/nession',
      digest: 'sha256:' + String(index + 1).repeat(64),
    })),
  };
  const deployAttestation = enrichReceipt(deployReceipt, {
    source: { repository: 'BestNathan/nession', run_id: 700, run_attempt: 1,
      workflow_id: 7, event: 'workflow_dispatch', head_sha: 'c'.repeat(40), head_branch: 'main' },
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/700',
    recordPath: 'runs/2026-10-25/700-1/deployment/staging-01.json',
  });
  const deployBinding = {
    environment_id: 'staging-01',
    deployed_source_sha: deploySource,
    attestation_execution_id: deployAttestation.execution_id,
    gitops_revision: deployReceipt.gitops_revision,
    image_digests: { agent: deployReceipt.images[0].digest, server: deployReceipt.images[1].digest, ui: deployReceipt.images[2].digest },
  };
  const deployedIssueBody = [
    '## Success Criteria', '- [ ] SC-07 Deployed proof.', '',
    '## Acceptance Plan', '\x60\x60\x60yaml', 'acceptance:', '  SC-07:',
    '    when: deployed', '    environment: staging-01', '    method: case',
    '\x60\x60\x60', '',
    '## Acceptance Report', '| Criterion | Result | Evidence |', '|---|---|---|',
    '| SC-07 | Pending | - |',
  ].join('\n').replace(/\\x60/g, '\x60');
  const deployedIssue = { number: 1799, title: 'deployed', state: 'open',
    labels: [{ name: 'requirement' }], body: deployedIssueBody };
  const deployContext = buildAcceptanceContext(deployedIssue, 'post-merge', {
    method: 'case', targetRef: deploySource, deployment: 'staging-01',
    deploymentBinding: { ...deployBinding, attested: true }, runId: 100,
  });
  const deployedRecord = fixtureRecord({
    issue: 1799, criterion: 'SC-07', criterion_text: deployContext.criteria[0].text,
    stage: 'post-merge', target_sha: deploySource, case_revision: deploySource,
    contract_sha256: deployContext.contract_sha256,
    deployment: deployBinding,
  });
  let deployedBody = deployedIssue.body;
  let deployedPatched = 0;
  const deployedApi = async (apiPath, options = {}) => {
    if (apiPath.endsWith('/issues/1799')) {
      if (options.method === 'PATCH') { deployedBody = options.body.body; deployedPatched += 1; }
      return { ...deployedIssue, body: deployedBody };
    }
    throw Error('unmocked deployed ingest source: ' + apiPath);
  };
  const deployedProjection = await applyCaseRecord(deployedRecord, {
    repository: 'BestNathan/nession', token: 'offline-proof', request: deployedApi,
    deploymentRecords: [{ path: 'runs/2026-10-25/700-1/deployment/staging-01.json', record: deployAttestation }],
  });
  assert.deepEqual(deployedProjection, { projected: true, changed: true });
  assert.match(deployedBody, /- \[x\] SC-07/);
  assert.equal(deployedPatched, 1);
  assert.throws(() => verifyDeployedProof(deployedRecord, null),
    /requires trusted deployment records/);
  assert.throws(() => verifyDeployedProof({
    ...deployedRecord, deployment: { ...deployBinding, environment_id: 'staging' },
  }, [{ path: 'x', record: deployAttestation }]), /environment disagrees/);
  assert.throws(() => verifyDeployedProof({
    ...deployedRecord, deployment: { ...deployBinding,
      image_digests: { ...deployBinding.image_digests, agent: 'sha256:' + '9'.repeat(64) } },
  }, [{ path: 'x', record: deployAttestation }]), /agent deployed Case digest disagrees/);

  // #2614: a `workflow_dispatch` run reports the ref tip as
  // workflow_run.head_sha, not the deployed SHA. The attested deployment
  // record authorizes the source; the branch-head rule must not, and the run
  // identity plus execution digest are still enforced.
  const deployedSource = {
    repository: 'BestNathan/nession', run_id: deployedRecord.run_id,
    run_attempt: deployedRecord.run_attempt, event: 'workflow_dispatch',
    head_sha: 'c'.repeat(40), head_branch: 'main', workflow_id: 9,
  };
  const deployedRecords = [{ path: 'runs/2026-10-25/700-1/deployment/staging-01.json', record: deployAttestation }];
  // The Case runner mints execution_id from the record's own fields; the bare
  // fixture default is not that digest, so derive it before the positive case.
  const deployedExecution = crypto.createHash('sha256').update(JSON.stringify({
    schema_version: 1, run_id: deployedRecord.run_id, run_attempt: deployedRecord.run_attempt,
    target_sha: deployedRecord.target_sha, issue: deployedRecord.issue,
    criterion: deployedRecord.criterion, contract_sha256: deployedRecord.contract_sha256,
    case_tree_sha: deployedRecord.case_tree_sha,
  })).digest('hex');
  const boundDeployed = { ...deployedRecord, execution_id: deployedExecution };
  assert.equal(assertDeployedSourceRecord(boundDeployed, deployedSource, deployedRecords).issue, 1799);
  assert.throws(() => assertDeployedSourceRecord({ ...boundDeployed, run_id: 7 }, deployedSource, deployedRecords),
    /run identity/);
  assert.throws(() => assertDeployedSourceRecord(boundDeployed, deployedSource, null),
    /requires trusted deployment records/);
  assert.throws(() => assertDeployedSourceRecord({ ...boundDeployed, stage: 'staging' }, deployedSource, deployedRecords),
    /post-merge compatibility stage/);
  assert.throws(() => assertDeployedSourceRecord({
    ...boundDeployed,
    deployment: { ...boundDeployed.deployment, environment_id: 'staging' },
  }, deployedSource, deployedRecords), /environment disagrees/);
  assert.throws(() => assertDeployedSourceRecord({ ...boundDeployed, execution_id: 'a'.repeat(64) },
    deployedSource, deployedRecords), /execution_id/);
  assert.throws(() => assertSourceBoundRecord(boundDeployed, deployedSource),
    /not the authenticated source workflow head/);

  // The SHA index carries the deployment binding instead of the branch head.
  const deployedEnriched = enrichCaseRecord(boundDeployed, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(boundDeployed), source: deployedSource,
  });
  const deployedIndex = caseIndexRecord(deployedEnriched, { deploymentRecords: deployedRecords });
  assert.equal(deployedIndex.target_sha, deployedRecord.target_sha);
  assert.equal(deployedIndex.deployment.environment_id, 'staging-01');
  assert.equal(deployedIndex.deployment.source_sha, deployedRecord.target_sha);
  assert.notEqual(deployedIndex.source.head_sha, deployedIndex.target_sha);
  assert.throws(() => caseIndexRecord(deployedEnriched), /requires trusted deployment records/);
  assert.throws(() => caseIndexRecord(deployedEnriched, { deploymentRecords: [] }),
    /missing or ambiguous/);
  console.log('acceptance Case ingest self-test: provenance, deployment binding and record validation passed');
}

/**
 * The trusted deployment store records the ingest job collected (or null).
 * Set by the workflow after it clones the append-only results branch.
 */
function deploymentRecordsFromEnv() {
  const path = process.env.DEPLOYMENT_RECORDS_JSON ?? '';
  return path ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'validate') {
    const record = validateCaseRecord(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
    process.stdout.write(JSON.stringify(record) + '\n');
    return;
  }
  if (command === 'record-path') {
    process.stdout.write(recordPath(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))) + '\n');
    return;
  }
  if (command === 'index') {
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const output = process.argv[4];
    if (!output) throw new Error('index RECORD OUTPUT required');
    const entry = caseIndexRecord(record, { deploymentRecords: deploymentRecordsFromEnv() });
    fs.writeFileSync(output, JSON.stringify(entry, null, 2) + '\n');
    process.stdout.write(caseIndexPath(record) + '\n');
    return;
  }
  if (command === 'attest') {
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const event = JSON.parse(fs.readFileSync(process.argv[4] || process.env.GITHUB_EVENT_PATH, 'utf8'));
    await attestCaseRecord(record, {
      event, repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      deploymentRecords: deploymentRecordsFromEnv(),
    });
    process.stdout.write(recordPath(record) + '\n');
    return;
  }
  if (command === 'enrich') {
    const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const output = process.argv[4];
    const event = JSON.parse(fs.readFileSync(process.argv[7] || process.env.GITHUB_EVENT_PATH, 'utf8'));
    const { source } = await attestCaseRecord(input, {
      event, repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      deploymentRecords: deploymentRecordsFromEnv(),
    });
    const enriched = enrichCaseRecord(input, {
      workflowUrl: process.argv[5],
      recordPath: process.argv[6],
      source,
    });
    fs.writeFileSync(output, JSON.stringify(enriched, null, 2) + '\n');
    return;
  }
  if (command === 'apply') {
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const result = await applyCaseRecord(record, {
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      deploymentRecords: deploymentRecordsFromEnv(),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  throw new Error('usage: node scripts/acceptance-case-ingest.mjs <self-test|validate FILE|attest FILE EVENT|record-path FILE|index RECORD OUTPUT|enrich IN OUT WORKFLOW_URL RECORD_PATH EVENT|apply FILE>');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
