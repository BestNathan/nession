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
const STAGES = new Set(['pr', 'pre-merge', 'staging', 'post-merge']); // legacy record reads only
const DEPLOYMENT_ROLES = Object.freeze(['agent', 'server', 'ui']);
const DEPLOYMENT_ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
// GitHub evaluates this step name from the original workflow_dispatch inputs;
// target-controlled Case code cannot mutate the GitHub Jobs/Steps API metadata.
const MANUAL_STAGING_STEP = /^Authenticate manual Staging Case ([1-9][0-9]*) (SC-[0-9]{2,}) ([0-9a-f]{40})$/;
const MANUAL_POST_MERGE_STEP = /^Authenticate manual Post-Merge Case ([1-9][0-9]*) (SC-[0-9]{2,}) ([0-9a-f]{40})$/;

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
  // GitHub's completed workflow_run event reports the dynamic run-name in
  // workflow_run.name, not the source workflow's static declaration name.
  // Issue-comment requests intentionally have a comment-bound run title; do
  // not lose their ingestion, but accept only the exact authenticated family.
  const commentRun = /^Comment Case #([1-9][0-9]*) (SC-[0-9]{2,}) comment:([1-9][0-9]*)$/
    .exec(run?.name ?? '');
  const prSmoke = run?.name === 'Acceptance / Case Smoke';
  if (!run || (run.name !== 'Acceptance / Cases' && !commentRun && !prSmoke)) {
    throw new Error('expected a completed Acceptance / Cases or Case Smoke workflow_run event');
  }
  if (prSmoke && run.event !== 'pull_request') {
    throw new Error('PR Case Smoke source must be a pull_request event');
  }
  if (commentRun && (run.event !== 'workflow_dispatch' || run.head_branch !== 'main')) {
    throw new Error('comment-named Case source requires trusted main workflow_dispatch');
  }
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion) ||
      (prSmoke && run.conclusion !== 'success')) {
    throw new Error('Case source has no authenticated successful PR Smoke or supported terminal Cases conclusion');
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
  const canonicalPath = prSmoke ? '.github/workflows/acceptance-case-smoke.yml' :
    '.github/workflows/acceptance-cases.yml';
  if (extra.length || ![canonicalPath, repository + '/' + canonicalPath].includes(workflowPath) ||
      (workflowRef && workflowRef !== 'refs/heads/' + branch)) {
    throw new Error('unexpected source workflow definition path');
  }
  const sourceSha = sha(run.head_sha, 40, 'workflow_run.head_sha');
  const eventName = singleLine(run.event, 'workflow_run.event');
  if (prSmoke ? eventName !== 'pull_request' : !['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error('unsupported source workflow event ' + eventName);
  }
  if (!prSmoke && !['staging', 'main'].includes(branch)) {
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
    ...(prSmoke ? { source_kind: 'pr-smoke' } : {}),
    ...(commentRun ? { comment_case: {
      issue: Number(commentRun[1]), criterion: commentRun[2],
      comment_id: Number(commentRun[3]),
    } } : {}),
  };
}

/**
 * Convert a bot-origin explicit wake into an authenticated source event.
 * GITHUB_TOKEN dispatches do not produce a recursive workflow_run event; the
 * Case producer wakes us only after both source execution jobs have settled.
 * A run ID is a locator, NEVER permission to ingest an artifact.
 */
export async function resolveCaseIngestSourceEvent(event, {
  repository, token, request = githubRequest, pause = sleep,
  actor = process.env.GITHUB_ACTOR, ref = process.env.GITHUB_REF,
} = {}) {
  if (event?.workflow_run) {
    const source = sourceRunIdentity(event, repository);
    return { event, source };
  }

  // Historical PR Smoke replay is an owner-only main workflow_dispatch. The
  // input is a locator, never evidence: re-read the GitHub-owned original Run.
  if (event?.inputs && event?.repository?.full_name === repository) {
    const inputs = event.inputs;
    if (actor !== 'BestNathan' || ref !== 'refs/heads/main' ||
        !inputs || typeof inputs !== 'object' || Array.isArray(inputs) ||
        Object.keys(inputs).some(key => !['source_run_id', 'source_run_attempt'].includes(key))) {
      throw new Error('PR Case replay requires repository owner and trusted main');
    }
    const runId = positiveInt(inputs.source_run_id, 'source_run_id');
    const runAttempt = positiveInt(inputs.source_run_attempt, 'source_run_attempt');
    const run = await request('/repos/' + repository + '/actions/runs/' + runId, { token });
    const sourceEvent = { workflow_run: { ...run, name: run.name } };
    const source = sourceRunIdentity(sourceEvent, repository);
    if (source.source_kind !== 'pr-smoke' || source.run_id !== runId ||
        source.run_attempt !== runAttempt) {
      throw new Error('PR Case replay source is not the exact authenticated Smoke Run/Attempt');
    }
    return { event: sourceEvent, source };
  }
  if (event?.repository?.full_name !== repository ||
      event?.action !== 'nession-comment-case-ingest' ||
      event?.sender?.login !== 'github-actions[bot]' ||
      actor !== 'github-actions[bot]' || ref !== 'refs/heads/main' ||
      !event?.client_payload || Array.isArray(event.client_payload) ||
      Object.keys(event.client_payload).length !== 1 ||
      !Object.hasOwn(event.client_payload, 'source_run_id')) {
    throw new Error('Case Ingest dispatch requires the exact bot-owned main source-run locator');
  }
  const runId = positiveInt(event.client_payload.source_run_id, 'source_run_id');
  let run = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    run = await request('/repos/' + repository + '/actions/runs/' + runId, { token });
    if (run?.status === 'completed') break;
    if (attempt < 24) await pause(2000);
  }
  if (run?.status !== 'completed') throw new Error('comment Case source Run did not complete within the bounded readback');
  // REST returns static workflow "name" and dynamic "display_title".
  // The original workflow_dispatch input binds the display title; never take
  // this name from the dispatch payload or from uploaded Case JSON.
  const sourceEvent = { workflow_run: { ...run, name: run.display_title } };
  const source = sourceRunIdentity(sourceEvent, repository);
  if (source.run_id !== runId || !source.comment_case ||
      source.event !== 'workflow_dispatch' || source.head_branch !== 'main' ||
      source.run_attempt !== 1 || run.actor?.login !== 'github-actions[bot]') {
    throw new Error('explicit Case Ingest wake is not an authenticated comment-bound bot Run');
  }
  return { event: sourceEvent, source };
}


// An authenticated source-run event (or an owner-authenticated historical
// replay) is not itself permission to project PR acceptance. Re-read the
// immutable GitHub Run, PR, Jobs/Steps, Artifact and required exact-head CI
// before creating a Store record. Source-controlled artifacts supply none of
// these GitHub-side facts.
export async function attestPrSmokeSource(record, source, {
  repository, token, request = githubRequest,
} = {}) {
  const item = validateCaseRecord(record);
  if (source.source_kind !== 'pr-smoke' || source.repository !== repository ||
      source.event !== 'pull_request' || item.stage !== 'pr' || item.deployment ||
      item.result !== 'Pass' || item.target_sha !== source.head_sha ||
      item.run_id !== source.run_id || item.run_attempt !== source.run_attempt) {
    throw new Error('PR Case requires successful, exact-head, Pass-only Smoke provenance');
  }
  const prefix = '/repos/' + repository;
  const run = await request(prefix + '/actions/runs/' + source.run_id, { token });
  const fetched = sourceRunIdentity({ workflow_run: { ...run, name: run?.name } }, repository);
  if (fetched.source_kind !== 'pr-smoke' || fetched.run_id !== source.run_id ||
      fetched.run_attempt !== source.run_attempt || fetched.head_sha !== source.head_sha ||
      fetched.head_branch !== source.head_branch || fetched.workflow_id !== source.workflow_id) {
    throw new Error('PR Case source GitHub Run/Attempt identity changed');
  }

  const linked = Array.isArray(run.pull_requests) && run.pull_requests.length
    ? run.pull_requests
    : await request(prefix + '/commits/' + source.head_sha + '/pulls?per_page=100', { token });
  if (!Array.isArray(linked) || linked.length === 0 || linked.length > 100) {
    throw new Error('PR Case has no bounded GitHub source PR association');
  }
  const associated = [];
  for (const entry of linked) {
    if (!Number.isSafeInteger(entry.number) || entry.number < 1) continue;
    const pr = await request(prefix + '/pulls/' + entry.number, { token });
    if (pr.head?.sha !== source.head_sha ||
        pr.head?.repo?.full_name !== repository ||
        pr.head?.ref !== source.head_branch ||
        pr.base?.repo?.full_name !== repository ||
        !['staging', 'main'].includes(pr.base?.ref) ||
        (pr.state !== 'open' && pr.merged !== true)) continue;
    const started = Date.parse(run.created_at ?? '');
    const opened = Date.parse(pr.created_at ?? '');
    const stopped = pr.merged ? Date.parse(pr.merged_at ?? '') : Infinity;
    if (!Number.isFinite(started) || !Number.isFinite(opened) ||
        started < opened || started > stopped) continue;
    if (!parsePreMergeIssueNumbers(pr.body, repository.split('/')[0],
      repository.split('/')[1], pr.title).includes(item.issue)) continue;
    associated.push(pr);
  }
  if (associated.length !== 1) {
    throw new Error('PR Case Issue/SC is not uniquely bound to an authenticated exact-head PR');
  }
  const pr = associated[0];

  const jobs = await request(prefix + '/actions/runs/' + source.run_id +
    '/attempts/' + source.run_attempt + '/jobs?per_page=100', { token });
  if (!Array.isArray(jobs.jobs) || jobs.total_count > 100) {
    throw new Error('PR Case source Job inventory unavailable or truncated');
  }
  const matches = jobs.jobs.filter(job => job.name === 'case-smoke');
  if (matches.length !== 1) throw new Error('PR Case source execution Job missing or ambiguous');
  const job = matches[0];
  if (job.status !== 'completed' || job.conclusion !== 'success' ||
      job.run_id !== source.run_id || job.run_attempt !== source.run_attempt ||
      job.head_sha !== source.head_sha || !Number.isSafeInteger(job.id) || job.id < 1 ||
      !Array.isArray(job.steps)) {
    throw new Error('PR Case source Job is not an exact-Run/Attempt success');
  }
  for (const name of [
    'Validate canonical Case contracts and generic selection',
    'Select PR-linked Case-method proofs (trusted main policy)',
    'Run selected source-aligned Cases through one job-scoped batch',
    'Run actions/upload-artifact@v4',
  ]) {
    const steps = job.steps.filter(step => step.name === name);
    if (steps.length !== 1 || steps[0].status !== 'completed' ||
        steps[0].conclusion !== 'success') {
      throw new Error('PR Case required GitHub-owned execution step did not pass: ' + name);
    }
  }

  const artifacts = await request(prefix + '/actions/runs/' + source.run_id +
    '/artifacts?per_page=100', { token });
  if (!Array.isArray(artifacts.artifacts) || artifacts.total_count > 100) {
    throw new Error('PR Case source artifact inventory unavailable or truncated');
  }
  const artifactsFound = artifacts.artifacts.filter(a =>
    a.name === 'acceptance-case-smoke-' + source.run_id + '-' + source.run_attempt &&
    a.expired === false && a.size_in_bytes > 0 &&
    (a.workflow_run == null || (a.workflow_run.id === source.run_id &&
      a.workflow_run.head_sha === source.head_sha)));
  if (artifactsFound.length !== 1 || !Number.isSafeInteger(artifactsFound[0].id)) {
    throw new Error('PR Case source artifact is absent, expired or ambiguous');
  }

  // The two independent exact-head CI families are required for PR Case
  // projection, rather than inferring a green state from the Case artifact.
  // GitHub clears run.pull_requests on many merged PRs; after PR identity,
  // merge time, branch and SHA are attested above, historic run association is
  // still source-bound without trusting any PR-authored metadata.
  const checks = await request(prefix + '/actions/runs?head_sha=' +
    source.head_sha + '&event=pull_request&per_page=100', { token });
  if (!Array.isArray(checks.workflow_runs) || checks.total_count > 100) {
    throw new Error('PR Case exact-head required CI inventory unavailable or truncated');
  }
  const required = [
    '.github/workflows/ci-quality.yml',
    '.github/workflows/e2e-tests.yml',
  ];
  const verified = [];
  for (const path of required) {
    const runs = checks.workflow_runs.filter(check =>
      check.path?.split('@')[0] === path &&
      check.event === 'pull_request' &&
      check.head_sha === source.head_sha &&
      check.head_branch === source.head_branch &&
      check.repository?.full_name === repository &&
      check.head_repository?.full_name === repository)
      .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) ||
        (b.run_attempt ?? 0) - (a.run_attempt ?? 0) || (b.id ?? 0) - (a.id ?? 0));
    const latest = runs[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success' ||
        !Number.isSafeInteger(latest.id) || !Number.isSafeInteger(latest.run_attempt) ||
        Date.parse(latest.created_at ?? '') < Date.parse(pr.created_at ?? '') ||
        (pr.merged && Date.parse(latest.created_at ?? '') > Date.parse(pr.merged_at ?? ''))) {
      throw new Error('PR Case lacks completed exact-head required CI: ' + path);
    }
    verified.push(latest.id);
  }
  return { ...source, pr_binding: {
    pr_number: pr.number, issue: item.issue, head_sha: source.head_sha,
    case_job_id: job.id, artifact_id: artifactsFound[0].id,
    quality_run_id: verified[0], e2e_run_id: verified[1],
  } };
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
  if (source.source_kind === 'pr-smoke') {
    const binding = source.pr_binding;
    if (source.event !== 'pull_request' || item.stage !== 'pr' ||
        item.deployment || item.target_sha !== source.head_sha ||
        !binding || binding.issue !== item.issue ||
        binding.head_sha !== item.target_sha ||
        !Number.isSafeInteger(binding.pr_number) || binding.pr_number < 1 ||
        !Number.isSafeInteger(binding.case_job_id) || binding.case_job_id < 1 ||
        !Number.isSafeInteger(binding.artifact_id) || binding.artifact_id < 1 ||
        !Number.isSafeInteger(binding.quality_run_id) || binding.quality_run_id < 1 ||
        !Number.isSafeInteger(binding.e2e_run_id) || binding.e2e_run_id < 1) {
      throw new Error('PR Case source has no authenticated exact-head PR/CI/Case binding');
    }
    return assertExecutionIdentity(item);
  }
  if (item.stage === 'pr' || item.stage === 'pre-merge') {
    throw new Error('PR Case record requires the authenticated Smoke source family');
  }
  // A trusted-main workflow_dispatch can target a different Staging commit.
  // The binding is NOT taken from the Case artifact: attestCaseRecord first
  // reads its GitHub-owned pre-target step identity at this exact Run/Attempt.
  const manual = source.event === 'workflow_dispatch' &&
    source.head_branch === 'main' && !item.deployment &&
    (item.stage === 'staging' ||
      (item.stage === 'post-merge' && item.target_sha !== source.head_sha));
  if (manual) {
    const binding = source.dispatch_binding;
    if (!binding || binding.stage !== item.stage ||
        binding.target_sha !== item.target_sha ||
        binding.issue !== item.issue || binding.criterion !== item.criterion ||
        !Number.isSafeInteger(binding.job_id) || binding.job_id < 1 ||
        !Number.isSafeInteger(binding.step_number) || binding.step_number < 1) {
      throw new Error('manual Staging Case target is not bound to authenticated dispatch inputs');
    }
  } else {
    // Push and ordinary main-head manual records keep the strict existing
    // branch-head binding. Deployed records have their own attestation owner.
    if (item.target_sha !== source.head_sha) {
      throw new Error('Case target SHA is not the authenticated source workflow head');
    }
    const expectedStage = source.head_branch === 'main' ? 'post-merge' : 'staging';
    if (item.stage !== expectedStage) {
      throw new Error('Case stage disagrees with authenticated workflow source branch');
    }
  }
  return assertExecutionIdentity(item);
}

/** The triggering run identity a Case record must belong to. */
function assertRunIdentity(record, source) {
  const item = validateCaseRecord(record);
  if (item.run_id !== source.run_id || item.run_attempt !== source.run_attempt) {
    throw new Error('Case record run identity disagrees with triggering workflow_run');
  }
  if (source.comment_case && (item.issue !== source.comment_case.issue ||
      item.criterion !== source.comment_case.criterion)) {
    throw new Error('Case record Issue/SC differs from GitHub-authenticated comment Run name');
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

/**
 * Derive manual merged-branch targets independently of untrusted Case JSON.
 * Staging and historical Main use two separately pinned SHAs; Main-head runs
 * preserve the old strict equality rule without requiring a new binding.
 * Unlike logs or uploaded artifacts, Jobs/Steps names are evaluated by GitHub
 * from original workflow_dispatch inputs in the trusted-main workflow. The
 * step must succeed BEFORE the exact-target checkout / untrusted execution.
 */
export async function attestManualStagingSource(record, source, {
  repository, token, request = githubRequest,
} = {}) {
  const item = validateCaseRecord(record);
  if (source.event !== 'workflow_dispatch' || source.head_branch !== 'main' ||
      item.deployment) return source;
  const dualSha = item.stage === 'staging' ||
    (item.stage === 'post-merge' && item.target_sha !== source.head_sha);
  if (!dualSha && !source.comment_case) return source;
  if (source.comment_case && !['staging', 'post-merge'].includes(item.stage)) {
    throw new Error('comment Case must target an eligible merged stage');
  }
  const manualPrefix = item.stage === 'staging'
    ? 'Authenticate manual Staging Case ' : 'Authenticate manual Post-Merge Case ';
  const manualPattern = item.stage === 'staging' ? MANUAL_STAGING_STEP : MANUAL_POST_MERGE_STEP;
  if (source.repository !== repository) throw new Error('manual Case repository mismatch');
  const jobs = await request('/repos/' + repository +
    '/actions/runs/' + source.run_id + '/attempts/' + source.run_attempt +
    '/jobs?per_page=100', { token });
  if (!Array.isArray(jobs?.jobs) || jobs.jobs.length > 100) {
    throw new Error('manual Case GitHub source job readback is unavailable or unbounded');
  }
  const matches = [];
  let authenticatedCommentJobs = 0;
  for (const job of jobs.jobs) {
    if (!['execute', 'execute-macos'].includes(job.name) || job.conclusion === 'skipped') continue;
    if (job.run_id !== source.run_id || job.run_attempt !== source.run_attempt ||
        job.head_sha !== source.head_sha || job.status !== 'completed' ||
        !['success', 'failure'].includes(job.conclusion) ||
        !Number.isSafeInteger(job.id) || job.id < 1 ||
        !Array.isArray(job.steps)) {
      throw new Error('manual Case GitHub source job identity is unverified');
    }
    const checkoutIndex = job.steps.findIndex(step => step.name === 'Checkout exact target SHA');
    if (source.comment_case) {
      const commentSteps = job.steps.map((step, index) => ({ step, index })).filter(
        ({ step }) => step.name === 'Verify original human Case comment and source-bound target');
      if (commentSteps.length !== 1 || commentSteps[0].index >= checkoutIndex ||
          commentSteps[0].step.status !== 'completed' ||
          commentSteps[0].step.conclusion !== 'success') {
        throw new Error('original human comment was not authenticated before target checkout');
      }
      authenticatedCommentJobs += 1;
    }
    if (!dualSha) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!String(step.name ?? '').startsWith(manualPrefix)) continue;
      const fields = manualPattern.exec(step.name);
      if (!fields || index >= checkoutIndex ||
          step.status !== 'completed' || step.conclusion !== 'success' ||
          !Number.isSafeInteger(step.number) || step.number < 1) {
        throw new Error('manual Case target dispatch step is invalid or executed after target checkout');
      }
      matches.push({
        target_sha: fields[3], stage: item.stage, issue: Number(fields[1]),
        criterion: fields[2], job_id: job.id, step_number: step.number,
      });
    }
  }
  if (source.comment_case && authenticatedCommentJobs === 0) {
    throw new Error('no authenticated original human comment Case source job');
  }
  if (!dualSha) return source;
  if (matches.length !== 1) throw new Error('missing or ambiguous authenticated manual ' +
    item.stage + ' target step');
  return { ...source, dispatch_binding: matches[0] };
}

async function attestCaseRecord(record, {
  event, repository, token, request = githubRequest, deploymentRecords = null,
}) {
  const candidate = validateCaseRecord(record);
  const original = sourceRunIdentity(event, repository);
  const source = original.source_kind === 'pr-smoke'
    ? await attestPrSmokeSource(candidate, original, { repository, token, request })
    : await attestManualStagingSource(candidate, original, { repository, token, request });
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

  if (item.stage === 'pr' || item.stage === 'pre-merge') {
    const trusted = item.provenance?.verified_source;
    if (item.stage !== 'pr' || !trusted || trusted.source_kind !== 'pr-smoke' ||
        item.provenance?.record_path !== recordPath(item) ||
        item.provenance?.workflow_url !== 'https://github.com/' + repository +
          '/actions/runs/' + item.run_id) {
      throw new Error('PR Case projection requires its immutable trusted Store provenance');
    }
    // Re-read authenticated GitHub identities at the Issue-write boundary too.
    // A crafted record on a workstation cannot become an Acceptance Pass.
    const original = await request('/repos/' + repository +
      '/actions/runs/' + item.run_id, { token });
    const source = sourceRunIdentity({
      workflow_run: { ...original, name: original.name },
    }, repository);
    const rebound = await attestPrSmokeSource(item, source, { repository, token, request });
    if (JSON.stringify(rebound) !== JSON.stringify(trusted)) {
      throw new Error('PR Case stored provenance differs from verified original Run/PR/CI');
    }
    assertSourceBoundRecord(item, rebound);
    const issue = await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, { token });
    if (!isAcceptanceIssue(issue)) throw new Error('#' + item.issue + ' must be labeled bug or requirement');
    if (String(issue.state).toLowerCase() !== 'open') {
      return { projected: false, reason: 'Requirement #' + item.issue + ' is not open' };
    }
    if (!historicalCaseMayProject(issue.body, item.criterion)) {
      return { projected: false, reason: 'PR Case cannot replay or overwrite an existing SC verdict' };
    }
    const context = buildAcceptanceContext(issue, 'pr', {
      method: 'case', targetRef: item.target_sha, runId: item.run_id,
    });
    const normalized = normalizeAcceptanceCaseResult(context, item, 'case-runner');
    const updatedBody = applyAcceptanceResultToBody(issue.body, normalized);
    if (updatedBody === issue.body) return { projected: true, changed: false };
    await request('/repos/' + owner + '/' + name + '/issues/' + item.issue, {
      token, method: 'PATCH', body: { body: updatedBody },
    });
    return { projected: true, changed: true };
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
  // Dynamic comment run names are GitHub-owned dispatch metadata, never an
  // alternative source Workflow/path/branch identity. Test both good and
  // hostile completed workflow_run payloads with the original Case record.
  const commentEvent = { workflow_run: {
    ...fixtureEvent.workflow_run,
    name: 'Comment Case #1474 SC-14 comment:999',
    head_branch: 'main', event: 'workflow_dispatch',
  } };
  const commentSource = sourceRunIdentity(commentEvent, 'BestNathan/nession');
  assert.deepEqual(commentSource.comment_case, {
    issue: 1474, criterion: 'SC-14', comment_id: 999,
  });
  assert.equal(assertSourceBoundRecord({ ...valid, stage: 'post-merge' }, commentSource).issue, 1474);
  assert.throws(() => assertSourceBoundRecord({ ...valid, stage: 'post-merge',
    criterion: 'SC-15' }, commentSource), /GitHub-authenticated comment Run name/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, stage: 'post-merge',
    issue: 1700 }, commentSource), /GitHub-authenticated comment Run name/);
  for (const name of [
    'Comment Case #1474 SC-14 comment:999 extra',
    'Comment Case #1474 SC-14 comment:0',
    'Comment Case #bad SC-14 comment:999',
    'Comment Case #1474 SC-14 comment:999\\ninjected',
    'Unrelated Workflow',
  ]) {
    assert.throws(() => sourceRunIdentity({
      workflow_run: { ...commentEvent.workflow_run, name },
    }, 'BestNathan/nession'), /expected a completed Acceptance/);
  }
  assert.throws(() => sourceRunIdentity({ workflow_run: {
    ...commentEvent.workflow_run, event: 'push',
  } }, 'BestNathan/nession'), /trusted main workflow_dispatch/);
  assert.throws(() => sourceRunIdentity({ workflow_run: {
    ...commentEvent.workflow_run, head_branch: 'staging',
  } }, 'BestNathan/nession'), /trusted main workflow_dispatch/);
  assert.throws(() => sourceRunIdentity({ workflow_run: {
    ...commentEvent.workflow_run, path: '.github/workflows/untrusted.yml',
  } }, 'BestNathan/nession'), /unexpected source workflow definition path/);
  assert.throws(() => sourceRunIdentity({ workflow_run: {
    ...commentEvent.workflow_run, repository: { full_name: 'other/nession' },
  } }, 'BestNathan/nession'), /repository mismatch/);
  // Explicit GITHUB_TOKEN comment wakes must re-fetch GitHub's Run, not
  // reconstruct evidence from a caller-selected display name or artifact.
  const wakeEvent = { repository: { full_name: 'BestNathan/nession' },
    action: 'nession-comment-case-ingest', sender: { login: 'github-actions[bot]' },
    client_payload: { source_run_id: '100' } };
  const wakeRun = { ...commentEvent.workflow_run, id: 100,
    name: 'Acceptance / Cases', display_title: commentEvent.workflow_run.name,
    actor: { login: 'github-actions[bot]' } };
  const wakeOptions = { repository: 'BestNathan/nession',
    actor: 'github-actions[bot]', ref: 'refs/heads/main',
    request: async () => wakeRun, pause: async () => {} };
  const verifiedWake = await resolveCaseIngestSourceEvent(wakeEvent, wakeOptions);
  assert.equal(verifiedWake.source.comment_case.comment_id, 999);
  for (const denied of [
    { actor: 'attacker' }, { ref: 'refs/heads/staging' },
    { request: async () => ({ ...wakeRun, actor: { login: 'attacker' } }) },
    { request: async () => ({ ...wakeRun, display_title: 'Other workflow' }) },
    { request: async () => ({ ...wakeRun, path: '.github/workflows/other.yml' }) },
    { request: async () => ({ ...wakeRun, id: 101 }) },
    { request: async () => ({ ...wakeRun, run_attempt: 2 }) },
    { request: async () => ({ ...wakeRun, status: 'queued' }) },
  ]) {
    await assert.rejects(() => resolveCaseIngestSourceEvent(wakeEvent,
      { ...wakeOptions, ...denied }), /Case Ingest|Case source|completed Acceptance|workflow definition|source_run_id|not an authenticated|expected a completed/);
  }
  await assert.rejects(() => resolveCaseIngestSourceEvent({
    ...wakeEvent, client_payload: { source_run_id: '100', other: 'payload' },
  }, wakeOptions), /Case Ingest dispatch/);
  await assert.rejects(() => resolveCaseIngestSourceEvent({
    ...wakeEvent, sender: { login: 'attacker' },
  }, wakeOptions), /Case Ingest dispatch/);
  await assert.rejects(() => resolveCaseIngestSourceEvent({
    ...wakeEvent, action: 'unrelated',
  }, wakeOptions), /Case Ingest dispatch/);
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
  // #3316: GitHub-owned step metadata (evaluated from workflow_dispatch
  // inputs before target checkout) binds manual Staging proof separately from
  // the trusted-main workflow code SHA. A Case artifact cannot create it.
  const manualSource = {
    ...source, event: 'workflow_dispatch', head_branch: 'main',
    head_sha: 'e'.repeat(40),
  };
  const manualStep = {
    number: 3, status: 'completed', conclusion: 'success',
    name: 'Authenticate manual Staging Case 1474 SC-14 ' + valid.target_sha,
  };
  const manualJob = {
    id: 700, name: 'execute', run_id: valid.run_id,
    run_attempt: valid.run_attempt, head_sha: manualSource.head_sha,
    status: 'completed', conclusion: 'success',
    steps: [
      { number: 2, name: 'Checkout trusted discovery tooling' },
      manualStep,
      { number: 4, name: 'Resolve target identity' },
      { number: 5, name: 'Checkout exact target SHA' },
    ],
  };
  const manualJobPath = '/repos/BestNathan/nession/actions/runs/100/attempts/1/jobs?per_page=100';
  const manualJobs = { jobs: [manualJob, {
    id: 701, name: 'execute-macos', conclusion: 'skipped',
    status: 'completed', run_id: 100, run_attempt: 1,
  }] };
  const manuallyBound = await attestManualStagingSource(valid, manualSource, {
    repository: 'BestNathan/nession', token: 'self-test',
    request: async (apiPath) => {
      assert.equal(apiPath, manualJobPath);
      return manualJobs;
    },
  });
  assert.equal(manuallyBound.dispatch_binding.target_sha, valid.target_sha);
  assert.equal(manuallyBound.dispatch_binding.job_id, 700);
  // The same GitHub-derived proof works when manual selection runs only
  // on macOS; the platform-skipped Linux job must not block ingestion.
  const macOSBound = await attestManualStagingSource(valid, manualSource, {
    repository: 'BestNathan/nession', token: 'self-test',
    request: async () => ({ jobs: [
      { ...manualJob, status: 'completed', conclusion: 'skipped', steps: [] },
      { ...manualJob, id: 702, name: 'execute-macos' },
    ] }),
  });
  assert.equal(macOSBound.dispatch_binding.job_id, 702);
  assert.equal(assertSourceBoundRecord(valid, manuallyBound).criterion, valid.criterion);
  assert.throws(() => assertSourceBoundRecord(valid, manualSource), /not bound/);
  const manualEvent = { workflow_run: {
    ...fixtureEvent.workflow_run, event: 'workflow_dispatch',
    head_sha: manualSource.head_sha, head_branch: 'main',
    path: '.github/workflows/acceptance-cases.yml',
  } };
  const manualRequest = async (apiPath) =>
    apiPath === manualJobPath ? manualJobs : attestationRequest(apiPath);
  const manualAttested = await attestCaseRecord(valid, {
    event: manualEvent, repository: 'BestNathan/nession',
    token: 'self-test', request: manualRequest,
  });
  assert.equal(manualAttested.source.dispatch_binding.issue, 1474);
  // A historical Main merge Case also has a distinct product SHA. The source
  // is only permitted after its *own* GitHub-owned post-merge dispatch step,
  // not by relabeling an authenticated Staging step or trusting the artifact.
  const historicalMain = { ...valid, stage: 'post-merge' };
  const mainStep = { ...manualStep,
    name: 'Authenticate manual Post-Merge Case 1474 SC-14 ' + valid.target_sha };
  const mainJob = { ...manualJob, steps: [
    { number: 1, name: 'Checkout trusted discovery tooling' },
    { number: 2, name: 'Verify original human Case comment and source-bound target',
      status: 'completed', conclusion: 'success' },
    mainStep,
    { number: 4, name: 'Resolve target identity' },
    { number: 5, name: 'Checkout exact target SHA' },
  ] };
  const mainJobs = { jobs: [mainJob] };
  const currentMainComment = await attestManualStagingSource(historicalMain, commentSource, {
    repository: 'BestNathan/nession', token: 'self-test',
    request: async () => ({ jobs: [{ ...mainJob, head_sha: historicalMain.target_sha }] }),
  });
  assert.equal(currentMainComment.dispatch_binding, undefined,
    'current main SHA does not require a distinct historical target binding');
  await assert.rejects(() => attestManualStagingSource(historicalMain, commentSource, {
    repository: 'BestNathan/nession', token: 'self-test',
    request: async () => ({ jobs: [{ ...mainJob,
      head_sha: historicalMain.target_sha,
      steps: mainJob.steps.filter(step =>
        step.name !== 'Verify original human Case comment and source-bound target') }] }),
  }), /original human comment/);
  const historicalBound = await attestManualStagingSource(historicalMain, manualSource, {
    repository: 'BestNathan/nession', token: 'self-test',
    request: async () => mainJobs,
  });
  assert.equal(historicalBound.dispatch_binding.stage, 'post-merge');
  assert.equal(assertSourceBoundRecord(historicalMain, historicalBound).issue, 1474);
  assert.throws(() => assertSourceBoundRecord(historicalMain, manualSource), /not bound/);
  const commentManualEvent = { workflow_run: {
    ...manualEvent.workflow_run,
    name: 'Comment Case #1474 SC-14 comment:999',
  } };
  const mainAttested = await attestCaseRecord(historicalMain, {
    event: commentManualEvent, repository: 'BestNathan/nession',
    token: 'self-test',
    request: async p => p === manualJobPath ? mainJobs : attestationRequest(p),
  });
  assert.equal(mainAttested.source.dispatch_binding.stage, 'post-merge');
  assert.equal(caseIndexRecord(enrichCaseRecord(historicalMain, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(historicalMain), source: mainAttested.source,
  })).stage, 'post-merge');
  assert.equal((await attestManualStagingSource(historicalMain, {
    ...manualSource, head_sha: historicalMain.target_sha,
  }, { repository: 'BestNathan/nession', request: async () => {
    throw Error('historical/main-head equality must not fetch input binding');
  } })).dispatch_binding, undefined);
  for (const tampered of [
    { jobs: [{ ...mainJob, steps: mainJob.steps.filter(x => x !== mainStep) }] },
    { jobs: [{ ...mainJob, steps: [mainStep, { number: 5,
      name: 'Checkout exact target SHA' }, mainStep] }] },
    { jobs: [{ ...mainJob, steps: [{ ...mainStep, conclusion: 'failure' },
      { number: 5, name: 'Checkout exact target SHA' }] }] },
    { jobs: [{ ...mainJob, head_sha: 'f'.repeat(40) }] },
    { jobs: [{ ...mainJob, run_attempt: 999 }] },
  ]) {
    await assert.rejects(() => attestManualStagingSource(historicalMain, manualSource, {
      repository: 'BestNathan/nession', token: 'self-test',
      request: async () => tampered,
    }), /manual Case|missing or ambiguous/);
  }
  const stagingStepOnly = await assert.rejects(() => attestManualStagingSource(
    historicalMain, manualSource, {
      repository: 'BestNathan/nession', token: 'self-test',
      request: async () => manualJobs,
    }), /missing or ambiguous/);
  void stagingStepOnly;
  assert.equal(caseIndexRecord(enrichCaseRecord(valid, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(valid), source: manualAttested.source,
  })).target_sha, valid.target_sha);
  for (const bad of [
    { jobs: [{ ...manualJob, steps: manualJob.steps.filter(s => s !== manualStep) }] },
    { jobs: [{ ...manualJob, steps: [{ number: 2, name: 'Checkout exact target SHA' }, manualStep] }] },
    { jobs: [{ ...manualJob, steps: [{ ...manualStep, conclusion: 'failure' },
      { number: 5, name: 'Checkout exact target SHA' }] }] },
    { jobs: [{ ...manualJob, run_attempt: 2 }] },
    { jobs: [{ ...manualJob, head_sha: 'f'.repeat(40) }] },
    { jobs: [{ ...manualJob, steps: [
      { ...manualStep, name: 'Authenticate manual Staging Case 1474 SC-14 ' + 'c'.repeat(40) },
      { number: 5, name: 'Checkout exact target SHA' },
    ] }] },
    { jobs: [{ ...manualJob, steps: [manualStep, manualStep,
      { number: 5, name: 'Checkout exact target SHA' }] }] },
  ]) {
    if (bad.jobs[0].steps?.length === 2 &&
        bad.jobs[0].steps[0]?.name?.endsWith('c'.repeat(40))) {
      const forged = await attestManualStagingSource(valid, manualSource, {
        repository: 'BestNathan/nession', token: 'self-test',
        request: async () => bad,
      });
      assert.throws(() => assertSourceBoundRecord(valid, forged), /not bound/);
    } else {
      await assert.rejects(() => attestManualStagingSource(valid, manualSource, {
        repository: 'BestNathan/nession', token: 'self-test',
        request: async () => bad,
      }), /manual Case|missing or ambiguous/);
    }
  }
  assert.throws(() => assertSourceBoundRecord(
    { ...valid, issue: 1499 }, manuallyBound), /not bound/);
  assert.throws(() => assertSourceBoundRecord(
    { ...valid, criterion: 'SC-15' }, manuallyBound), /not bound/);
  assert.throws(() => assertSourceBoundRecord(
    { ...valid, run_attempt: 2 }, manuallyBound), /run identity/);
  // Correct run/attempt and input target still cannot attest a forged Case
  // tree; the tree must physically exist at the GitHub target commit.
  const forgedTree = { ...valid, case_tree_sha: 'f'.repeat(40) };
  forgedTree.execution_id = crypto.createHash('sha256').update(JSON.stringify({
    schema_version: 1, run_id: forgedTree.run_id, run_attempt: forgedTree.run_attempt,
    target_sha: forgedTree.target_sha, issue: forgedTree.issue,
    criterion: forgedTree.criterion, contract_sha256: forgedTree.contract_sha256,
    case_tree_sha: forgedTree.case_tree_sha,
  })).digest('hex');
  await assert.rejects(() => attestCaseRecord(forgedTree, {
    event: manualEvent, repository: 'BestNathan/nession',
    token: 'self-test', request: manualRequest,
  }), /Case Git tree does not match/);
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

  // #3611: historical exact-head PR Case ingestion and negative trust fixtures.
  const smokeSha = 'b'.repeat(40);
  const smokeIssueBody = [
    '## Success Criteria',
    '- [ ] SC-14 Browser Session metadata invalidates on new incarnation.',
    '## Acceptance Plan',
    '~~~yaml',
    'acceptance:',
    '  SC-14:',
    '    when: pr',
    '    method: case',
    '~~~',
    '## Acceptance Report',
    '| Criterion | Result | Evidence |',
    '|---|---|---|',
    '| SC-14 | Pending | Awaiting exact-head browser Case |',
  ].join('\n').replaceAll('~~~', String.fromCharCode(96).repeat(3));
  let smokeIssue = { number: 1474, title: 'Browser metadata cache',
    state: 'open', labels: [{ name: 'bug' }], body: smokeIssueBody };
  const smokeContext = buildAcceptanceContext(smokeIssue, 'pr', {
    method: 'case', targetRef: smokeSha, runId: 100,
  });
  const smokeRecord = fixtureRecord({ stage: 'pr', target_sha: smokeSha,
    case_revision: smokeSha,
    criterion_text: 'Browser Session metadata invalidates on new incarnation.',
    contract_sha256: smokeContext.contract_sha256 });
  smokeRecord.execution_id = crypto.createHash('sha256').update(JSON.stringify({
    schema_version: 1, run_id: smokeRecord.run_id,
    run_attempt: smokeRecord.run_attempt, target_sha: smokeRecord.target_sha,
    issue: smokeRecord.issue, criterion: smokeRecord.criterion,
    contract_sha256: smokeRecord.contract_sha256,
    case_tree_sha: smokeRecord.case_tree_sha,
  })).digest('hex');
  const smokeRun = { ...fixtureEvent.workflow_run,
    name: 'Acceptance / Case Smoke',
    path: '.github/workflows/acceptance-case-smoke.yml',
    event: 'pull_request', head_branch: 'fix/1474-cache',
    head_sha: smokeSha, workflow_id: 17,
    created_at: '2026-11-14T19:19:11Z', run_number: 1, pull_requests: [] };
  const smokeSource = sourceRunIdentity({ workflow_run: smokeRun }, 'BestNathan/nession');
  assert.equal(smokeSource.source_kind, 'pr-smoke');
  for (const bad of [
    { path: '.github/workflows/acceptance-cases.yml' },
    { event: 'workflow_dispatch' },
    { conclusion: 'failure' },
  ]) {
    assert.throws(() => sourceRunIdentity({
      workflow_run: { ...smokeRun, ...bad },
    }, 'BestNathan/nession'));
  }
  const smokePr = { number: 70, title: 'fix: metadata', body: 'Refs #1474',
    state: 'closed', merged: true,
    head: { sha: smokeSha, ref: smokeRun.head_branch,
      repo: { full_name: 'BestNathan/nession' } },
    base: { ref: 'staging', repo: { full_name: 'BestNathan/nession' } },
    created_at: '2026-11-14T18:00:00Z', merged_at: '2026-11-14T20:00:00Z' };
  const stepNames = ['Validate canonical Case contracts and generic selection',
    'Select PR-linked Case-method proofs (trusted main policy)',
    'Run selected source-aligned Cases through one job-scoped batch',
    'Run actions/upload-artifact@v4'];
  const smokeJob = { id: 41, name: 'case-smoke', run_id: 100,
    run_attempt: 1, head_sha: smokeSha, status: 'completed',
    conclusion: 'success', steps: stepNames.map((name, index) => ({
      name, number: index + 1, status: 'completed', conclusion: 'success' })) };
  const smokeArtifact = { id: 55, name: 'acceptance-case-smoke-100-1',
    expired: false, size_in_bytes: 1024,
    workflow_run: { id: 100, head_sha: smokeSha } };
  const smokeQuality = ['ci-quality.yml', 'e2e-tests.yml'].map((name, index) => ({
    id: 80 + index, path: '.github/workflows/' + name,
    event: 'pull_request', head_sha: smokeSha, head_branch: smokeRun.head_branch,
    repository: { full_name: 'BestNathan/nession' },
    head_repository: { full_name: 'BestNathan/nession' },
    status: 'completed', conclusion: 'success', run_attempt: 1,
    run_number: 1, created_at: smokeRun.created_at }));
  const smokeApi = async (path, options = {}, overrides = {}) => {
    if (path.endsWith('/actions/runs/100')) return overrides.run ?? smokeRun;
    if (path.endsWith('/commits/' + smokeSha + '/pulls?per_page=100'))
      return overrides.linked ?? [{ number: 70 }];
    if (path.endsWith('/pulls/70')) return overrides.pr ?? smokePr;
    if (path.endsWith('/attempts/1/jobs?per_page=100'))
      return { total_count: 1, jobs: [overrides.job ?? smokeJob] };
    if (path.endsWith('/runs/100/artifacts?per_page=100'))
      return { total_count: 1, artifacts: [overrides.artifact ?? smokeArtifact] };
    if (path.includes('/actions/runs?head_sha=' + smokeSha))
      return { total_count: 2, workflow_runs: overrides.checks ?? smokeQuality };
    if (path.endsWith('/issues/1474')) {
      if (options.method === 'PATCH') smokeIssue = { ...smokeIssue, body: options.body.body };
      return smokeIssue;
    }
    throw Error('unmocked PR Case source: ' + path);
  };
  const smokeOptions = { repository: 'BestNathan/nession', token: 'offline-proof' };
  const certifiedSmoke = await attestPrSmokeSource(smokeRecord, smokeSource, {
    ...smokeOptions, request: smokeApi });
  assert.equal(certifiedSmoke.pr_binding.pr_number, 70);
  assert.equal(certifiedSmoke.pr_binding.artifact_id, 55);
  assert.equal(assertSourceBoundRecord(smokeRecord, certifiedSmoke).stage, 'pr');
  assert.throws(() => assertSourceBoundRecord(smokeRecord, smokeSource));
  assert.throws(() => assertSourceBoundRecord({
    ...smokeRecord, contract_sha256: 'f'.repeat(64),
  }, certifiedSmoke), /execution_id/);
  assert.throws(() => assertSourceBoundRecord({
    ...smokeRecord, run_attempt: 2,
  }, certifiedSmoke), /run identity/);
  for (const [label, overrides] of [
    ['stale head', { pr: { ...smokePr, head: { ...smokePr.head, sha: 'f'.repeat(40) } } }],
    ['wrong issue', { pr: { ...smokePr, body: 'Refs #9000' } }],
    ['wrong base', { pr: { ...smokePr, base: { ...smokePr.base, ref: 'unknown' } } }],
    ['unmerged closure', { pr: { ...smokePr, merged: false, state: 'closed' } }],
    ['run after merge', { run: { ...smokeRun, created_at: '2026-11-15T20:00:00Z' } }],
    ['skipped execution', { job: { ...smokeJob,
      steps: smokeJob.steps.map(step => step.name.startsWith('Run selected')
        ? { ...step, conclusion: 'skipped' } : step) } }],
    ['failed source job', { job: { ...smokeJob, conclusion: 'failure' } }],
    ['wrong job attempt', { job: { ...smokeJob, run_attempt: 2 } }],
    ['expired artifact', { artifact: { ...smokeArtifact, expired: true } }],
    ['wrong artifact attempt', { artifact: { ...smokeArtifact, name: 'acceptance-case-smoke-100-2' } }],
    ['required E2E pending', { checks: smokeQuality.map((run, index) =>
      index === 1 ? { ...run, conclusion: 'skipped' } : run) }],
    ['required CI wrong SHA', { checks: smokeQuality.map((run, index) =>
      index === 0 ? { ...run, head_sha: 'f'.repeat(40) } : run) }],
  ]) {
    await assert.rejects(() => attestPrSmokeSource(smokeRecord, smokeSource, {
      ...smokeOptions, request: (path, opts) => smokeApi(path, opts, overrides),
    }), undefined, label + ' must fail closed');
  }
  await assert.rejects(() => attestPrSmokeSource({
    ...smokeRecord, result: 'Pending',
    verifiers: [{ ...smokeRecord.verifiers[0], result: 'Pending' }],
  }, smokeSource, { ...smokeOptions, request: smokeApi }), /Pass-only/);
  const ownerReplay = { repository: { full_name: 'BestNathan/nession' },
    inputs: { source_run_id: '100', source_run_attempt: '1' } };
  const replayOpts = { ...smokeOptions, actor: 'BestNathan',
    ref: 'refs/heads/main', request: smokeApi };
  const replayedSource = await resolveCaseIngestSourceEvent(ownerReplay, replayOpts);
  assert.equal(replayedSource.source.run_id, 100);
  for (const override of [
    { actor: 'attacker' }, { ref: 'refs/heads/staging' },
    { request: async () => ({ ...smokeRun, run_attempt: 2 }) },
  ]) {
    await assert.rejects(() => resolveCaseIngestSourceEvent(ownerReplay,
      { ...replayOpts, ...override }), undefined,
    'unauthorized or wrong-attempt replay must fail');
  }
  const smokeEnriched = enrichCaseRecord(smokeRecord, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(smokeRecord), source: certifiedSmoke });
  const smokeIndex = caseIndexRecord(smokeEnriched);
  assert.equal(smokeIndex.stage, 'pr');
  assert.equal(smokeIndex.source.pr_binding.case_job_id, 41);
  await assert.rejects(() => applyCaseRecord(smokeRecord, {
    ...smokeOptions, request: smokeApi,
  }), /immutable trusted Store provenance/);
  assert.deepEqual(await applyCaseRecord(smokeEnriched, {
    ...smokeOptions, request: smokeApi,
  }), { projected: true, changed: true });
  assert.match(smokeIssue.body, /- \[x\] SC-14/);
  assert.match(smokeIssue.body, /\| SC-14 \| Pass \| run 100;/);
  assert.equal((await applyCaseRecord(smokeEnriched, {
    ...smokeOptions, request: smokeApi,
  })).projected, false, 'replay cannot rewrite accepted SC');
  smokeIssue = { ...smokeIssue, body: smokeIssueBody.replace('method: case', 'method: agent') };
  await assert.rejects(() => applyCaseRecord(smokeEnriched, {
    ...smokeOptions, request: smokeApi,
  }), /contract digest|selected method/);

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
  if (command === 'prepare-event') {
    const input = process.argv[3] || process.env.GITHUB_EVENT_PATH;
    const output = process.argv[4];
    if (!input || !output) throw new Error('prepare-event EVENT OUT required');
    const event = JSON.parse(fs.readFileSync(input, 'utf8'));
    const resolved = await resolveCaseIngestSourceEvent(event, {
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    fs.writeFileSync(output, JSON.stringify(resolved.event) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({
      run_id: resolved.source.run_id, run_attempt: resolved.source.run_attempt,
      source_kind: resolved.source.source_kind ?? 'merged-case',
      source_conclusion: resolved.event.workflow_run.conclusion,
      source_url: 'https://github.com/' + resolved.source.repository +
        '/actions/runs/' + resolved.source.run_id,
    }) + '\n');
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
  throw new Error('usage: node scripts/acceptance-case-ingest.mjs <self-test|validate FILE|prepare-event EVENT OUT|attest FILE EVENT|record-path FILE|index RECORD OUTPUT|enrich IN OUT WORKFLOW_URL RECORD_PATH EVENT|apply FILE>');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
