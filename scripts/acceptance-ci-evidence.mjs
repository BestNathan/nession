#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectHistoricalE2EForPull, collectLinkedIssueE2EEvidence } from './acceptance-e2e-lineage.mjs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';
import { collectCrossIssueAcceptance } from './acceptance-cross-issue-receipt.mjs';
import { collectRelatedBugCompletion } from './acceptance-bug-bootstrap-receipt.mjs';
import { collectE2eWakeReceipts } from './acceptance-postrun-e2e-receipt.mjs';
import { verifyWake } from './agent-evidence-waker.mjs';
import {collectHistoricalRecovery,selfTestHistoricalRecovery} from './acceptance-telemetry-recovery-proof.mjs';
import {parseReplayDenialLog,attestReplayDenial,makeDenialReceipt,DENIAL_LOG_PREFIX} from './metrics-replay-denial-receipt.mjs';
import {parsePolicyObservabilityLog,attestPolicyObservability,makePolicyObservabilityReceipt,
  POLICY_WORKFLOW,POLICY_WORKFLOW_NAME,POLICY_OBSERVE_JOB,POLICY_TRIGGER_EVENTS,
  POLICY_OBSERVABILITY_LOG_PREFIX} from './run-store-policy-observability-receipt.mjs';
import {GOVERNED_REFS,UNOBSERVABLE_CAPABILITIES} from './run-store-policy.mjs';
import {parseAcceptanceBatchLog,attestAcceptanceBatchReceipt,makeAcceptanceBatchReceipt,
  ACCEPTANCE_BATCH_WORKFLOWS,ACCEPTANCE_BATCH_LOG_PREFIX} from '../e2e/runner/acceptance-batch-receipt.mjs';
import {parseE2eSelectedRunLog,attestE2eSelectedRunReceipt,makeE2eSelectedRunReceipt,
  parseE2eNotRequiredLog,attestE2eNotRequiredReceipt,makeE2eNotRequiredReceipt,
  parseE2eFullGateLog,attestE2eFullGateReceipt,
  E2E_SELECTED_RUN_LOG_PREFIX,E2E_NOT_REQUIRED_LOG_PREFIX,E2E_FULL_GATE_LOG_PREFIX,
  E2E_SELECTED_WORKFLOW,E2E_SELECTED_WORKFLOW_NAME,E2E_SELECTED_JOB,
  E2E_SELECTED_EVENTS} from './e2e-selected-run-receipt.mjs';
import {attestFullReceipt} from '../e2e/runner/e2e-full-per-id-receipt.mjs';
import {historicalCaseEvidence,selfTestHistoricalCase} from './acceptance-historical-case-replay.mjs';
import { collectAuthenticatedCaseReadbacks, selfTestCaseReceipts } from './acceptance-case-readback-evidence.mjs';
import {collectHistoricalBrowserDesignProof, selfTestHistoricalBrowserDesign} from './acceptance-browser-design-history.mjs';
import {collectVerifiedCiCostStudy,selfTestCiCostStudy} from './acceptance-ci-cost-study.mjs';
import os from 'node:os';
import path from 'node:path';

const MAX_RUNS_PER_SHA = 20;
const MAX_ASSOCIATED_PULLS = 5;
const MAX_IMPLEMENTATION_PULLS = 2;
const MAX_CROSS_REFERENCED_PULLS = 40;
const MAX_EXACT_E2E_STEP_RUNS = 2;
const MAX_TARGET_PUSH_E2E_RUNS = 5;
const E2E_STEP_NAMES = Object.freeze(['Resolve linked Issue E2E obligations', 'Run E2E tests', 'Normalize selected per-file results even on failure', 'Enforce authenticated selected-E2E execution result']);
const IMPLEMENTATION_OWNER_PATHS = Object.freeze([
  '.github/workflows/e2e-test-ingest.yml',
  'scripts/issue-e2e-projection-receipt.mjs',
]);
const REQUIRED_PR_CHECKS = Object.freeze([
  'CI / Quality Gate', 'E2E / Tests', 'Acceptance / Case Smoke',
  'Acceptance / Orchestrator',
]);


// An Issue may describe itself as a child of a behavior verified on another
// Issue. This mutable relationship is ONLY a bounded discovery hint, never
// evidence that this Issue owned the source Plan or was itself patched.
export function parentEvidenceDiscovery(issue) {
  const title=String(issue?.title??'');
  const body=String(issue?.body??'');
  const a=title.match(/\(#([1-9]\d*)\)\s*$/);
  const b=body.match(/\bchild\s+of\s+#([1-9]\d*)\b/i);
  if(!a||!b||a[1]!==b[1])return null;
  const parent=Number(a[1]);
  if(!Number.isSafeInteger(parent)||parent<=0||parent===Number(issue?.number))
    return null;
  return parent;
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(label + ' is required');
  return text;
}

function compactRun(run) {
  return {
    id: Number(run.id),
    name: String(run.name ?? ''),
    path: String(run.path ?? ''),
    event: String(run.event ?? ''),
    status: String(run.status ?? ''),
    conclusion: run.conclusion == null ? null : String(run.conclusion),
    head_branch: run.head_branch == null ? null : String(run.head_branch),
    head_sha: String(run.head_sha ?? ''),
    html_url: String(run.html_url ?? ''),
    created_at: run.created_at == null ? null : String(run.created_at),
    updated_at: run.updated_at == null ? null : String(run.updated_at),
  };
}

// #1858: retaining only the newest MAX_RUNS_PER_SHA runs hid live evidence. A
// main push fires its Gate workflows first, so they are the oldest runs at that
// SHA and age out first once the SHA exceeds the bound, while a dropped run is
// indistinguishable from one that never ran. Keep the newest run of every
// workflow path present at the SHA, unioned with the newest MAX_RUNS_PER_SHA,
// and report how many runs were still dropped so absence is never silent.
function retainedRuns(runs, expectedSha) {
  const atSha = (Array.isArray(runs) ? runs : [])
    .filter((run) => String(run?.head_sha ?? '') === expectedSha)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const keyOf = (run) => String(run?.id ?? String(run?.path ?? '') + '@' + String(run?.created_at ?? ''));
  const chosen = new Map();
  const seenPath = new Set();
  for (const run of atSha) {
    const path = String(run?.path ?? '');
    if (seenPath.has(path)) continue;
    seenPath.add(path);
    chosen.set(keyOf(run), run);
  }
  // The newest run of a path can be the evaluator's OWN in-progress run. Keep
  // that path's newest completed run too: "in progress" is not "never
  // completed", and a completed outcome is what an evaluator can judge.
  const seenCompletedPath = new Set();
  for (const run of atSha) {
    if (String(run?.status ?? '') !== 'completed') continue;
    const path = String(run?.path ?? '');
    if (seenCompletedPath.has(path)) continue;
    seenCompletedPath.add(path);
    chosen.set(keyOf(run), run);
  }
  for (const run of atSha.slice(0, MAX_RUNS_PER_SHA)) {
    if (!chosen.has(keyOf(run))) chosen.set(keyOf(run), run);
  }
  const kept = [...chosen.values()]
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  return { runs: kept, dropped: atSha.length - kept.length };
}

function compactRuns(runs, expectedSha) {
  return retainedRuns(runs, expectedSha).runs.map(compactRun);
}

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [], historicalE2EByPr = new Map(), linkedIssueE2E = [], implementationPulls = [], targetMergeProof = null, declaredMergeCommits = [], providerWakeEvidence = null, historicalAncestry = [], historicalOrchestratorRuns = [], historicalProviderChains = [], historicalRecovery = null, exactHeadE2eSteps = [], historicalReporterE2eRerun = null, verifiedHistoricalCaseReplays = [], verifiedCaseReceipts = [], relatedAcceptance = [], relatedBugCompletion = null, targetPushE2eRuns = [], postE2eWakeReceipts = [], replayDenials = [], storePolicyObservability = [], ancestryRuns = [], acceptanceBatchReceipts = [], selectedRunReceiptsBySha = new Map(), selectedRunReceipts = [], notRequiredRunReceiptsBySha = new Map(), notRequiredRunReceipts = [], fullGateProvisionReceipts = [], verifiedCiCostStudy = null, historicalBrowserDesignProof = null, exactHeadStepsBySha = new Map(), batchReceiptsBySha = new Map(), ancestryReceipts = [], reuseComparison = null }) {
  const sha = requireText(targetSha, 'targetSha');
  const associated = (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => pull?.head?.sha)
    .slice(0, MAX_ASSOCIATED_PULLS)
    .map((pull) => {
      const headSha = String(pull.head.sha);
      return {
        number: Number(pull.number),
        state: String(pull.state ?? ''),
        merged_at: pull.merged_at == null ? null : String(pull.merged_at),
        base_ref: pull.base?.ref == null ? null : String(pull.base.ref),
        head_ref: pull.head?.ref == null ? null : String(pull.head.ref),
        head_sha: headSha,
        html_url: String(pull.html_url ?? ''),
        runs: compactRuns(pullRunsBySha.get(headSha) ?? [], headSha),
        e2e_selected_run_receipts: selectedRunReceiptsBySha.get(headSha) ?? [],
        e2e_not_required_receipts: notRequiredRunReceiptsBySha.get(headSha) ?? [],
        // A merged target has no pull_request run of its own, so the PR head's
        // exact-head E2E contract steps and Case batch receipts are the only
        // reachable acceptance evidence for the merged code.
        exact_head_e2e_steps: exactHeadStepsBySha.get(headSha) ?? [],
        acceptance_batch_receipts: batchReceiptsBySha.get(headSha) ?? [],
        historical_e2e_runs: historicalE2EByPr.get(Number(pull.number)) ?? [],
      };
    });

  const directRunsAtSha = retainedRuns(directRuns, sha);
  return {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: sha,
    direct_runs: directRunsAtSha.runs.map(compactRun),
    direct_runs_dropped: directRunsAtSha.dropped,
    verified_metrics_replay_denials: replayDenials,
    store_policy_observability: storePolicyObservability,
    ancestry_runs: ancestryRuns,
    ancestry_receipts: ancestryReceipts,
    reuse_comparison_measurements: reuseComparison,
    acceptance_batch_receipts: acceptanceBatchReceipts,
    e2e_selected_run_receipts: selectedRunReceipts,
    e2e_not_required_receipts: notRequiredRunReceipts,
    e2e_full_gate_provision_receipts: fullGateProvisionReceipts,
    verified_ci_cost_study: verifiedCiCostStudy,
    historical_browser_design_regressions: historicalBrowserDesignProof,
    target_push_e2e_runs: targetPushE2eRuns,
    authenticated_post_e2e_wake_receipts: postE2eWakeReceipts,
    exact_head_e2e_steps: exactHeadE2eSteps,
    related_issue_acceptance_receipts: relatedAcceptance,
    related_bug_completion_evidence: relatedBugCompletion,
    verified_historical_case_replays: verifiedHistoricalCaseReplays,
    verified_case_receipts: verifiedCaseReceipts,
    historical_reporter_e2e_rerun: historicalReporterE2eRerun,
    pull_requests: associated,
    source_ancestry: sourceAncestry,
    target_merge_commit: targetMergeProof,
    declared_merge_commits: declaredMergeCommits,
    historical_merge_ancestry: historicalAncestry,
    historical_orchestrator_runs: historicalOrchestratorRuns,
    historical_provider_chains: historicalProviderChains,
    historical_metrics_recovery: historicalRecovery,
    linked_issue_e2e_evidence: linkedIssueE2E,
    implementation_pull_requests: implementationPulls,
    provider_wake_evidence: providerWakeEvidence,
  };
}

// Report only GitHub-authenticated exact-attempt job outcomes. A planner step
// can pass inside an overall failed run; this is NOT an E2E Pass receipt.
export function attestExactHeadE2eSteps(run, payload, sha, repo) {
  if (!/^[0-9a-f]{40}$/.test(sha) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      !Number.isSafeInteger(run?.id) || run.id<=0 ||
      !Number.isSafeInteger(run?.run_attempt) || run.run_attempt<=0 ||
      run.head_sha!==sha || run.repository?.full_name!==repo ||
      run.head_repository?.full_name!==repo ||
      run.name!=='E2E / Tests' || run.path!=='.github/workflows/e2e-tests.yml' ||
      run.event!=='pull_request' || run.status!=='completed' ||
      !['success','failure'].includes(run.conclusion))
    throw Error('unverified exact-head E2E workflow identity');
  if (!Array.isArray(payload?.jobs) || payload.jobs.length>100)
    throw Error('unverified exact-attempt job payload');
  const matched=payload.jobs.filter(j=>j?.name==='e2e');
  if(matched.length!==1)throw Error('missing/ambiguous canonical E2E job');
  const job=matched[0];
  if(!Number.isSafeInteger(job.id)||job.id<=0||job.run_id!==run.id||
     job.run_attempt!==run.run_attempt||job.head_sha!==sha||
     job.status!=='completed'||!Array.isArray(job.steps))
    throw Error('unverified exact-run/attempt E2E job');
  const steps=[];
  for(const name of E2E_STEP_NAMES) {
    const found=job.steps.filter(step=>step?.name===name);
    if(found.length>1)throw Error('duplicate E2E step');
    const step=found[0];
    if(step?.status==='completed' &&
       ['success','failure','skipped','cancelled','timed_out'].includes(step.conclusion))
      steps.push({name,status:'completed',conclusion:step.conclusion});
  }
  return {run_id:run.id,run_attempt:run.run_attempt,head_sha:sha,job_id:job.id,
    workflow_conclusion:run.conclusion,steps,
    provenance:'GitHub exact-SHA same-repository PR E2E Run + exact-attempt job steps'};
}

export async function collectExactHeadE2eSteps(repo,sha,runs,request=githubGet) {
  const selected=(Array.isArray(runs)?runs:[]).filter(run=>
    run?.name==='E2E / Tests'&&run.path==='.github/workflows/e2e-tests.yml'&&
    run.event==='pull_request'&&run.head_sha===sha&&run.status==='completed'&&
    ['success','failure'].includes(run.conclusion)&&
    run.repository?.full_name===repo&&run.head_repository?.full_name===repo)
    .sort((a,b)=>b.id-a.id).slice(0,MAX_EXACT_E2E_STEP_RUNS);
  const proof=[];
  for(const run of selected) {
    const payload=await request('/repos/'+repo+'/actions/runs/'+run.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    proof.push(attestExactHeadE2eSteps(run,payload,sha,repo));
  }
  return proof;
}

// Bounded, trusted-main exact-target collection. An off-main SOURCE SHA is
// expected for a denied replay and can never become an authorized writer.
// Reauthenticate recipient/attempt, original authorization log, upstream
// source identity and all five job outcomes independently through GitHub.
export async function collectAuthenticatedReplayDenials(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||
     !Array.isArray(runs))throw Error('invalid replay denial discovery scope');
  const candidates=runs.filter(r=>r?.name==='Metrics / Repository Health'&&
    r.path==='.github/workflows/metrics-repository.yml'&&
    r.event==='workflow_run'&&r.head_sha===sha&&
    r.head_branch==='main'&&r.status==='completed'&&r.conclusion==='failure')
    .sort((a,b)=>b.id-a.id).slice(0,12);
  const evidence=[];
  for(const candidate of candidates){
    const recipient=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(recipient?.id!==candidate.id||recipient.head_sha!==sha||
       !Number.isSafeInteger(recipient.run_attempt)||recipient.run_attempt<1)
      throw Error('unverified replay denial recipient selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+recipient.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified replay denial recipient jobs');
    const matches=jobs.jobs.filter(j=>j.name==='authorize-replay');
    if(matches.length!==1||matches[0].conclusion!=='failure')continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs');}
    catch{continue;} // Missing/expired log cannot be counted as evidence.
    const receipt=parseReplayDenialLog(log);
    if(!receipt)continue; // Older pre-receipt runs are not proof.
    const source=await request('/repos/'+repo+'/actions/runs/'+receipt.source_claim.run_id);
    const workflow=await request('/repos/'+repo+'/actions/workflows/'+source.workflow_id);
    evidence.push(attestReplayDenial(receipt,source,recipient,jobs,workflow));
  }
  return evidence;
}

// Store / Governance Audit fails closed whenever it cannot verify the live
// Ruleset policy. compactRun exposes only run metadata and the harness never
// reads workflow artifacts, so a failed run was the ONLY thing an evaluator
// could see about it and "this read-only credential cannot observe the
// capability" was indistinguishable from "the policy is absent". Re-read the
// observability receipt from the trusted observe job's own log, the same
// bounded way the replay denial above is attested. The receipt can only ever
// support Pending — never Pass.
export async function collectStorePolicyObservability(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||
     !Array.isArray(runs))throw Error('invalid store policy observability scope');
  const candidates=runs.filter(r=>r?.name===POLICY_WORKFLOW_NAME&&
    String(r.path??'').replace(/@refs\/heads\/[^\s]+$/,'')===POLICY_WORKFLOW&&
    POLICY_TRIGGER_EVENTS.includes(r.event)&&r.head_sha===sha&&r.head_branch==='main'&&
    r.status==='completed'&&r.conclusion==='failure')
    .sort((a,b)=>b.id-a.id).slice(0,4);
  const evidence=[];
  for(const candidate of candidates){
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run?.id!==candidate.id||run.head_sha!==sha||run.conclusion!=='failure'||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)
      throw Error('unverified store policy observability recipient selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified store policy observability recipient jobs');
    const matches=jobs.jobs.filter(j=>j.name===POLICY_OBSERVE_JOB);
    if(matches.length!==1||matches[0].conclusion!=='failure')continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs');}
    catch{continue;} // Missing/expired log cannot be counted as evidence.
    const receipt=parsePolicyObservabilityLog(log);
    if(!receipt)continue; // Runs predating the receipt are not proof of anything.
    evidence.push(attestPolicyObservability(receipt,run,matches[0]));
  }
  return evidence;
}

// #1866 SC-02: the selected PR E2E job measures its own full-stack provisions
// and writes the count into the job log, because the harness never reads the
// assertion artifact. Untrusted target output until this collector rebinds it
// to the exact Run/Attempt/SHA and to the completed `Run E2E tests` step.
const MAX_SELECTED_RUN_RECEIPTS=2, SELECTED_RUN_LOG_BYTES=4194304;
export async function collectSelectedE2eRunReceipts(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(runs))
    throw Error('invalid selected E2E run receipt scope');
  const candidates=runs.filter(run=>run?.name===E2E_SELECTED_WORKFLOW_NAME&&
    String(run.path??'').replace(/@refs\/[^\s]+$/,'')===E2E_SELECTED_WORKFLOW&&
    E2E_SELECTED_EVENTS.includes(run.event)&&run.head_sha===sha&&
    run.status==='completed'&&run.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,MAX_SELECTED_RUN_RECEIPTS);
  const evidence=[];
  for(const candidate of candidates){
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run?.id!==candidate.id||run.head_sha!==sha||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
       run.conclusion!=='success')
      throw Error('unverified selected E2E run receipt selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified selected E2E run receipt jobs');
    const matches=jobs.jobs.filter(job=>job?.name===E2E_SELECTED_JOB);
    if(matches.length!==1)continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs',
      SELECTED_RUN_LOG_BYTES);}
    catch{continue;} // Missing/expired log cannot be counted as evidence.
    let receipt;
    // The producer is target code: malformed framing is ignored, never fatal.
    try{receipt=parseE2eSelectedRunLog(log);}catch{continue;}
    if(!receipt)continue; // Runs that measured nothing prove nothing.
    evidence.push(attestE2eSelectedRunReceipt(receipt,run,matches[0]));
  }
  return evidence;
}

// #1866 SC-01: an explicit `not-required` plan must skip the E2E-only Rust
// build/full-stack preparation while the required design gate still executes.
// The receipt carries GitHub's own resolved step outcomes; attestation
// re-reads the same step conclusions from the job API.
export async function collectNotRequiredE2eReceipts(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(runs))
    throw Error('invalid not-required E2E receipt scope');
  const candidates=runs.filter(run=>run?.name===E2E_SELECTED_WORKFLOW_NAME&&
    String(run.path??'').replace(/@refs\/[^\s]+$/,'')===E2E_SELECTED_WORKFLOW&&
    E2E_SELECTED_EVENTS.includes(run.event)&&run.head_sha===sha&&
    run.status==='completed'&&run.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,MAX_SELECTED_RUN_RECEIPTS);
  const evidence=[];
  for(const candidate of candidates){
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run?.id!==candidate.id||run.head_sha!==sha||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
       run.conclusion!=='success')
      throw Error('unverified not-required E2E receipt selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified not-required E2E receipt jobs');
    const matches=jobs.jobs.filter(job=>job?.name===E2E_SELECTED_JOB);
    if(matches.length!==1)continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs',
      SELECTED_RUN_LOG_BYTES);}
    catch{continue;}
    let receipt;
    try{receipt=parseE2eNotRequiredLog(log);}catch{continue;}
    if(!receipt)continue;
    evidence.push(attestE2eNotRequiredReceipt(receipt,run,matches[0]));
  }
  return evidence;
}

// #1866 SC-03: the Full E2E Gate measures exactly one full-stack provision and
// verifies the retained selector/canary assurance, but discards its output on
// success. Re-read the measured receipt from the push job's own log.
export async function collectFullGateProvisionReceipts(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(runs))
    throw Error('invalid full Gate provision receipt scope');
  const candidates=runs.filter(run=>run?.name===E2E_SELECTED_WORKFLOW_NAME&&
    String(run.path??'').replace(/@refs\/[^\s]+$/,'')===E2E_SELECTED_WORKFLOW&&
    run.event==='push'&&run.head_sha===sha&&run.status==='completed'&&
    run.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,MAX_SELECTED_RUN_RECEIPTS);
  const evidence=[];
  for(const candidate of candidates){
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run?.id!==candidate.id||run.head_sha!==sha||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
       run.conclusion!=='success')
      throw Error('unverified full Gate provision receipt selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified full Gate provision receipt jobs');
    const matches=jobs.jobs.filter(job=>job?.name===E2E_SELECTED_JOB);
    if(matches.length!==1)continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs',
      SELECTED_RUN_LOG_BYTES);}
    catch{continue;}
    let receipt;
    try{receipt=parseE2eFullGateLog(log);}catch{continue;}
    if(!receipt)continue;
    let attested=attestE2eFullGateReceipt(receipt,run,matches[0]);
    // #1876: this per-file proof is emitted only after a real push Full E2E
    // run. Bind the producer's bounded counters to GitHub's independently
    // read Run/Attempt/SHA, and the exact successful verifier job step.
    // Older runs legitimately have no receipt; never invent a Pass for them.
    const prefix='E2E_FULL_PER_ID_V1 ';
    const rows=log.split(/\r?\n/).filter(line=>line.includes(prefix));
    if(rows.length>1)throw Error('duplicate Full E2E per-ID proof in source job');
    if(rows.length===1){
      const raw=rows[0].slice(rows[0].indexOf(prefix)+prefix.length).trim();
      const perId=JSON.parse(raw);
      attested={...attested,full_per_id:attestFullReceipt(perId,run,matches[0])};
    }
    evidence.push(attested);
  }
  return evidence;
}

// #1866 SC-01/SC-02: a merged target carries only ONE pull_request, so a
// `not-required` PR and a `selected` PR can never be associated with the same
// merge SHA. Both proofs are still reachable: the Issue names exact ancestor
// SHAs, git proves each is an ancestor of the target, and the same
// authenticated collectors re-read each ancestor's own job logs and history.
const ANCESTRY_RECEIPT_TARGETS=8;
export async function collectAncestryReceipts(repo,sourceAncestry,targetSha,
  runsForSha=workflowRunsForSha,request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(targetSha)||
     !Array.isArray(sourceAncestry))throw Error('invalid ancestry receipt scope');
  const evidence=[];
  for(const entry of sourceAncestry.slice(0,ANCESTRY_RECEIPT_TARGETS)){
    if(entry?.is_ancestor!==true||entry.ancestor_sha===targetSha)continue;
    const sha=entry.ancestor_sha;
    if(!/^[a-f0-9]{40}$/.test(sha??''))continue;
    const runs=await runsForSha(repo,sha);
    if(!Array.isArray(runs))throw Error('invalid ancestry receipt runs');
    // Per-ID assertion history for the PR whose head is this ancestor.
    const pulls=await request('/repos/'+repo+'/commits/'+sha+'/pulls?per_page=10');
    const pull=(Array.isArray(pulls)?pulls:[]).find(p=>p?.head?.sha===sha);
    const historical=pull?await collectHistoricalE2EForPull(repo,pull,request):[];
    evidence.push({
      sha,
      historical_e2e_runs:historical,
      e2e_not_required_receipts:await collectNotRequiredE2eReceipts(repo,sha,runs,request,getText),
      e2e_selected_run_receipts:await collectSelectedE2eRunReceipts(repo,sha,runs,request,getText),
      acceptance_batch_receipts:await collectAcceptanceBatchReceipts(repo,sha,runs,request,getText),
    });
  }
  return evidence;
}

// #1866 SC-08: an equivalent-scope comparison from the receipts themselves.
// The per-case path is the default strategy (one owned runtime per Case); the
// measured path is the job-scoped batch at the same SHA. Both counts come from
// the same GitHub-attested receipt, so the comparison cannot be inflated by
// mixing scopes.
export function computeReuseComparison({targetSha,acceptanceBatchReceipts=[],
  extraBatchReceipts=[],fullGateProvisionReceipts=[],selectedRunReceipts=[],
  extraSelectedRunReceipts=[],targetPushE2eRuns=[]}){
  if(!/^[a-f0-9]{40}$/.test(targetSha))throw Error('invalid reuse comparison target');
  const full=fullGateProvisionReceipts[0]??null;
  // The target of a merged evaluation has no pull_request run of its own, so
  // fall back to the associated PR head's authenticated selected-run receipt.
  const selected=selectedRunReceipts[0]??extraSelectedRunReceipts[0]??null;
  // Batch receipts from associated PR heads are included so a shared-runtime
  // decision is comparable even on a merge SHA whose own Cases are isolated.
  const seen=new Set();
  const batches=[...acceptanceBatchReceipts,...extraBatchReceipts].filter(batch=>{
    const key=batch?.run_id+':'+batch?.sha;
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
  const comparisons=batches.map(batch=>{
    const cases=Array.isArray(batch.cases)?batch.cases:[];
    const isolated=cases.filter(item=>item.isolation==='isolated').length;
    const measured=(batch.shared_ready_runtimes??0)+isolated;
    return {
      source_run_id:batch.run_id??null,
      sha:batch.sha??null,
      executed_cases:cases.length,
      baseline_case_owned_runtimes:cases.length,
      measured_runtimes:measured,
      runtimes_saved:Math.max(0,cases.length-measured),
      shared_cases:cases.filter(item=>item.isolation==='shared').length,
      fallback_cases:isolated,
    };
  });
  if(comparisons.length===0&&!full&&!selected)return null;
  return {
    kind:'authenticated_reuse_comparison',
    target_sha:targetSha,
    baseline_path:'per-case default (one owned runtime per Case)',
    measured_path:'job-scoped batch',
    comparisons,
    full_gate_provisions:full?.provisions??null,
    selected_run:selected?{
      selected_ids:selected.selected_ids,
      selected_count:selected.selected_count,
      provisioned_runtimes:selected.provisioned_runtimes,
    }:null,
    main_push_full_e2e_success:targetPushE2eRuns.some(run=>
      run.status==='completed'&&run.conclusion==='success'),
    provenance:'computed by the trusted collector from GitHub-attested receipts at the exact target SHA',
  };
}

async function githubJobLog(path,maxBytes=1048576){
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)throw Error('historical Case read requires GitHub token');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('GitHub historical Case logs HTTP '+response.status);
  const body=await response.text();
  if(body.length>=maxBytes)throw Error('historical Case log too large');
  return body;
}

// #1866 SC-04: the batch decision is written into the job log by the batch CLI,
// because artifacts never reach an evaluator. The producer runs as target code,
// so the receipt is untrusted until this collector re-reads the completed
// canonical workflow's own job log and binds it to the exact Run/Attempt/SHA.
// Only `push` (Acceptance / Cases) and `pull_request` (Acceptance / Case Smoke)
// runs of the canonical workflows at the exact target SHA are candidates.
const MAX_ACCEPTANCE_BATCH_RUNS=4, ACCEPTANCE_BATCH_LOG_BYTES=8388608;
function canonicalBatchWorkflow(run){
  const workflowPath=String(run?.path??'').replace(/@refs\/[^\s]+$/,'');
  return ACCEPTANCE_BATCH_WORKFLOWS.find(entry=>entry.workflow===workflowPath&&
    entry.name===run?.name)??null;
}
export async function collectAcceptanceBatchReceipts(repo,sha,runs,
  request=githubGet,getText=githubJobLog){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(runs))
    throw Error('invalid Acceptance Case batch receipt scope');
  const candidates=runs.filter(run=>{
    const workflow=canonicalBatchWorkflow(run);
    return workflow!==null&&workflow.events.includes(run?.event)&&
      run.head_sha===sha&&run.status==='completed'&&
      ['success','failure'].includes(run.conclusion);
  }).sort((a,b)=>b.id-a.id).slice(0,MAX_ACCEPTANCE_BATCH_RUNS);
  const evidence=[];
  for(const candidate of candidates){
    const workflow=canonicalBatchWorkflow(candidate);
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run?.id!==candidate.id||run.head_sha!==sha||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||
       !['success','failure'].includes(run.conclusion))
      throw Error('unverified Acceptance Case batch receipt selection');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+candidate.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      throw Error('unverified Acceptance Case batch receipt jobs');
    const matches=jobs.jobs.filter(job=>job?.name===workflow.job);
    if(matches.length!==1)continue;
    let log;
    try{log=await getText('/repos/'+repo+'/actions/jobs/'+matches[0].id+'/logs',
      ACCEPTANCE_BATCH_LOG_BYTES);}
    catch{continue;} // Missing/expired log cannot be counted as evidence.
    let receipt;
    // The producer is target code: malformed framing is ignored, never fatal.
    try{receipt=parseAcceptanceBatchLog(log);}catch{continue;}
    if(!receipt)continue; // Runs that did not execute a batch prove nothing.
    evidence.push(attestAcceptanceBatchReceipt(receipt,run,matches[0]));
  }
  return evidence;
}

// Global /actions/runs?head_sha is noisy on main (Orchestrator/Waker), and
// compactRuns retains only twenty latest items. Collect canonical push E2E
// independently from its exact workflow route; never promote PR-head gates
// or overall failed runs to a merge-SHA E2E success.
export function attestTargetPushE2eRuns(payload,sha,repo) {
  if(!/^[a-f0-9]{40}$/.test(sha) || repo!=='BestNathan/nession' ||
      !Array.isArray(payload?.workflow_runs) ||
      payload.workflow_runs.length>MAX_TARGET_PUSH_E2E_RUNS)
    throw Error('invalid scoped target-push E2E payload');
  const proof=[];
  const seen=new Set();
  for(const run of payload.workflow_runs) {
    if(!Number.isSafeInteger(run?.id)||run.id<=0||seen.has(run.id)||
       !Number.isSafeInteger(run.run_attempt)||run.run_attempt<=0||
       run.name!=='E2E / Tests'||
       !['.github/workflows/e2e-tests.yml',
         '.github/workflows/e2e-tests.yml@refs/heads/main'].includes(run.path)||
       run.head_sha!==sha||run.head_branch!=='main'||run.event!=='push'||
       run.repository?.full_name!==repo||
       run.head_repository?.full_name!==repo||
       !['queued','in_progress','completed'].includes(run.status)||
       (run.status==='completed'
         ? !['success','failure','cancelled','timed_out'].includes(run.conclusion)
         : run.conclusion!==null))
      throw Error('unverified target-push E2E workflow identity');
    seen.add(run.id);
    proof.push({...compactRun(run),run_attempt:run.run_attempt,
      provenance:'GitHub scoped canonical main-push E2E workflow run, same-repo exact SHA and status'});
  }
  return proof;
}

export async function collectTargetPushE2eRuns(repo,sha,request=githubGet) {
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(sha))
    throw Error('invalid scoped main-push E2E request');
  const q=new URLSearchParams({head_sha:sha,event:'push',
    per_page:String(MAX_TARGET_PUSH_E2E_RUNS)});
  const payload=await request('/repos/'+repo+
    '/actions/workflows/e2e-tests.yml/runs?'+q.toString());
  return attestTargetPushE2eRuns(payload,sha,repo);
}

async function githubGet(path) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN/GH_TOKEN is required');
  const response = await fetch('https://api.github.com' + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-acceptance-ci-evidence',
    },
  });
  if (!response.ok) {
    throw new Error('GitHub API ' + response.status + ' for ' + path + ': ' + await response.text());
  }
  return response.json();
}

// A completed Provider source may be older than MAX_RUNS_PER_SHA and get
// dropped from ordinary direct_runs. The main-only Provider dispatch already
// supplies its exact locator; verify GitHub Run + persisted Metrics again here,
// rather than widening an unbounded workflow-run listing or trusting prose.
export function verifyPinnedProviderEvidence(targetSha,sourceId,attempt,run,metricsRoot){
  if(!/^[a-f0-9]{40}$/.test(targetSha)||
     !/^[1-9][0-9]*$/.test(String(sourceId))||
     !/^[1-9][0-9]*$/.test(String(attempt))||
     !Number.isSafeInteger(Number(sourceId))||
     !Number.isSafeInteger(Number(attempt))||
     !path.isAbsolute(metricsRoot))
    throw Error('invalid pinned Provider evidence identity');
  const source_run_id=Number(sourceId),source_run_attempt=Number(attempt);
  const verified=verifyWake({source_run_id,source_run_attempt,target_sha:targetSha},run,metricsRoot);
  return {kind:'verified_main_provider_wake',schema_version:1,
    source_run_id,source_run_attempt,target_sha:targetSha,
    source_url:'https://github.com/BestNathan/nession/actions/runs/'+source_run_id,
    durable_metrics_matches:verified.matches,workflow_path:run.path,
    source_event:run.event,source_status:run.status,source_conclusion:run.conclusion,
    head_branch:run.head_branch,
    provenance:'GitHub Provider Smoke Run + read-only authenticated Metrics orphan records'};
}
async function collectPinnedProviderEvidence(repo,sha){
  const id=String(process.env.PROVIDER_SOURCE_RUN_ID??'').trim();
  const attempt=String(process.env.PROVIDER_SOURCE_RUN_ATTEMPT??'').trim();
  if(!id&&!attempt)return null;
  if(process.env.ACCEPTANCE_STAGE!=='post-merge'||!id||!attempt)
    throw Error('pinned Provider wake is only valid for complete post-merge identity');
  const run=await githubGet('/repos/'+repo+'/actions/runs/'+encodeURIComponent(id));
  const workspace=requireText(process.env.GITHUB_WORKSPACE,'GITHUB_WORKSPACE');
  const metricsRoot=path.join(workspace,'provider-metrics');
  return verifyPinnedProviderEvidence(sha,id,attempt,run,metricsRoot);
}

// #1749 SC-05: a busy main SHA can exceed one listing page. A scheduled
// Metrics run, its ingest/wake children and replay dispatches push the SHA past
// 100 runs, and the oldest runs — the push Gate and Provider Smoke — fall off
// page 1. They exist but become unreachable, which read as "never ran".
const MAX_RUN_PAGES = 3;
export async function workflowRunsForSha(repo, sha, get = githubGet) {
  const runs = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const query = new URLSearchParams({
      head_sha: sha, per_page: '100', page: String(page),
    });
    const payload = await get('/repos/' + repo + '/actions/runs?' + query.toString());
    const pageRuns = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  if (runs.length > MAX_RUN_PAGES * 100)
    throw Error('excessive workflow run listing for exact SHA');
  return runs;
}

// Exact-head runs for Git-verified ancestor SHAs named by the criterion.
//
// `pulls` comes from /commits/{targetSha}/pulls, so it only ever returns PRs
// containing the TARGET commit. An Issue that correctly names its original
// delivery SHA therefore could never be evidenced at a later post-merge target:
// direct_runs are pinned to the target, and the original exact-head runs were
// unreachable — the same "evidence exists but cannot be reached" defect as the
// report artifact and the receipt channel. Every SHA here is already proven an
// ancestor of the trusted target by git, and every run is re-read from GitHub
// with head_sha pinned to that ancestor.
const ANCESTRY_RUNS_PER_SHA=12, ANCESTRY_RUNS_TOTAL=48;
export async function collectAncestryRuns(repo,sourceAncestry,targetSha,
  runsForSha=workflowRunsForSha){
  if(repo!=='BestNathan/nession'||!/^[a-f0-9]{40}$/.test(targetSha)||
     !Array.isArray(sourceAncestry))throw Error('invalid ancestry run scope');
  const evidence=[];
  for(const entry of sourceAncestry.slice(0,8)){
    if(entry?.is_ancestor!==true||!/^[a-f0-9]{40}$/.test(entry?.ancestor_sha??'')||
       entry.ancestor_sha===targetSha)continue;
    if(evidence.length>=ANCESTRY_RUNS_TOTAL)break;
    const runs=await runsForSha(repo,entry.ancestor_sha);
    if(!Array.isArray(runs))throw Error('invalid ancestry run response');
    // Newest per ancestor, bounded: this reaches an evaluator's context, so it
    // must never scale with an ancestor's whole run history.
    const newest=[...runs].sort((a,b)=>Number(b?.id??0)-Number(a?.id??0))
      .slice(0,ANCESTRY_RUNS_PER_SHA);
    for(const run of newest){
      if(evidence.length>=ANCESTRY_RUNS_TOTAL)break;
      // Identity is re-bound here, never trusted from the ancestor list.
      if(run?.head_sha!==entry.ancestor_sha||
         run?.head_repository?.full_name!==repo||
         run?.repository?.full_name!==repo||run?.status!=='completed'||
         !Number.isSafeInteger(Number(run?.run_attempt))||Number(run.run_attempt)<1)continue;
      evidence.push({ancestor_sha:entry.ancestor_sha,...compactRun(run),
        run_attempt:Number(run.run_attempt)});
    }
  }
  return evidence;
}

// Exact ancestor SHAs may be declared only in the Issue Success Criteria.
// Never scan mutable report text, chat comments or PR descriptions for proof targets.
export function requestedAncestorsFromIssue(body) {
  const section = String(body || '').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Report|$)/)?.[1] || '';
  const hashes = [];
  for (const line of section.split('\n')) {
    if (!/^- \[[ x]\] SC-\d+\b/i.test(line) || !/\bancestors?\b/i.test(line)) continue;
    for (const match of line.matchAll(/\b[0-9a-f]{40}\b/g)) hashes.push(match[0]);
  }
  const unique = [...new Set(hashes)];
  if (unique.length > 8) throw new Error('excessive ancestor proof targets in Issue criteria');
  return unique;
}

// The Issue's Success Criteria can pin prior source runs for discovery only.
// All identity and completion claims are verified directly through GitHub.
export function pinnedHistoricalOrchestratorIds(body) {
  const section=String(body??'').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Report|$)/)?.[1]??'';
  const ids=[];
  for(const line of section.split('\n')) {
    if(!/^- \[[ x]\] SC-\d+\b/.test(line))continue;
    for(const m of line.matchAll(/\bOrchestrator Run\s+\x60?([1-9]\d*)\x60?(?=\s|[.,;]|$)/g)){
      const id=Number(m[1]);
      if(!Number.isSafeInteger(id))throw Error('invalid historical Run ID');
      ids.push(id);
    }
  }
  const unique=[...new Set(ids)];
  if(unique.length>8)throw Error('excessive historical Run scope');
  return unique;
}
export function attestHistoricalOrchestrator(run,sha,runId,repo) {
  if(!/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(runId) || runId<=0 ||
     run?.id!==runId || run?.repository?.full_name!==repo ||
     run?.head_repository?.full_name!==repo ||
     run?.name!=='Acceptance / Orchestrator' ||
     run?.path!=='.github/workflows/acceptance-orchestrator.yml' ||
     run?.event!=='push' || run?.head_branch!=='main' ||
     run?.head_sha!==sha || run?.status!=='completed' ||
     run?.conclusion!=='success' || !Number.isSafeInteger(run?.run_attempt) ||
     run.run_attempt<=0)
    throw Error('invalid historical completed Orchestrator provenance');
  return {...compactRun(run),run_attempt:run.run_attempt,
    provenance:'GitHub exact-run completed same-repo main push Orchestrator'};
}

// Historical Issue criteria merely nominate exact GitHub Runs for discovery.
// This must never be construed as an Issue-supplied success assertion.
export function pinnedHistoricalProviderChains(body) {
  const section=String(body??'').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Report|$)/)?.[1]??'';
  const chains=[];
  for(const line of section.split('\n')){
    if(!/^- \[[ x]\] SC-\d+\b/.test(line)||
       !line.includes('Historical evidence discovery constraint'))continue;
    const p=line.match(/\bSource Provider Run\s+`?([1-9]\d*)`?/);
    const m=line.match(/\bMetrics Ingest Run\s+`?([1-9]\d*)`?/);
    const a=line.match(/\bOrchestrator Run\s+`?([1-9]\d*)`?\s+attempt\s+([1-9]\d*)/);
    const issue=line.match(/\bin a real main run,\s+#([1-9]\d*)\s+SC-/);
    if(!p||!m||!a||!issue)throw Error('incomplete historical dependency Run pins');
    const ids=[p[1],m[1],a[1],a[2],issue[1]].map(Number);
    if(ids.some(n=>!Number.isSafeInteger(n)||n<=0)||
       new Set(ids.slice(0,3)).size!==3)throw Error('invalid historical dependency Run pins');
    chains.push({provider_run_id:ids[0],metrics_run_id:ids[1],
      orchestrator_run_id:ids[2],orchestrator_attempt:ids[3],
      issue_number:ids[4]});
  }
  if(chains.length>2)throw Error('excessive historical dependency Run chains');
  return chains;
}

function attestSourceRun(run,id,sha,repo,name,workflow,event) {
  if(run?.id!==id||run?.repository?.full_name!==repo||
     run?.head_repository?.full_name!==repo||
     run?.name!==name||run?.path!==workflow||run?.event!==event||
     run?.head_sha!==sha||run?.head_branch!=='main'||
     run?.status!=='completed'||run?.conclusion!=='success'||
     !Number.isSafeInteger(run?.run_attempt)||run.run_attempt<=0)
    throw Error('invalid historical dependency source Run provenance');
  return {...compactRun(run),run_attempt:run.run_attempt};
}

function verifiedTimestamp(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value))
    throw Error('missing historical dependency '+label);
  const n=Date.parse(value);
  if(!Number.isFinite(n))throw Error('invalid historical dependency '+label);
  return n;
}

// Prove original main merge ancestry separately from source Run identity,
// retry attempt, sequence timing and the actual Issue-scoped execution jobs.
// No historical metadata can change an Issue or publish a new SC result.
export function attestHistoricalProviderChain(pins,provider,metrics,orchestrator,
  response,verifiedMergeShas,repo='BestNathan/nession'){
  const sha=orchestrator?.head_sha;
  if(!/^[a-f0-9]{40}$/.test(sha??'')||
     !(verifiedMergeShas instanceof Set)||!verifiedMergeShas.has(sha))
    throw Error('historical dependency merge SHA not Git-verified');
  const p=attestSourceRun(provider,pins.provider_run_id,sha,repo,
    'Agent / Provider Smoke','.github/workflows/agent-provider-smoke.yml','push');
  const m=attestSourceRun(metrics,pins.metrics_run_id,sha,repo,
    'Metrics / Agent Telemetry Ingest','.github/workflows/metrics-agent-telemetry.yml','workflow_run');
  const a=attestHistoricalOrchestrator(orchestrator,sha,pins.orchestrator_run_id,repo);
  if(a.run_attempt!==pins.orchestrator_attempt)throw Error('historical orchestrator attempt mismatch');
  const pEnd=verifiedTimestamp(provider.updated_at,'Provider completion');
  const mStart=verifiedTimestamp(metrics.run_started_at,'Metrics start');
  const mEnd=verifiedTimestamp(metrics.updated_at,'Metrics completion');
  const aStart=verifiedTimestamp(orchestrator.run_started_at,'Acceptance retry start');
  if(!(pEnd<=mStart&&mStart<=mEnd&&mEnd<=aStart))
    throw Error('historical Provider/Metrics/Acceptance execution order mismatch');
  if(!Array.isArray(response?.jobs)||response.jobs.length>100)
    throw Error('historical Acceptance job collection missing/oversized');
  const expected=[
    'merged-agent-acceptance ('+pins.issue_number+') / Execute acceptance',
    'merged-agent-acceptance ('+pins.issue_number+') / Deterministic Issue updater',
  ];
  const selected=expected.map(name=>{
    const matches=response.jobs.filter(j=>j.name===name);
    if(matches.length!==1||matches[0].status!=='completed'||
       matches[0].conclusion!=='success'||
       !(verifiedTimestamp(matches[0].started_at,'Acceptance job start')>=aStart))
      throw Error('historical Issue-scoped Acceptance job not verified: '+name);
    return {id:matches[0].id,name,status:matches[0].status,
      conclusion:matches[0].conclusion,started_at:matches[0].started_at};
  });
  return {kind:'verified_historical_provider_metrics_acceptance',
    source:'independent GitHub Run + attempt-2 scoped jobs + verified Git merge ancestry',
    target_sha:sha,issue_number:pins.issue_number,provider:p,metrics:m,
    orchestrator:a,accepted_jobs:selected,verified_order:true,
    evidence_limit:'Run metadata and job success; do not equate this with independent Metrics record-byte attestation'};
}

// Read-only, fail-closed Git object proof. A detached checkout is valid;
// only the actual merge-base exit status and exact input SHA establish ancestry.
export function checkGitAncestor(workspace, targetSha, requiredSha, runner = spawnSync) {
  if (!/^[0-9a-f]{40}$/.test(targetSha) || !/^[0-9a-f]{40}$/.test(requiredSha))
    throw new Error('ancestry proof requires exact 40-character SHAs');
  const result = runner('git', ['-C', workspace, 'merge-base', '--is-ancestor', requiredSha, targetSha], {
    encoding: 'utf8',
  });
  return {
    target_sha: targetSha, ancestor_sha: requiredSha, verified_by: 'git merge-base --is-ancestor',
    is_ancestor: !result.error && result.status === 0,
    status: result.error ? 'error' : result.status === 0 ? 'verified' :
      result.status === 1 ? 'not-ancestor' : 'unknown-object-or-error',
  };
}
// Independently attest ordinary Git merge identity from the fetched trusted
// checkout. GitHub PR metadata and success labels alone do not prove parents.
// Input SHAs from Issue criteria are discovery constraints, never proof.
export function checkGitMergeCommit(workspace,targetSha,expectedHeads=[],runner=spawnSync) {
  if(!/^[a-f0-9]{40}$/.test(targetSha) ||
     !Array.isArray(expectedHeads) || expectedHeads.length>8 ||
     !expectedHeads.every(x=>/^[a-f0-9]{40}$/.test(x)))
    throw new Error('merge parent proof requires exact 40-character SHAs');
  const command=['-C',workspace,'rev-list','--parents','-n','1',targetSha];
  const result=runner('git',command,{encoding:'utf8'});
  const parts=typeof result.stdout==='string'?
    result.stdout.trim().split(/\s+/):[];
  const valid=!result.error && result.status===0 &&
    parts[0]===targetSha && parts.length>=2 &&
    parts.every(x=>/^[a-f0-9]{40}$/.test(x));
  const parents=valid?parts.slice(1):[];
  const isOrdinaryMerge=valid && parents.length===2;
  return {target_sha:targetSha,verified_by:'git rev-list --parents -n 1',
    status:valid?'verified':'unknown-object-or-error',
    parents,is_ordinary_merge:isOrdinaryMerge,
    second_parent_sha:isOrdinaryMerge?parents[1]:null,
    second_parent_matches_declared_source:isOrdinaryMerge&&
      expectedHeads.includes(parents[1])};
}

async function collectSourceAncestry(repo, workspace, targetSha) {
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (!/^\d+$/.test(issueNumber)) return [];
  const issue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
  const wanted = requestedAncestorsFromIssue(issue.body);
  return wanted.map((sha) => checkGitAncestor(workspace, targetSha, sha));
}

// Optional bounded discovery of *historical implementation* PR gates for
// a requirement that explicitly asks for them in its Success Criteria.
// Mutable Issue/PR prose only enables discovery. GitHub cross-reference,
// merged same-repo PR, exact paths, ancestry and source SHA independently
// establish whether the check bundle is relevant.
export function issueRequestsImplementationGates(issue) {
  const b=String(issue?.body??'');
  const success=b.match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Plan|\n## Acceptance Report|$)/)?.[1]??'';
  return /## E2E Verification\s*$/m.test(b) &&
    success.split('\n').some(line=>/^- \[[x ]\] SC-\d+\b/i.test(line) &&
      /\bimplementation PR\b/i.test(line));
}
export function selectCrossReferencedImplementationPulls(issueNumber,events) {
  if(!Number.isSafeInteger(issueNumber)||issueNumber<=0||!Array.isArray(events))
    throw Error('invalid implementation discovery input');
  const repo='BestNathan/nession',found=new Set();
  for(const event of events){
    const source=event?.source?.issue;
    const n=source?.number;
    if(event?.event==='cross-referenced'&&Number.isSafeInteger(n)&&n>0&&
       source?.pull_request?.url==='https://api.github.com/repos/'+repo+'/pulls/'+n)
      found.add(n);
  }
  if(found.size>MAX_CROSS_REFERENCED_PULLS)
    throw Error('excessive implementation PR discovery scope');
  return [...found].sort((a,b)=>a-b);
}
export function eligibleImplementationPull(pull,files,issueNumber) {
  const repo='BestNathan/nession';
  if(!Number.isSafeInteger(issueNumber)||issueNumber<=0||
     pull?.state!=='closed'||!pull.merged_at||
     pull?.base?.ref!=='main'||pull.base.repo?.full_name!==repo||
     pull?.head?.repo?.full_name!==repo||
     !/^[a-f0-9]{40}$/.test(pull?.head?.sha??'')||
     !/^[a-f0-9]{40}$/.test(pull?.merge_commit_sha??'')||
     !Array.isArray(files)||files.length>100)return false;
  const refs=new Set();
  for(const line of String(pull.body??'').split(/\r?\n/)){
    const match=line.match(/^\s*Refs?\s*:?\s*(.*)$/i);
    if(match)for(const m of match[1].matchAll(/#([1-9]\d*)\b/g))
      refs.add(Number(m[1]));
  }
  const paths=new Set(files.map(f=>f?.filename));
  return refs.has(issueNumber) &&
    IMPLEMENTATION_OWNER_PATHS.every(p=>paths.has(p));
}
export function exactImplementationGateBundle(runs,headSha,jobResults=[]) {
  if(!/^[a-f0-9]{40}$/.test(headSha)||!Array.isArray(runs))
    throw Error('invalid implementation source head SHA');
  const checks=REQUIRED_PR_CHECKS.map(name=>{
    const matching=runs.filter(r=>r.name===name&&
      r.head_sha===headSha&&
      r.event===(name==='Acceptance / Orchestrator'?'pull_request_target':'pull_request')&&
      r.status==='completed')
      .sort((a,b)=>b.id-a.id);
    const run=matching[0];
    return {name,run_id:run?.id??null,run_attempt:run?.run_attempt??null,
      conclusion:run?.conclusion??'missing',head_sha:headSha,
      url:run?.html_url??null};
  });
  const accepted=checks.find(x=>x.name==='Acceptance / Orchestrator');
  const gateNames=['pre-merge-gate','acceptance-pr-gate'];
  const deterministic=gateNames.map(name=>({
    name,conclusion:jobResults.find(j=>j.name===name)?.conclusion??'missing',
  }));
  const allPassed=checks.every(x=>x.conclusion==='success')&&
    deterministic.every(x=>x.conclusion==='success')&&
    accepted.run_id!=null;
  return {checks,deterministic,all_passed:allPassed};
}
async function collectImplementationGateEvidence(repo,issueNumber,currentIssue,targetSha) {
  if(repo!=='BestNathan/nession'||!issueRequestsImplementationGates(currentIssue))
    return [];
  const events=[];
  for(let page=1;page<=3;page++){
    const pageEvents=await githubGet('/repos/'+repo+'/issues/'+issueNumber+
      '/timeline?per_page=100&page='+page);
    if(!Array.isArray(pageEvents))throw Error('untrusted implementation timeline');
    events.push(...pageEvents);
    if(pageEvents.length<100)break;
  }
  const numbers=selectCrossReferencedImplementationPulls(issueNumber,events);
  const out=[];
  for(const number of numbers){
    if(out.length>=MAX_IMPLEMENTATION_PULLS)break;
    const pr=await githubGet('/repos/'+repo+'/pulls/'+number);
    if(pr?.state!=='closed'||!pr.merged_at||pr.base?.ref!=='main'||
       pr.base.repo?.full_name!==repo||pr.head?.repo?.full_name!==repo)
      continue;
    const files=await githubGet('/repos/'+repo+'/pulls/'+number+'/files?per_page=100');
    if(!eligibleImplementationPull(pr,files,issueNumber))continue;
    // GitHub's compare endpoint independently proves that the merged PR's
    // exact merge commit is an ancestor of the current Acceptance target.
    const comparison=await githubGet('/repos/'+repo+'/compare/'+
      pr.merge_commit_sha+'...'+targetSha);
    if(!['ahead','identical'].includes(comparison?.status)||
       comparison?.merge_base_commit?.sha!==pr.merge_commit_sha)
      continue;
    const runs=await workflowRunsForSha(repo,pr.head.sha);
    const acceptance=runs.filter(x=>x.name==='Acceptance / Orchestrator'&&
      x.head_sha===pr.head.sha&&x.conclusion==='success'&&x.status==='completed')
      .sort((a,b)=>b.id-a.id)[0];
    let jobs=[];
    if(acceptance) {
      const body=await githubGet('/repos/'+repo+'/actions/runs/'+acceptance.id+
        '/attempts/'+acceptance.run_attempt+'/jobs?per_page=100');
      jobs=body.jobs??[];
    }
    const proof=exactImplementationGateBundle(runs,pr.head.sha,jobs);
    out.push({pr_number:number,pr_head_sha:pr.head.sha,
      merge_sha:pr.merge_commit_sha,merged_at:pr.merged_at,
      source:'GitHub Issue cross-reference + main merged PR owned files + exact merge ancestry',
      owner_files:IMPLEMENTATION_OWNER_PATHS,
      ...proof});
  }
  return out;
}


// SC wording is discovery only. Do not accept success claims from mutable
// Issue text; resolve every identity and step independently through GitHub.
// A single, explicit witness keeps historical workflow reads bounded.
export function pinnedHistoricalReporterE2eRerun(body) {
  const section=String(body??'').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## Acceptance Plan|\n## Acceptance Report|$)/)?.[1]??'';
  const lines=section.split('\n').filter(x=>/^- \[[x ]\] SC-\d+\b/.test(x)&&
    x.includes('Historical E2E witness:'));
  if(lines.length>1)throw Error('excessive historical reporter E2E witnesses');
  if(!lines.length)return null;
  const match=lines[0].match(
    /\bHistorical E2E witness:\s*PR #([1-9]\d*) SHA ([a-f0-9]{40}); Reporter Fix PR #([1-9]\d*); E2E Run ([1-9]\d*) attempt ([1-9]\d*)\b/);
  if(!match)throw Error('malformed historical reporter E2E witness locator');
  const [sourcePr,repairPr,runId,attempt]=[match[1],match[3],match[4],match[5]].map(Number);
  if([sourcePr,repairPr,runId,attempt].some(n=>!Number.isSafeInteger(n)||n<=0)||
     sourcePr===repairPr)throw Error('invalid historical reporter E2E witness locator');
  return {source_pr_number:sourcePr,source_sha:match[2],repair_pr_number:repairPr,
    run_id:runId,run_attempt:attempt};
}

export function attestHistoricalReporterE2eRerun(pin,sourcePr,repairPr,repairFiles,
  run,jobs,comparison,targetSha,repo,issueNumber){
  const own=pr=>pr?.state==='closed'&&!!pr.merged_at&&
    pr?.base?.ref==='main'&&pr?.base?.repo?.full_name===repo&&
    pr?.head?.repo?.full_name===repo;
  if(repo!=='BestNathan/nession'||issueNumber!==1725||
     !/^[a-f0-9]{40}$/.test(targetSha)||!pin||
     !own(sourcePr)||!own(repairPr)||
     sourcePr.number!==pin.source_pr_number||
     sourcePr.head.sha!==pin.source_sha||
     repairPr.number!==pin.repair_pr_number||
     !/^[a-f0-9]{40}$/.test(repairPr.merge_commit_sha)||
     !String(repairPr.body??'').split(/\r?\n/).some(x=>
       /^Refs?\s*:?\s*#1725(?:\s|$)/i.test(x))||
     !Array.isArray(repairFiles)||repairFiles.length>100||
     !repairFiles.some(f=>f?.filename==='e2e/runner/selected-report.mjs')||
     !['ahead','identical'].includes(comparison?.status)||
     comparison?.merge_base_commit?.sha!==repairPr.merge_commit_sha)
     throw Error('historical reporter repair identity/ancestry unverified');
  if(run?.id!==pin.run_id||run?.run_attempt!==pin.run_attempt||
     run?.name!=='E2E / Tests'||run?.path!=='.github/workflows/e2e-tests.yml'||
     run?.event!=='pull_request'||run?.head_sha!==pin.source_sha||
     run?.repository?.full_name!==repo||run?.head_repository?.full_name!==repo||
     run?.status!=='completed'||run?.conclusion!=='success')
     throw Error('historical reporter E2E exact-run identity unverified');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    throw Error('historical reporter E2E jobs missing');
  const candidates=jobs.jobs.filter(j=>j?.name==='e2e');
  if(candidates.length!==1)throw Error('historical reporter E2E job ambiguous');
  const j=candidates[0];
  if(!Number.isSafeInteger(j.id)||j.id<=0||
     j.run_id!==pin.run_id||j.run_attempt!==pin.run_attempt||
     j.head_sha!==pin.source_sha||j.status!=='completed'||
     j.conclusion!=='success'||!Array.isArray(j.steps))
    throw Error('historical reporter E2E exact-attempt job unverified');
  // A retry created BEFORE main was repaired is not evidence of the fix.
  const repairTime=Date.parse(repairPr.merged_at),jobTime=Date.parse(j.started_at);
  if(!Number.isFinite(repairTime)||!Number.isFinite(jobTime)||
     jobTime<=repairTime)throw Error('historical E2E attempt predates trusted reporter repair');
  const names=['Resolve linked Issue E2E obligations','Run E2E tests',
    'Normalize selected per-file results even on failure',
    'Enforce authenticated selected-E2E execution result'];
  const steps=names.map(name=>{
    const found=j.steps.filter(s=>s?.name===name);
    if(found.length!==1||found[0].status!=='completed'||
       found[0].conclusion!=='success')
      throw Error('historical reporter E2E required step is not proven success: '+name);
    return {name,conclusion:'success'};
  });
  return {
    kind:'verified_historical_reporter_e2e_rerun',source_pr_number:pin.source_pr_number,
    source_sha:pin.source_sha,repair_pr_number:pin.repair_pr_number,
    repair_merge_sha:repairPr.merge_commit_sha,repair_merged_at:repairPr.merged_at,
    target_sha:targetSha,run_id:pin.run_id,run_attempt:pin.run_attempt,
    job_id:j.id,attempt_job_started_at:j.started_at,
    workflow_conclusion:'success',steps,
    selected_e2e_issue_receipt:'not_attested_by_this_proof',
    provenance:'same-repo merged repair + exact-GitHub-merge ancestry + exact original PR head E2E Run/attempt/job steps after repair',
  };
}

async function collectHistoricalReporterE2eRerun(repo,issue,targetSha){
  if(process.env.ACCEPTANCE_STAGE!=='post-merge')return null;
  const pin=pinnedHistoricalReporterE2eRerun(issue?.body);
  if(!pin)return null;
  const [source,repair,run]=await Promise.all([
    githubGet('/repos/'+repo+'/pulls/'+pin.source_pr_number),
    githubGet('/repos/'+repo+'/pulls/'+pin.repair_pr_number),
    githubGet('/repos/'+repo+'/actions/runs/'+pin.run_id),
  ]);
  const [files,jobs,comparison]=await Promise.all([
    githubGet('/repos/'+repo+'/pulls/'+pin.repair_pr_number+'/files?per_page=100'),
    githubGet('/repos/'+repo+'/actions/runs/'+pin.run_id+
      '/attempts/'+pin.run_attempt+'/jobs?per_page=100'),
    githubGet('/repos/'+repo+'/compare/'+repair.merge_commit_sha+'...'+targetSha),
  ]);
  return attestHistoricalReporterE2eRerun(pin,source,repair,files,run,jobs,
    comparison,targetSha,repo,Number(issue.number));
}

async function collectCommand(workspace, outFile) {
  const repo = requireText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const sha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const directRuns = await workflowRunsForSha(repo, sha);
  const replayDenials=process.env.ACCEPTANCE_STAGE==='post-merge'&&
    ['1690','1853'].includes(String(process.env.ISSUE_NUMBER??''))
    ?await collectAuthenticatedReplayDenials(repo,sha,directRuns):[];
  // General, not issue-gated: any post-merge criterion about the governed refs
  // needs to be able to tell "unobservable here" from "absent".
  const storePolicyObservability=process.env.ACCEPTANCE_STAGE==='post-merge'
    ?await collectStorePolicyObservability(repo,sha,directRuns):[];
  const targetPushE2eRuns=process.env.ACCEPTANCE_STAGE==='post-merge'
    ? await collectTargetPushE2eRuns(repo,sha) : [];
  // #1866 SC-04: job-log batch receipts are readable at every stage; the
  // collector itself is bounded to canonical workflow runs at the exact SHA.
  const acceptanceBatchReceipts=await collectAcceptanceBatchReceipts(repo,sha,directRuns);
  // A post-E2E Agent cannot prove its own Waker has completed. Read the
  // bounded, exact-attempt, SHA256-bound prior cycle independently instead.
  const postE2eWakeReceipts=process.env.ACCEPTANCE_STAGE==='post-merge'&&
    String(process.env.ISSUE_NUMBER??'')==='1850'
    ? await collectE2eWakeReceipts({repo,sha,issue:1850,get:githubGet,getText:githubJobLog}) : [];
  // Independently bound Git-byte Case receipts only, never green no-op success.
  const verifiedCaseReceipts = process.env.ACCEPTANCE_STAGE === 'post-merge'
    ? await collectAuthenticatedCaseReadbacks({repo,targetSha:sha,runs:directRuns,request:githubGet})
    : [];
  // #1876: read source-timestamp costs independently from successful
  // GitHub runs. Only post-merge requirement #1876 needs historical cohort
  // replay; arbitrary PR prose cannot add runs or forge a speedup.
  const verifiedCiCostStudy=process.env.ACCEPTANCE_STAGE==='post-merge'
    ? await collectVerifiedCiCostStudy({
        issueNumber:Number(process.env.ISSUE_NUMBER??0),repo,
        get:githubGet,getText:githubJobLog,
      })
    : null;
  // #1876: original not-required and fail-closed Browser Design fixtures
  // are re-attested against their original REST Run/Attempt/Job/log.
  // Only the named requirement may surface this historical evidence.
  const historicalBrowserDesignProof=await collectHistoricalBrowserDesignProof({
    repo, issueNumber:Number(process.env.ISSUE_NUMBER??0),
    get:githubGet, getText:githubJobLog,
  });
  const issueNumberForReplay=String(process.env.ISSUE_NUMBER||'');
  const replayIssue=process.env.ACCEPTANCE_STAGE==='post-merge'&&
    /^[1-9][0-9]*$/.test(issueNumberForReplay)
    ? await githubGet('/repos/'+repo+'/issues/'+issueNumberForReplay) : null;
  const verifiedHistoricalCaseReplays=replayIssue ? await historicalCaseEvidence({
    repo,target:sha,body:replayIssue.body,get:githubGet,getText:githubJobLog,
  }) : [];
  const historicalRecovery=replayIssue ? await collectHistoricalRecovery({
    repo,issue:replayIssue,stage:process.env.ACCEPTANCE_STAGE,targetSha:sha,
    workspace,metricsRoot:path.join(process.env.GITHUB_WORKSPACE,'provider-metrics'),
    request:githubGet,readLog:githubJobLog,checkAncestor:checkGitAncestor,
  }) : null;
  const exactHeadE2eSteps = await collectExactHeadE2eSteps(repo,sha,directRuns);
  const providerWakeEvidence = await collectPinnedProviderEvidence(repo,sha);
  const pulls = await githubGet('/repos/' + repo + '/commits/' + encodeURIComponent(sha) + '/pulls?per_page=10');
  const selectedPulls = (Array.isArray(pulls) ? pulls : []).filter((pull) => pull?.head?.sha).slice(0, MAX_ASSOCIATED_PULLS);
  const pullRunsBySha = new Map();
  for (const pull of selectedPulls) {
    const headSha = String(pull.head.sha);
    if (!pullRunsBySha.has(headSha)) {
      pullRunsBySha.set(headSha, await workflowRunsForSha(repo, headSha));
    }
  }
  // SC-02 is evaluated at a merged target, but its selected-PR run lives on
  // the PR head. Re-read each head's own job log so the one-runtime
  // measurement is reachable from that boundary.
  const selectedRunReceiptsBySha = new Map();
  const notRequiredRunReceiptsBySha = new Map();
  const exactHeadStepsBySha = new Map();
  const batchReceiptsBySha = new Map();
  for (const [headSha, runs] of pullRunsBySha) {
    selectedRunReceiptsBySha.set(headSha,
      await collectSelectedE2eRunReceipts(repo, headSha, runs));
    notRequiredRunReceiptsBySha.set(headSha,
      await collectNotRequiredE2eReceipts(repo, headSha, runs));
    exactHeadStepsBySha.set(headSha,
      await collectExactHeadE2eSteps(repo, headSha, runs));
    batchReceiptsBySha.set(headSha,
      await collectAcceptanceBatchReceipts(repo, headSha, runs));
  }
  const selectedRunReceipts = await collectSelectedE2eRunReceipts(repo, sha, directRuns);
  const notRequiredRunReceipts = await collectNotRequiredE2eReceipts(repo, sha, directRuns);
  const fullGateProvisionReceipts = await collectFullGateProvisionReceipts(repo, sha, directRuns);
  const sourceAncestry = await collectSourceAncestry(repo, workspace, sha);
  const ancestryRuns = await collectAncestryRuns(repo, sourceAncestry, sha);
  const ancestryReceipts = await collectAncestryReceipts(repo, sourceAncestry, sha);
  const targetMergeProof = sourceAncestry.length && process.env.ACCEPTANCE_STAGE === 'post-merge'
    ? checkGitMergeCommit(workspace, sha, sourceAncestry.map(x=>x.ancestor_sha))
    : null;
  // Post-merge validation may concern an EARLIER merge that is now an
  // ancestor of main. Validate each bounded, already ancestry-proven Issue
  // SHA directly from Git, not just the current HEAD's own parents.
  const declaredMergeCommits = targetMergeProof===null ? [] : sourceAncestry
    .filter(x=>x.is_ancestor && x.ancestor_sha!==sha)
    .map(x=>checkGitMergeCommit(workspace,x.ancestor_sha,
      sourceAncestry.map(entry=>entry.ancestor_sha)));
  // Prove source → historical merge directly, not by separately asserting
  // that both objects are ancestors of the CURRENT checkout HEAD.
  const historicalAncestry=process.env.ACCEPTANCE_STAGE==='post-merge'
    ? declaredMergeCommits.filter(x=>x.status==='verified'&&x.is_ordinary_merge)
      .flatMap(merge=>sourceAncestry.filter(a=>a.ancestor_sha!==merge.target_sha)
        .map(a=>checkGitAncestor(workspace,merge.target_sha,a.ancestor_sha)))
    : [];
  const historicalOrchestratorRuns=[];
  const historicalProviderChains=[];
  if(process.env.ACCEPTANCE_STAGE==='post-merge'&&
     /^[1-9][0-9]*$/.test(String(process.env.ISSUE_NUMBER??''))){
    const current=await githubGet('/repos/'+repo+'/issues/'+process.env.ISSUE_NUMBER);
    const pinned=pinnedHistoricalOrchestratorIds(current.body);
    const verifiedMergeShas=new Set(declaredMergeCommits
      .filter(x=>x.status==='verified'&&x.is_ordinary_merge)
      .map(x=>x.target_sha));
    for(const runId of pinned){
      const source=await githubGet('/repos/'+repo+'/actions/runs/'+runId);
      if(!verifiedMergeShas.has(source.head_sha))
        throw Error('historical source SHA is not a verified merged ancestor');
      historicalOrchestratorRuns.push(attestHistoricalOrchestrator(
        source,source.head_sha,runId,repo));
    }
    // Historical sequences are evaluated only for Git-verified two-parent
    // main merge ancestors. The Issue's SC text is a lookup hint, never proof.
    for(const pins of pinnedHistoricalProviderChains(current.body)){
      const already=historicalOrchestratorRuns.find(r=>r.id===pins.orchestrator_run_id);
      if(!already)throw Error('historical dependency Orchestrator Run was not independently attested');
      const [provider,metrics,orchestrator,jobs]=await Promise.all([
        githubGet('/repos/'+repo+'/actions/runs/'+pins.provider_run_id),
        githubGet('/repos/'+repo+'/actions/runs/'+pins.metrics_run_id),
        githubGet('/repos/'+repo+'/actions/runs/'+pins.orchestrator_run_id),
        githubGet('/repos/'+repo+'/actions/runs/'+pins.orchestrator_run_id+
          '/attempts/'+pins.orchestrator_attempt+'/jobs?per_page=100'),
      ]);
      historicalProviderChains.push(attestHistoricalProviderChain(
        pins,provider,metrics,orchestrator,jobs,verifiedMergeShas,repo));
    }
  }
  // Acceptance for E2E-specific Issues must also observe previous PR commits:
  // the current target SHA by itself cannot prove a fail-then-pass scenario.
  // Read the trusted orphan Run Record, joined to GitHub completed workflow
  // run ID, exact SHA, PR identity and attempt. These are bounded reads only.
  const historicalE2EByPr = new Map();
  const linkedIssueE2E = [];
  let implementationPulls = [];
  let historicalReporterE2eRerun = null;
  let relatedAcceptance = [];
  let relatedBugCompletion = null;
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (/^[1-9][0-9]*$/.test(issueNumber)) {
    const currentIssue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
    const section = String(currentIssue.body ?? '').match(/^## E2E Verification\s*$/m);
    if (section) {
      for (const pull of selectedPulls) {
        historicalE2EByPr.set(Number(pull.number),
          await collectHistoricalE2EForPull(repo, pull, githubGet));
      }
      // Both pre-merge and post-merge must independently re-attest earlier
      // cross-Issue selected-run and post-PATCH receipt history. A previous
      // Pass is not itself reusable proof: exact GitHub Run, source SHA,
      // immutable orphan receipts and (for main merges) target ancestry are
      // verified again before an Agent evaluates the current criterion.
      // This is read-only and NEVER aliases old PR-head tests to target SHA.
      linkedIssueE2E.push(...await collectLinkedIssueE2EEvidence(repo,
        Number(issueNumber),githubGet,undefined,sha));
      if (process.env.ACCEPTANCE_STAGE === 'post-merge') {
        // The child Issue's own "none" E2E declaration does not make it an
        // owner of its parent's historical browser scenario. Include the
        // independently authenticated parent source runs *as related
        // behavior evidence only*, after validating the same-repo parent
        // Issue contract. The Agent must not mislabel them as child-owned.
        const parentNumber=parentEvidenceDiscovery(currentIssue);
        if(parentNumber!==null){
          const parent=await githubGet('/repos/'+repo+'/issues/'+parentNumber);
          if(parent?.number!==parentNumber||parent?.pull_request)
            throw Error('invalid related Issue provenance target');
          const contract=parseIssueE2E(parent.body,{requireDeclaration:true});
          if(contract?.errors?.length||!contract?.selectedIds?.length)
            throw Error('parent Issue lacks authenticated E2E obligations');
          const proof=await collectLinkedIssueE2EEvidence(repo,parentNumber,githubGet,undefined,sha);
          linkedIssueE2E.push(...proof.map(item=>({
            ...item,behavior_owner_issue:parentNumber,
            related_child_issue:Number(issueNumber),
            relationship_provenance:'candidate parent only; source Plan and protected receipts remain authoritative',
          })));
        }
      }
    }
    if(process.env.ACCEPTANCE_STAGE==='post-merge') {
      implementationPulls=await collectImplementationGateEvidence(
        repo,Number(issueNumber),currentIssue,sha);
      historicalReporterE2eRerun=await collectHistoricalReporterE2eRerun(
        repo,currentIssue,sha);
      relatedAcceptance=await collectCrossIssueAcceptance(repo,currentIssue.body,
        sha,Number(issueNumber),githubGet,attestExactHeadE2eSteps);
      if(Number(issueNumber)===1818)
        relatedBugCompletion=await collectRelatedBugCompletion(repo,currentIssue,sha,githubGet);
    }
  }
  const reuseComparison = computeReuseComparison({ targetSha: sha,
    acceptanceBatchReceipts,
    extraBatchReceipts: [...batchReceiptsBySha.values()].flat()
      .concat(ancestryReceipts.flatMap(entry => entry.acceptance_batch_receipts)),
    extraSelectedRunReceipts: [...selectedRunReceiptsBySha.values()].flat()
      .concat(ancestryReceipts.flatMap(entry => entry.e2e_selected_run_receipts)),
    fullGateProvisionReceipts, selectedRunReceipts, targetPushE2eRuns });
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls,
    pullRunsBySha, sourceAncestry, historicalE2EByPr, linkedIssueE2E, implementationPulls, targetMergeProof, declaredMergeCommits, providerWakeEvidence, historicalAncestry, historicalOrchestratorRuns, historicalProviderChains, historicalRecovery, exactHeadE2eSteps, historicalReporterE2eRerun, verifiedHistoricalCaseReplays, verifiedCaseReceipts, relatedAcceptance, relatedBugCompletion, targetPushE2eRuns, postE2eWakeReceipts, replayDenials, storePolicyObservability, ancestryRuns, acceptanceBatchReceipts, selectedRunReceiptsBySha, selectedRunReceipts, notRequiredRunReceiptsBySha, notRequiredRunReceipts, fullGateProvisionReceipts, verifiedCiCostStudy, historicalBrowserDesignProof, exactHeadStepsBySha, batchReceiptsBySha, ancestryReceipts, reuseComparison });
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'collected acceptance CI evidence for ' + sha +
    ': ' + evidence.direct_runs.length + ' direct run(s), ' +
    evidence.pull_requests.length + ' associated PR(s)'
  );
}

async function selfTest() {
  // Security evidence cannot inherit the target's main SHA from an off-main
  // source, cannot trust the job log without REST identities, and must prove
  // the privileged Publisher actually skipped.
  const denialSha='a'.repeat(40),branchSha='b'.repeat(40);
  const denialRepo='BestNathan/nession',denialFull={full_name:denialRepo};
  const receipt=makeDenialReceipt({
    GITHUB_REPOSITORY:denialRepo,GITHUB_EVENT_NAME:'workflow_run',
    GITHUB_REF:'refs/heads/main',GITHUB_SHA:denialSha,
    GITHUB_RUN_ID:'811',GITHUB_RUN_ATTEMPT:'1',
  },{workflow_run:{id:701,run_attempt:1,workflow_id:385795701,
    event:'push',head_branch:'test/untrusted',head_sha:branchSha,
    repository:denialFull,head_repository:denialFull}},
  new Error('Metrics Replay refused: unexpected wake-up event or upstream trigger'));
  const deniedSource={id:701,run_attempt:1,workflow_id:385795701,
    event:'push',head_branch:'test/untrusted',head_sha:branchSha,
    repository:denialFull,head_repository:denialFull,status:'completed',
    conclusion:'success',name:'Metrics / Replay Request',
    path:'.github/workflows/metrics-replay-request.yml',
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'}};
  const deniedRecipient={id:811,run_attempt:1,head_sha:denialSha,
    head_branch:'main',event:'workflow_run',repository:denialFull,
    head_repository:denialFull,status:'completed',conclusion:'failure',
    name:'Metrics / Repository Health',
    path:'.github/workflows/metrics-repository.yml'};
  const deniedJobs={jobs:['authorize-replay','rust-health','web-health',
    'e2e-health','publish'].map((name,i)=>({name,id:200+i,run_id:811,
    run_attempt:1,head_sha:denialSha,status:'completed',
    conclusion:i===0?'failure':'skipped'}))};
  const candidate={...deniedRecipient};
  const request=async p=>{
    if(p.endsWith('/actions/runs/811'))return deniedRecipient;
    if(p.endsWith('/actions/runs/701'))return deniedSource;
    if(p.endsWith('/actions/workflows/385795701'))return {
      id:385795701,name:'Metrics / Replay Request',
      path:'.github/workflows/metrics-replay-request.yml'};
    if(p.endsWith('/actions/runs/811/attempts/1/jobs?per_page=100'))
      return deniedJobs;
    throw Error('unexpected negative evidence API: '+p);
  };
  const denialLog='2026-10-16T03:06:57Z '+DENIAL_LOG_PREFIX+
    JSON.stringify(receipt)+'\n';
  const verified=await collectAuthenticatedReplayDenials(denialRepo,denialSha,
    [candidate,{...candidate,head_sha:branchSha}],request,async()=>denialLog);
  assert.equal(verified.length,1);
  assert.equal(verified[0].source_sha,branchSha);
  assert.equal(verified[0].privileged_publisher_job,'skipped');
  assert.deepEqual(await collectAuthenticatedReplayDenials(denialRepo,denialSha,
    [candidate],request,async()=>''),[]);
  await assert.rejects(()=>collectAuthenticatedReplayDenials(denialRepo,denialSha,
    [candidate],async p=>p.includes('/jobs?')?{jobs:deniedJobs.jobs.map(j=>
      j.name==='publish'?{...j,conclusion:'success'}:j)}:request(p),
    async()=>denialLog),/publisher\/job/);
  await assert.rejects(()=>collectAuthenticatedReplayDenials(denialRepo,denialSha,
    [candidate],async p=>p.endsWith('/actions/runs/701')?
      {...deniedSource,run_attempt:2}:request(p),async()=>denialLog),/provenance mismatch/);

  // Store policy observability: the failed governance run's only evaluator-
  // visible fact was its conclusion, which made an unobservable capability read
  // exactly like an absent policy. The receipt is re-read from the trusted
  // observe job's own log and its ceiling is Pending.
  const policySha='d'.repeat(40);
  const policyReceipt=makePolicyObservabilityReceipt({
    GITHUB_REPOSITORY:denialRepo,GITHUB_REF:'refs/heads/main',GITHUB_SHA:policySha,
    GITHUB_RUN_ID:'911',GITHUB_RUN_ATTEMPT:'1'},{
    protected_by_server_ruleset:false,policy_observability:{
      verdict:'unobservable_by_this_credential',
      unobservable_capabilities:[UNOBSERVABLE_CAPABILITIES.bypass],
      refs_whose_policy_is_unobservable_here:[...GOVERNED_REFS],
      establishes_neither_presence_nor_absence:true}});
  const policyRun={id:911,run_attempt:1,head_sha:policySha,head_branch:'main',
    event:'push',status:'completed',conclusion:'failure',
    name:POLICY_WORKFLOW_NAME,path:POLICY_WORKFLOW,
    repository:denialFull,head_repository:denialFull};
  const policyJobs={jobs:[{name:POLICY_OBSERVE_JOB,id:300,run_id:911,
    run_attempt:1,head_sha:policySha,status:'completed',conclusion:'failure'}]};
  const policyRequest=async p=>{
    if(p.endsWith('/actions/runs/911'))return policyRun;
    if(p.endsWith('/actions/runs/911/attempts/1/jobs?per_page=100'))return policyJobs;
    throw Error('unexpected policy observability API: '+p);
  };
  const policyLog='2026-10-16T17:00:00Z '+POLICY_OBSERVABILITY_LOG_PREFIX+
    JSON.stringify(policyReceipt)+'\n';
  const observed=await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,id:911}],policyRequest,async()=>policyLog);
  assert.equal(observed.length,1);
  assert.equal(observed[0].protection_established,false);
  assert.equal(observed[0].maximum_supported_result,'Pending');
  assert.deepEqual(observed[0].unobservable_capabilities,
    [UNOBSERVABLE_CAPABILITIES.bypass]);
  // A successful governance run is not this channel's business.
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,conclusion:'success'}],policyRequest,async()=>policyLog),[]);
  // A run at another SHA, another workflow, or an event the audit does not
  // declare is not evidence.
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,head_sha:'e'.repeat(40)}],policyRequest,async()=>policyLog),[]);
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,event:'pull_request'}],policyRequest,async()=>policyLog),[]);
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,path:'.github/workflows/evil.yml'}],policyRequest,
    async()=>policyLog),[]);
  // Every trigger Store / Governance Audit actually declares IS a legitimate
  // producer. Restricting this to `push` made the receipt unreachable on any
  // unrelated merge SHA, where a dispatch is the only audit that exists, and the
  // criterion silently fell back to reading a bare failed run.
  for(const event of POLICY_TRIGGER_EVENTS){
    const seen=await collectStorePolicyObservability(denialRepo,policySha,
      [{...policyRun,event}],policyRequest,async()=>policyLog);
    assert.equal(seen.length,1,'declared trigger '+event+' must be accepted');
    assert.equal(seen[0].maximum_supported_result,'Pending');
  }
  // An absent log or an absent receipt is not evidence, and must not throw.
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,id:911}],policyRequest,async()=>''),[]);
  // A tampered receipt is rejected, never silently accepted or downgraded.
  await assert.rejects(()=>collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,id:911}],policyRequest,
    async()=>'2026-10-16T17:00:00Z '+POLICY_OBSERVABILITY_LOG_PREFIX+
      JSON.stringify({...policyReceipt,protected_by_server_ruleset:true})+'\n'),
    /invalid Run Store policy observability receipt/);
  // A green observe job is not this channel: only a fail-closed run can be
  // unobservable, so it yields no evidence rather than a throwing error. The
  // collector stays fail-safe here — silence can never become a Pass.
  assert.deepEqual(await collectStorePolicyObservability(denialRepo,policySha,
    [{...policyRun,id:911}],async p=>p.includes('/jobs?')
      ?{jobs:policyJobs.jobs.map(j=>({...j,conclusion:'success'}))}:policyRequest(p),
    async()=>policyLog),[]);

  // #1866 SC-04: "two Cases shared one job-owned runtime" is written into the
  // job log because the harness never reads artifacts. The receipt is unstrusted
  // target output until the collector rebinds it to the exact Run/Attempt/SHA.
  const batchSha='7'.repeat(40);
  const batchEnv={GITHUB_REPOSITORY:denialRepo,GITHUB_RUN_ID:'912',GITHUB_RUN_ATTEMPT:'1',
    GITHUB_WORKFLOW_REF:denialRepo+'/.github/workflows/acceptance-cases.yml@refs/heads/main'};
  const batchRecord=(issue,criterion,id)=>({issue,criterion,result:'Pass',
    runtime_profile:'full-stack-local',execution_id:id,contract_sha256:'c'.repeat(64),
    case_tree_sha:batchSha});
  const batchReceipt=makeAcceptanceBatchReceipt({env:batchEnv,runId:912,runAttempt:1,
    sha:batchSha,stage:'post-merge',selectionCount:2,
    records:[batchRecord(1474,'SC-09','1'.repeat(64)),batchRecord(1474,'SC-10','2'.repeat(64))],
    errors:[],sharedRuntimeCount:1,placement:new Map([
      ['1474|SC-09',{batch_index:0,isolation:'shared',profile:'full-stack-local'}],
      ['1474|SC-10',{batch_index:0,isolation:'shared',profile:'full-stack-local'}],
    ])});
  const batchRun={id:912,run_attempt:1,head_sha:batchSha,head_branch:'main',event:'push',
    status:'completed',conclusion:'success',name:'Acceptance / Cases',
    path:'.github/workflows/acceptance-cases.yml',repository:denialFull,
    head_repository:denialFull};
  const batchJobs={jobs:[{name:'execute',id:400,run_id:912,run_attempt:1,
    head_sha:batchSha,status:'completed',conclusion:'success'}]};
  const batchRequest=async p=>{
    if(p.endsWith('/actions/runs/912'))return batchRun;
    if(p.endsWith('/actions/runs/912/attempts/1/jobs?per_page=100'))return batchJobs;
    throw Error('unexpected Acceptance batch API: '+p);
  };
  const batchLog='2026-10-17T06:00:00Z '+ACCEPTANCE_BATCH_LOG_PREFIX+
    JSON.stringify(batchReceipt)+'\n';
  const batchEvidence=await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [batchRun],batchRequest,async()=>batchLog);
  assert.equal(batchEvidence.length,1);
  assert.equal(batchEvidence[0].shared_ready_runtimes,1);
  assert.equal(batchEvidence[0].cases_sharing_one_runtime,2);
  assert.equal(batchEvidence[0].independent_case_records,true);
  // Another SHA, a non-canonical workflow, an undeclared event, or a
  // non-canonical job is not evidence.
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [{...batchRun,head_sha:'8'.repeat(40)}],batchRequest,async()=>batchLog),[]);
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [{...batchRun,name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml'}],
    batchRequest,async()=>batchLog),[]);
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [{...batchRun,event:'workflow_dispatch'}],batchRequest,async()=>batchLog),[]);
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [batchRun],async p=>p.includes('/jobs?')
      ?{jobs:[{...batchJobs.jobs[0],name:'publish'}]}:batchRequest(p),
    async()=>batchLog),[]);
  // An absent/expired log or an absent receipt is not evidence and must not throw.
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [batchRun],batchRequest,async()=>''),[]);
  // A mutated receipt is target-produced input: it is ignored (no evidence),
  // never trusted and never downgraded into partial evidence.
  assert.deepEqual(await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [batchRun],batchRequest,async()=>ACCEPTANCE_BATCH_LOG_PREFIX+
      JSON.stringify({...batchReceipt,shared_ready_runtimes:0})+'\n'),[]);
  // The PR smoke workflow is a canonical producer with its own job/event.
  const smokeEnv={...batchEnv,GITHUB_RUN_ID:'913',GITHUB_WORKFLOW_REF:denialRepo+
    '/.github/workflows/acceptance-case-smoke.yml@refs/heads/feat/x'};
  const smokeReceipt=makeAcceptanceBatchReceipt({env:smokeEnv,runId:913,runAttempt:1,
    sha:batchSha,stage:'pre-merge',selectionCount:2,
    records:[batchRecord(7,'SC-02','3'.repeat(64)),batchRecord(2,'SC-03','4'.repeat(64))],
    errors:[],sharedRuntimeCount:1,placement:new Map([
      ['7|SC-02',{batch_index:0,isolation:'shared',profile:'full-stack-local'}],
      ['2|SC-03',{batch_index:0,isolation:'shared',profile:'full-stack-local'}],
    ])});
  const smokeRun={...batchRun,id:913,event:'pull_request',head_branch:'feat/x',
    name:'Acceptance / Case Smoke',path:'.github/workflows/acceptance-case-smoke.yml'};
  const smokeJobs={jobs:[{name:'case-smoke',id:401,run_id:913,run_attempt:1,
    head_sha:batchSha,status:'completed',conclusion:'success'}]};
  const smokeRequest=async p=>{
    if(p.endsWith('/actions/runs/913'))return smokeRun;
    if(p.endsWith('/actions/runs/913/attempts/1/jobs?per_page=100'))return smokeJobs;
    throw Error('unexpected smoke batch API: '+p);
  };
  const smokeEvidence=await collectAcceptanceBatchReceipts(denialRepo,batchSha,
    [smokeRun],smokeRequest,async()=>ACCEPTANCE_BATCH_LOG_PREFIX+
      JSON.stringify(smokeReceipt)+'\n');
  assert.equal(smokeEvidence.length,1);
  assert.equal(smokeEvidence[0].event,'pull_request');
  assert.deepEqual(smokeEvidence[0].stages,['pre-merge']);
  assert.deepEqual(normalizeCiEvidence({targetSha:batchSha,
    acceptanceBatchReceipts:batchEvidence}).acceptance_batch_receipts,batchEvidence);

  // #1866 SC-02: the selected PR E2E job measures its own full-stack
  // provisions. The receipt is target output until Run/Attempt/SHA/job/step
  // are rebound, and it is reachable from a merged target through the PR head.
  const selSha='9'.repeat(40);
  const selEnv={GITHUB_REPOSITORY:denialRepo,GITHUB_RUN_ID:'914',GITHUB_RUN_ATTEMPT:'1'};
  const selReceipt=makeE2eSelectedRunReceipt({env:selEnv,sha:selSha,
    selectedIds:['login','session-lifecycle','terminal-io'],provisions:1});
  const selRun={id:914,run_attempt:1,head_sha:selSha,head_branch:'feat/x',
    event:'pull_request',status:'completed',conclusion:'success',name:'E2E / Tests',
    path:'.github/workflows/e2e-tests.yml',repository:denialFull,
    head_repository:denialFull};
  const selJobs={jobs:[{name:'e2e',id:402,run_id:914,run_attempt:1,head_sha:selSha,
    status:'completed',conclusion:'success',
    steps:[{name:'Run E2E tests',conclusion:'success'}]}]};
  const selRequest=async p=>{
    if(p.endsWith('/actions/runs/914'))return selRun;
    if(p.endsWith('/actions/runs/914/attempts/1/jobs?per_page=100'))return selJobs;
    throw Error('unexpected selected E2E API: '+p);
  };
  const selLog='2026-10-17T07:00:00Z '+E2E_SELECTED_RUN_LOG_PREFIX+
    JSON.stringify(selReceipt)+'\n';
  const selectedReceipts=await collectSelectedE2eRunReceipts(denialRepo,selSha,[selRun],
    selRequest,async()=>selLog);
  assert.equal(selectedReceipts.length,1);
  assert.equal(selectedReceipts[0].one_runtime_for_selected_run,true);
  assert.deepEqual(selectedReceipts[0].selected_ids,
    ['login','session-lifecycle','terminal-io']);
  // Another SHA, an unrelated workflow, a push run, a failed run or a failed
  // `Run E2E tests` step is not evidence, and an absent log must not throw.
  assert.deepEqual(await collectSelectedE2eRunReceipts(denialRepo,selSha,
    [{...selRun,head_sha:'a'.repeat(40)}],selRequest,async()=>selLog),[]);
  assert.deepEqual(await collectSelectedE2eRunReceipts(denialRepo,selSha,
    [{...selRun,name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml'}],
    selRequest,async()=>selLog),[]);
  assert.deepEqual(await collectSelectedE2eRunReceipts(denialRepo,selSha,
    [{...selRun,event:'push'}],selRequest,async()=>selLog),[]);
  assert.deepEqual(await collectSelectedE2eRunReceipts(denialRepo,selSha,
    [{...selRun,conclusion:'failure'}],selRequest,async()=>selLog),[]);
  // A successful run whose own `Run E2E tests` step says failure is a
  // data-integrity inconsistency, not ordinary missing evidence: surface it.
  await assert.rejects(()=>collectSelectedE2eRunReceipts(denialRepo,selSha,[selRun],
    async p=>p.includes('/jobs?')?{jobs:[{...selJobs.jobs[0],
      steps:[{name:'Run E2E tests',conclusion:'failure'}]}]}:selRequest(p),
    async()=>selLog),/mismatch/);
  assert.deepEqual(await collectSelectedE2eRunReceipts(denialRepo,selSha,[selRun],
    selRequest,async()=>''),[]);
  const selNormalized=normalizeCiEvidence({targetSha:'b'.repeat(40),
    pulls:[{number:1,state:'closed',merged_at:'2026-10-17T00:00:00Z',
      head:{sha:selSha,ref:'feat/x'},base:{ref:'main'},html_url:'https://example.invalid'}],
    pullRunsBySha:new Map([[selSha,[selRun]]]),
    selectedRunReceiptsBySha:new Map([[selSha,selectedReceipts]]),
    selectedRunReceipts:selectedReceipts});
  assert.equal(selNormalized.pull_requests[0].e2e_selected_run_receipts.length,1);
  assert.equal(selNormalized.e2e_selected_run_receipts.length,1);
  // A merged target has no pull_request run of its own; the PR head's
  // exact-head E2E steps and Case batch receipts must still be reachable.
  const prHeadNormalized=normalizeCiEvidence({targetSha:'b'.repeat(40),
    pulls:[{number:3,state:'closed',merged_at:'2026-10-17T00:00:00Z',
      head:{sha:selSha,ref:'feat/z'},base:{ref:'main'},html_url:'https://example.invalid'}],
    pullRunsBySha:new Map([[selSha,[selRun]]]),
    exactHeadStepsBySha:new Map([[selSha,[{kind:'verified_exact_head_e2e_steps'}]]]),
    batchReceiptsBySha:new Map([[selSha,[{kind:'verified_acceptance_case_batch'}]]])});
  assert.equal(prHeadNormalized.pull_requests[0].exact_head_e2e_steps.length,1);
  assert.equal(prHeadNormalized.pull_requests[0].acceptance_batch_receipts.length,1);

  // #1866 SC-01: an explicit `not-required` plan must prove, from GitHub's own
  // resolved step outcomes, that E2E-only preparation was skipped while the
  // required design gate ran.
  const nrEnv={GITHUB_REPOSITORY:denialRepo,GITHUB_RUN_ID:'915',GITHUB_RUN_ATTEMPT:'1'};
  const nrSha='3'.repeat(40);
  const nrSteps={rust_toolchain:'skipped',cargo_build:'skipped',tmux:'skipped',
    design_gate:'success'};
  const nrReceipt=makeE2eNotRequiredReceipt({env:nrEnv,sha:nrSha,steps:nrSteps});
  const nrRun={...selRun,id:915,head_sha:nrSha,conclusion:'success'};
  const nrJobs={jobs:[{name:'e2e',id:403,run_id:915,run_attempt:1,head_sha:nrSha,
    status:'completed',conclusion:'success',
    steps:[{name:'Install Rust toolchain',conclusion:'skipped'},
      {name:'Build Rust binaries',conclusion:'skipped'},
      {name:'Install tmux',conclusion:'skipped'},
      {name:'Run canonical browser design gate',conclusion:'success'}]}]};
  const nrRequest=async p=>{
    if(p.endsWith('/actions/runs/915'))return nrRun;
    if(p.endsWith('/actions/runs/915/attempts/1/jobs?per_page=100'))return nrJobs;
    throw Error('unexpected not-required E2E API: '+p);
  };
  const nrLog='2026-10-17T07:10:00Z '+E2E_NOT_REQUIRED_LOG_PREFIX+
    JSON.stringify(nrReceipt)+'\n';
  const notRequired=await collectNotRequiredE2eReceipts(denialRepo,nrSha,[nrRun],
    nrRequest,async()=>nrLog);
  assert.equal(notRequired.length,1);
  assert.deepEqual(notRequired[0].skipped_e2e_only_steps,
    ['rust_toolchain','cargo_build','tmux']);
  assert.equal(notRequired[0].design_gate,'success');
  // A run where the Rust build actually ran is not a skip.
  await assert.rejects(()=>collectNotRequiredE2eReceipts(denialRepo,nrSha,[nrRun],
    async p=>p.includes('/jobs?')?{jobs:[{...nrJobs.jobs[0],
      steps:[{name:'Install Rust toolchain',conclusion:'success'},
        {name:'Build Rust binaries',conclusion:'success'},
        {name:'Install tmux',conclusion:'skipped'},
        {name:'Run canonical browser design gate',conclusion:'success'}]}]}:nrRequest(p),
    async()=>nrLog),/provenance mismatch/);
  assert.deepEqual(await collectNotRequiredE2eReceipts(denialRepo,nrSha,
    [{...nrRun,event:'push'}],nrRequest,async()=>nrLog),[]);
  assert.deepEqual(await collectNotRequiredE2eReceipts(denialRepo,nrSha,[nrRun],
    nrRequest,async()=>''),[]);
  const nrNormalized=normalizeCiEvidence({targetSha:'b'.repeat(40),
    pulls:[{number:2,state:'closed',merged_at:'2026-10-17T00:00:00Z',
      head:{sha:nrSha,ref:'feat/y'},base:{ref:'main'},html_url:'https://example.invalid'}],
    pullRunsBySha:new Map([[nrSha,[nrRun]]]),
    notRequiredRunReceiptsBySha:new Map([[nrSha,notRequired]]),
    notRequiredRunReceipts:notRequired});
  assert.equal(nrNormalized.pull_requests[0].e2e_not_required_receipts.length,1);
  assert.equal(nrNormalized.e2e_not_required_receipts.length,1);

  // #1866 SC-03: the Full Gate's measured provision receipt is reachable from
  // the push job log at the exact target SHA.
  const fgSha='5'.repeat(40);
  const fgReceipt={schema_version:1,kind:'e2e_full_gate',repository:denialRepo,
    workflow:'.github/workflows/e2e-tests.yml',run_id:916,run_attempt:1,sha:fgSha,
    mode:'all',provisions:1,selector_verified:true,selected_report_verified:true};
  const fgRun={...selRun,id:916,head_sha:fgSha,event:'push',conclusion:'success'};
  const fgJobs={jobs:[{name:'e2e',id:404,run_id:916,run_attempt:1,head_sha:fgSha,
    status:'completed',conclusion:'success',
    steps:[{name:'Run E2E tests',conclusion:'success'}]}]};
  const fgRequest=async p=>{
    if(p.endsWith('/actions/runs/916'))return fgRun;
    if(p.endsWith('/actions/runs/916/attempts/1/jobs?per_page=100'))return fgJobs;
    throw Error('unexpected full Gate API: '+p);
  };
  const fgLog='2026-10-17T07:30:00Z '+E2E_FULL_GATE_LOG_PREFIX+
    JSON.stringify(fgReceipt)+'\n';
  const fullGate=await collectFullGateProvisionReceipts(denialRepo,fgSha,[fgRun],
    fgRequest,async()=>fgLog);
  assert.equal(fullGate.length,1);
  assert.equal(fullGate[0].at_most_one_full_stack_provision,true);
  assert.equal(fullGate[0].selector_verified,true);
  // A PR run or another SHA is not the canonical push Gate.
  assert.deepEqual(await collectFullGateProvisionReceipts(denialRepo,fgSha,
    [{...fgRun,event:'pull_request'}],fgRequest,async()=>fgLog),[]);
  assert.deepEqual(await collectFullGateProvisionReceipts(denialRepo,fgSha,
    [{...fgRun,head_sha:'6'.repeat(40)}],fgRequest,async()=>fgLog),[]);
  assert.deepEqual(await collectFullGateProvisionReceipts(denialRepo,fgSha,[fgRun],
    fgRequest,async()=>''),[]);
  assert.equal(normalizeCiEvidence({targetSha:fgSha,
    fullGateProvisionReceipts:fullGate}).e2e_full_gate_provision_receipts.length,1);

  // #1866 SC-01/SC-02: a merged target carries one pull_request, so the
  // not-required and selected proofs are reached through named ancestor SHAs.
  const ancNrSha='4'.repeat(40);
  const ancNrReceipt=makeE2eNotRequiredReceipt({env:{GITHUB_REPOSITORY:denialRepo,
    GITHUB_RUN_ID:'917',GITHUB_RUN_ATTEMPT:'1'},sha:ancNrSha,
    steps:{rust_toolchain:'skipped',cargo_build:'skipped',tmux:'skipped',
      design_gate:'success'}});
  const ancNrRun={...selRun,id:917,head_sha:ancNrSha,conclusion:'success'};
  const ancNrJobs={jobs:[{name:'e2e',id:405,run_id:917,run_attempt:1,head_sha:ancNrSha,
    status:'completed',conclusion:'success',
    steps:[{name:'Install Rust toolchain',conclusion:'skipped'},
      {name:'Build Rust binaries',conclusion:'skipped'},
      {name:'Install tmux',conclusion:'skipped'},
      {name:'Run canonical browser design gate',conclusion:'success'}]}]};
  const ancRequest=async p=>{
    if(p.endsWith('/actions/runs/917'))return ancNrRun;
    if(p.endsWith('/actions/runs/917/attempts/1/jobs?per_page=100'))return ancNrJobs;
    if(p.endsWith('/commits/'+ancNrSha+'/pulls?per_page=10'))return [];
    throw Error('unexpected ancestry API: '+p);
  };
  const ancestralRuns=async(_repo,lookup)=>lookup===ancNrSha?[ancNrRun]:[];
  const ancLog=async p=>p.endsWith('/actions/jobs/405/logs')
    ?E2E_NOT_REQUIRED_LOG_PREFIX+JSON.stringify(ancNrReceipt)+'\n':'';
  const ancestry=await collectAncestryReceipts(denialRepo,
    [{ancestor_sha:ancNrSha,is_ancestor:true},
     {ancestor_sha:'9'.repeat(40),is_ancestor:false}],
    'b'.repeat(40),ancestralRuns,ancRequest,ancLog);
  assert.equal(ancestry.length,1);
  assert.equal(ancestry[0].sha,ancNrSha);
  assert.equal(ancestry[0].e2e_not_required_receipts.length,1);
  assert.deepEqual(ancestry[0].historical_e2e_runs,[]);
  assert.deepEqual(await collectAncestryReceipts(denialRepo,
    [{ancestor_sha:ancNrSha,is_ancestor:false}],'b'.repeat(40),
    ancestralRuns,ancRequest,ancLog),[]);

  // SC-08: the equivalent-scope comparison is computed from the receipts.
  const reuseComparisonFixture=computeReuseComparison({targetSha:'b'.repeat(40),
    acceptanceBatchReceipts:[{run_id:1,sha:'b'.repeat(40),shared_ready_runtimes:1,
      cases:[{issue:1,criterion:'SC-01',isolation:'shared'},
        {issue:2,criterion:'SC-01',isolation:'shared'},
        {issue:3,criterion:'SC-01',isolation:'isolated'}]}],
    fullGateProvisionReceipts:[{provisions:1}],
    selectedRunReceipts:[{selected_ids:['login','terminal-io'],selected_count:2,
      provisioned_runtimes:1}],
    targetPushE2eRuns:[{status:'completed',conclusion:'success'}]});
  assert.equal(reuseComparisonFixture.comparisons[0].baseline_case_owned_runtimes,3);
  assert.equal(reuseComparisonFixture.comparisons[0].measured_runtimes,2);
  assert.equal(reuseComparisonFixture.comparisons[0].runtimes_saved,1);
  assert.equal(reuseComparisonFixture.full_gate_provisions,1);
  assert.equal(reuseComparisonFixture.selected_run.provisioned_runtimes,1);
  assert.equal(reuseComparisonFixture.main_push_full_e2e_success,true);
  assert.equal(computeReuseComparison({targetSha:'b'.repeat(40)}),null);

  // #1749 SC-05: a busy SHA exceeds one listing page; the oldest Gate/Provider
  // runs must still be fetched instead of reading as "never ran".
  const pageRuns=(from,count)=>Array.from({length:count},(_,i)=>({
    id:from+i,name:'Workflow '+(from+i)%7,path:'.github/workflows/w'+((from+i)%7)+'.yml',
    event:'push',status:'completed',conclusion:'success',head_sha:'a'.repeat(40),
    head_branch:'main',created_at:new Date(1700000000000+(from+i)*1000).toISOString(),
  }));
  const pages=new Map([[1,pageRuns(1,100)],[2,pageRuns(101,8)]]);
  const listedRuns=await workflowRunsForSha('BestNathan/nession','a'.repeat(40),
    async path=>{
      const match=path.match(/[?&]page=(\d+)/);
      return {workflow_runs:pages.get(match?Number(match[1]):1)??[]};
    });
  assert.equal(listedRuns.length,108);
  assert.equal((await workflowRunsForSha('BestNathan/nession','a'.repeat(40),
    async()=>({workflow_runs:pageRuns(1,3)}))).length,3);

  // Exact-head runs for an ancestor SHA named by the criterion must be reachable
  // even though `pulls` only returns PRs containing the TARGET commit.
  const ancSha='1'.repeat(40),tgtSha='2'.repeat(40),foreignRepo='attacker/x';
  const ancRuns=await collectAncestryRuns(denialRepo,[
    {ancestor_sha:ancSha,is_ancestor:true},
    {ancestor_sha:tgtSha,is_ancestor:true},
    {ancestor_sha:'4'.repeat(40),is_ancestor:false},
  ],tgtSha,async(_repo,lookup)=>lookup===ancSha?[
    {id:901,run_attempt:1,name:'CI / Quality Gate',
      path:'.github/workflows/ci-quality.yml',event:'pull_request',status:'completed',
      conclusion:'success',head_sha:ancSha,head_branch:'feature',
      repository:{full_name:denialRepo},head_repository:{full_name:denialRepo}},
    {id:902,run_attempt:1,status:'completed',conclusion:'success',head_sha:'5'.repeat(40),
      repository:{full_name:denialRepo},head_repository:{full_name:denialRepo}},
    {id:903,run_attempt:1,status:'in_progress',conclusion:null,head_sha:ancSha,
      repository:{full_name:denialRepo},head_repository:{full_name:denialRepo}},
    {id:904,run_attempt:1,status:'completed',conclusion:'success',head_sha:ancSha,
      repository:{full_name:foreignRepo},head_repository:{full_name:foreignRepo}},
    {id:905,run_attempt:0,status:'completed',conclusion:'success',head_sha:ancSha,
      repository:{full_name:denialRepo},head_repository:{full_name:denialRepo}},
  ]:[]);
  assert.equal(ancRuns.length,1,'only the verified completed same-repo ancestor run is evidence');
  assert.equal(ancRuns[0].ancestor_sha,ancSha);
  assert.equal(ancRuns[0].id,901);
  assert.equal(ancRuns[0].run_attempt,1);
  await assert.rejects(()=>collectAncestryRuns(foreignRepo,[],tgtSha,async()=>[]),
    /invalid ancestry run scope/);
  await assert.rejects(()=>collectAncestryRuns(denialRepo,[],'short',async()=>[]),
    /invalid ancestry run scope/);
  await assert.rejects(()=>collectAncestryRuns(denialRepo,
    [{ancestor_sha:ancSha,is_ancestor:true}],tgtSha,async()=>({})),
    /invalid ancestry run response/);

  // Positive rerun: original pull_request HEAD unchanged; trusted-main repair
  // is merged into exact acceptance target before attempt 3 starts.
  const reporterTarget='c'.repeat(40),reporterSource='a'.repeat(40);
  const reporterRepairMerge='b'.repeat(40);
  const witnessLine='- [ ] SC-03 Verify import fix. Historical E2E witness: PR #1716 SHA '+
    reporterSource+'; Reporter Fix PR #1724; E2E Run 38387630403 attempt 3.';
  const witness=pinnedHistoricalReporterE2eRerun(
    '## Success Criteria\n'+witnessLine+'\n## Acceptance Plan');
  assert.deepEqual(witness,{source_pr_number:1716,source_sha:reporterSource,
    repair_pr_number:1724,run_id:38387630403,run_attempt:3});
  assert.equal(pinnedHistoricalReporterE2eRerun('## Success Criteria\n- [ ] SC-03 no witness'),null);
  assert.throws(()=>pinnedHistoricalReporterE2eRerun(
    '## Success Criteria\n'+witnessLine+'\n'+witnessLine),
    /excessive/);
  const sameRepo={full_name:'BestNathan/nession'};
  const base={ref:'main',repo:sameRepo};
  const sourcePr={number:1716,state:'closed',merged_at:'2026-10-13T11:38:00Z',
    base,head:{sha:reporterSource,repo:sameRepo}};
  const repairPr={number:1724,state:'closed',merged_at:'2026-10-13T11:38:51Z',
    base,head:{sha:'d'.repeat(40),repo:sameRepo},
    merge_commit_sha:reporterRepairMerge,body:'Refs #1725'};
  const reporterRun={id:38387630403,run_attempt:3,name:'E2E / Tests',
    path:'.github/workflows/e2e-tests.yml',event:'pull_request',
    status:'completed',conclusion:'success',head_sha:reporterSource,
    repository:sameRepo,head_repository:sameRepo};
  const stepNames=['Resolve linked Issue E2E obligations','Run E2E tests',
    'Normalize selected per-file results even on failure',
    'Enforce authenticated selected-E2E execution result'];
  const reporterJob={id:115276755422,name:'e2e',
    run_id:38387630403,run_attempt:3,head_sha:reporterSource,
    status:'completed',conclusion:'success',started_at:'2026-10-13T11:39:08Z',
    steps:stepNames.map(name=>({name,status:'completed',conclusion:'success'}))};
  const fileList=[{filename:'e2e/runner/selected-report.mjs'}];
  const comparison={status:'ahead',merge_base_commit:{sha:reporterRepairMerge}};
  const verifyReporter=(a=sourcePr,b=repairPr,c=fileList,d=reporterRun,
    e={jobs:[reporterJob]},f=comparison,g=reporterTarget)=>
    attestHistoricalReporterE2eRerun(witness,a,b,c,d,e,f,g,
      'BestNathan/nession',1725);
  const proven=verifyReporter();
  assert.equal(proven.workflow_conclusion,'success');
  assert.equal(proven.steps.length,4);
  assert.equal(proven.selected_e2e_issue_receipt,'not_attested_by_this_proof');
  assert.deepEqual(normalizeCiEvidence({targetSha:reporterTarget,
    historicalReporterE2eRerun:proven}).historical_reporter_e2e_rerun,proven);
  const rejectReporter=(...variants)=>assert.throws(()=>verifyReporter(...variants),
    /unverified|predates|not proven|ambiguous/);
  rejectReporter({...sourcePr,head:{sha:'e'.repeat(40),repo:sameRepo}});
  rejectReporter(sourcePr,{...repairPr,base:{ref:'staging',repo:sameRepo}});
  rejectReporter(sourcePr,{...repairPr,body:'Refs #1999'});
  rejectReporter(sourcePr,repairPr,[]);
  rejectReporter(sourcePr,repairPr,fileList,{...reporterRun,head_sha:'e'.repeat(40)});
  rejectReporter(sourcePr,repairPr,fileList,{...reporterRun,conclusion:'failure'});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[{...reporterJob,run_attempt:2}]});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[{...reporterJob,started_at:'2026-10-13T11:38:00Z'}]});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[{...reporterJob,steps:reporterJob.steps.map(s=>
      s.name==='Normalize selected per-file results even on failure'?
        {...s,conclusion:'skipped'}:s)}]});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[reporterJob,reporterJob]});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[reporterJob]},{status:'diverged',merge_base_commit:{sha:reporterRepairMerge}});
  rejectReporter(sourcePr,repairPr,fileList,reporterRun,
    {jobs:[reporterJob]},{status:'ahead',merge_base_commit:{sha:'f'.repeat(40)}});
  assert.throws(()=>attestHistoricalReporterE2eRerun(witness,sourcePr,repairPr,
    fileList,reporterRun,{jobs:[reporterJob]},comparison,reporterTarget,
    'BestNathan/nession',1726),/unverified/);
  const pushSha='e'.repeat(40);
  const mainPush={id:38743713356,run_attempt:1,name:'E2E / Tests',
    path:'.github/workflows/e2e-tests.yml',
    event:'push',head_sha:pushSha,head_branch:'main',
    status:'completed',conclusion:'success',
    repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'}};
  const mainProof=attestTargetPushE2eRuns({workflow_runs:[mainPush]},
    pushSha,'BestNathan/nession');
  assert.equal(mainProof[0].conclusion,'success');
  assert.deepEqual(normalizeCiEvidence({targetSha:pushSha,
    directRuns:Array.from({length:40},(_,i)=>({
      id:9000+i,head_sha:pushSha,name:'Acceptance / Orchestrator',
      created_at:'2026-10-16T00:00:00Z',conclusion:'success',status:'completed'})),
    targetPushE2eRuns:mainProof}).target_push_e2e_runs,mainProof);
  const scoped=await collectTargetPushE2eRuns('BestNathan/nession',pushSha,
    async apiPath=>{
      assert.equal(apiPath,'/repos/BestNathan/nession/actions/workflows/e2e-tests.yml/runs?head_sha='+pushSha+'&event=push&per_page=5');
      return {workflow_runs:[mainPush]};
    });
  assert.deepEqual(scoped,mainProof);
  for(const bad of [
    {...mainPush,head_sha:'a'.repeat(40)},
    {...mainPush,run_attempt:0},
    {...mainPush,head_branch:'feature'},
    {...mainPush,event:'pull_request'},
    {...mainPush,name:'Acceptance / Orchestrator'},
    {...mainPush,path:'.github/workflows/other.yml'},
    {...mainPush,status:'in_progress',conclusion:'success'},
    {...mainPush,status:'completed',conclusion:null},
    {...mainPush,status:'completed',conclusion:'failure',
      repository:{full_name:'other/repo'}},
  ])assert.throws(()=>attestTargetPushE2eRuns({workflow_runs:[bad]},
    pushSha,'BestNathan/nession'),/unverified/);
  assert.throws(()=>attestTargetPushE2eRuns({workflow_runs:[mainPush,mainPush]},
    pushSha,'BestNathan/nession'),/unverified/);
  const red=attestTargetPushE2eRuns({workflow_runs:[{...mainPush,conclusion:'failure'}]},
    pushSha,'BestNathan/nession');
  assert.equal(red[0].conclusion,'failure');

  const e2eSha='a'.repeat(40);
  const run={id:38388288917,run_attempt:4,head_sha:e2eSha,
    name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml',
    event:'pull_request',status:'completed',conclusion:'failure',
    repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'}};
  const job={id:116369824499,run_id:run.id,run_attempt:4,head_sha:e2eSha,
    name:'e2e',status:'completed',steps:[
      {name:'Resolve linked Issue E2E obligations',status:'completed',conclusion:'success'},
      {name:'Run E2E tests',status:'completed',conclusion:'success'},
      {name:'Normalize selected per-file results even on failure',status:'completed',conclusion:'failure'},
      {name:'Enforce authenticated selected-E2E execution result',status:'completed',conclusion:'skipped'},
    ]};
  const attested=attestExactHeadE2eSteps(run,{jobs:[job]},e2eSha,'BestNathan/nession');
  assert.equal(attested.workflow_conclusion,'failure');
  assert.deepEqual(attested.steps.map(x=>x.conclusion),
    ['success','success','failure','skipped']);
  assert.equal(attested.run_attempt,4);
  assert.deepEqual(normalizeCiEvidence({targetSha:e2eSha,
    exactHeadE2eSteps:[attested]}).exact_head_e2e_steps,[attested]);
  for(const variant of [
    [{...run,head_sha:'b'.repeat(40)},job],
    [{...run,run_attempt:3},job],
    [{...run,status:'in_progress'},job],
    [{...run,event:'push'},job],
    [{...run,path:'different-workflow.yml'},job],
    [{...run,repository:{full_name:'other/repo'}},job],
    [run,{...job,run_id:100}],
    [run,{...job,run_attempt:3}],
    [run,{...job,head_sha:'b'.repeat(40)}],
    [run,{...job,status:'in_progress'}],
    [run,{...job,steps:job.steps.concat(job.steps[0])}],
  ]) {
    assert.throws(()=>attestExactHeadE2eSteps(variant[0],
      {jobs:[variant[1]]},e2eSha,'BestNathan/nession'),/unverified|duplicate/);
  }
  const skipped=attestExactHeadE2eSteps(run,{jobs:[{...job,
    steps:[{name:'Resolve linked Issue E2E obligations',
      status:'in_progress',conclusion:null}]}]},e2eSha,'BestNathan/nession');
  assert.deepEqual(skipped.steps,[]);
  const selected=await collectExactHeadE2eSteps('BestNathan/nession',e2eSha,
    [run,{...run,head_sha:'b'.repeat(40)},{...run,event:'push'}],
    async apiPath=>{
      assert.equal(apiPath,'/repos/BestNathan/nession/actions/runs/38388288917/attempts/4/jobs?per_page=100');
      return {jobs:[job]};
    });
  assert.deepEqual(selected,[attested]);
  const evidence = normalizeCiEvidence({
    targetSha: 'merge123',
    directRuns: [
      { id: 2, name: 'E2E Tests', head_sha: 'merge123', status: 'completed', conclusion: 'success', created_at: '2026-10-07T02:00:00Z' },
      { id: 1, name: 'stale', head_sha: 'other', status: 'completed', conclusion: 'success', created_at: '2026-10-07T03:00:00Z' },
    ],
    pulls: [{
      number: 1459,
      state: 'closed',
      merged_at: '2026-10-07T01:00:00Z',
      html_url: 'https://github.com/BestNathan/nession/pull/1459',
      base: { ref: 'staging' },
      head: { ref: 'fix/capability', sha: 'feature456' },
    }],
    pullRunsBySha: new Map([['feature456', [
      { id: 4, name: 'Quality Gate', head_sha: 'feature456', status: 'completed', conclusion: 'success', created_at: '2026-10-07T01:30:00Z' },
      { id: 3, name: 'wrong head', head_sha: 'wrong', status: 'completed', conclusion: 'success', created_at: '2026-10-07T01:40:00Z' },
    ]]]),
  });

  assert.equal(evidence.kind, 'acceptance_ci_evidence');
  assert.equal(evidence.provider_wake_evidence,null);
  assert.deepEqual(normalizeCiEvidence({targetSha:'a'.repeat(40),
    replayDenials:[{kind:'verified_metrics_replay_denial',source_run_id:22}]})
    .verified_metrics_replay_denials,[{kind:'verified_metrics_replay_denial',source_run_id:22}]);
  const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'nession-pinned-provider-evidence-'));
  try {
    const dir=path.join(fixtureRoot,'raw/workflows/agent-provider-smoke/2026-10-14');
    fs.mkdirSync(dir,{recursive:true});
    const target='a'.repeat(40);
    fs.writeFileSync(path.join(dir,'55-2-issue-1728-cursor.json'),JSON.stringify({
      kind:'agent_workflow_run',
      identity:{github_run_id:55,github_run_attempt:2,workflow_id:'agent-provider-smoke',
        repository:'BestNathan/nession',event:'push'},
      task:{target_ref:target}
    }));
    const run={id:55,run_attempt:2,name:'Agent / Provider Smoke',
      path:'.github/workflows/agent-provider-smoke.yml',event:'push',
      head_branch:'main',head_sha:target,status:'completed',conclusion:'success',
      repository:{full_name:'BestNathan/nession'},
      head_repository:{full_name:'BestNathan/nession'}};
    const pinned=verifyPinnedProviderEvidence(target,'55','2',run,fixtureRoot);
    assert.equal(pinned.durable_metrics_matches,1);
    assert.equal(normalizeCiEvidence({targetSha:target,providerWakeEvidence:pinned}).provider_wake_evidence.source_run_id,55);
    assert.throws(()=>verifyPinnedProviderEvidence(target,'55','1',run,fixtureRoot),/source is not/);
    assert.throws(()=>verifyPinnedProviderEvidence('b'.repeat(40),'55','2',run,fixtureRoot),/source is not/);
    assert.throws(()=>verifyPinnedProviderEvidence(target,'55','2',{...run,event:'pull_request'},fixtureRoot),/source is not/);
    fs.unlinkSync(path.join(dir,'55-2-issue-1728-cursor.json'));
    assert.throws(()=>verifyPinnedProviderEvidence(target,'55','2',run,fixtureRoot),/no persisted/);
  }finally{fs.rmSync(fixtureRoot,{recursive:true,force:true});}
  const implIssue={number:1759,body:'## Success Criteria\n- [ ] SC-05 Implementation PR Quality, E2E, Case and Acceptance gates pass.\n## E2E Verification\n### New\n- none'};
  assert.equal(issueRequestsImplementationGates(implIssue),true);
  assert.equal(issueRequestsImplementationGates({...implIssue,body:implIssue.body.replace('Implementation PR','test-only PR')}),false);
  const repo='BestNathan/nession',sourceUrl='https://api.github.com/repos/'+repo+'/pulls/1760';
  const timeline=[{event:'cross-referenced',source:{issue:{number:1760,
    pull_request:{url:sourceUrl}}}}];
  assert.deepEqual(selectCrossReferencedImplementationPulls(1759,timeline),[1760]);
  assert.deepEqual(selectCrossReferencedImplementationPulls(1759,[{
    ...timeline[0],source:{issue:{number:1760,pull_request:{url:'https://api.github.com/repos/foreign/repo/pulls/1760'}}}
  }]),[]);
  const merged={number:1760,state:'closed',merged_at:'2026-10-14T09:00:00Z',
    head:{sha:'a'.repeat(40),repo:{full_name:repo}},base:{ref:'main',repo:{full_name:repo}},
    merge_commit_sha:'b'.repeat(40),body:'Refs #1759'};
  const paths=IMPLEMENTATION_OWNER_PATHS.map(filename=>({filename}));
  assert.equal(eligibleImplementationPull(merged,paths,1759),true);
  assert.equal(eligibleImplementationPull({...merged,base:{ref:'staging',repo:{full_name:repo}}},paths,1759),false);
  assert.equal(eligibleImplementationPull({...merged,body:'Refs #9999'},paths,1759),false);
  assert.equal(eligibleImplementationPull({...merged,head:{...merged.head,repo:{full_name:'foreign/repo'}}},paths,1759),false);
  assert.equal(eligibleImplementationPull(merged,paths.slice(0,1),1759),false);
  const goodRuns=REQUIRED_PR_CHECKS.map((name,i)=>({
    name,id:i+101,run_attempt:1,head_sha:'a'.repeat(40),
    status:'completed',conclusion:'success',
    event:name==='Acceptance / Orchestrator'?'pull_request_target':'pull_request',
    html_url:'https://github.com/BestNathan/nession/actions/runs/'+(101+i),
  }));
  const gateJobs=['pre-merge-gate','acceptance-pr-gate'].map(name=>({name,conclusion:'success'}));
  assert.equal(exactImplementationGateBundle(goodRuns,'a'.repeat(40),gateJobs).all_passed,true);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>
    x.name==='Acceptance / Orchestrator'?{...x,event:'pull_request'}:x),
    'a'.repeat(40),gateJobs).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>x.name==='E2E / Tests'?{...x,conclusion:'failure'}:x),
    'a'.repeat(40),gateJobs).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns,'a'.repeat(40),
    [{name:'pre-merge-gate',conclusion:'success'}]).all_passed,false);
  assert.equal(exactImplementationGateBundle(goodRuns.map(x=>({...x,head_sha:'c'.repeat(40)})),
    'a'.repeat(40),gateJobs).all_passed,false);

  assert.equal(evidence.target_sha, 'merge123');
  assert.deepEqual(evidence.direct_runs.map((run) => run.id), [2]);

  // #1858: an early push-triggered Gate run must survive an over-cap SHA, and
  // any remaining truncation must be reported rather than read as absence.
  const capSha = 'd'.repeat(40);
  const capRun = (id, workflowPath, createdAt) => ({id, path: workflowPath, event: 'push',
    status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: capSha,
    html_url: 'https://example.invalid/' + id, created_at: createdAt, updated_at: createdAt});
  const capRuns = [
    capRun(1, '.github/workflows/ci-run-store-fixture-evidence.yml', '2026-10-16T00:00:00Z'),
    ...Array.from({length: 24}, (_, i) => capRun(i + 2,
      '.github/workflows/noise-' + (i % 3) + '.yml',
      '2026-10-16T01:' + String(i).padStart(2, '0') + ':00Z')),
  ];
  const capBundle = normalizeCiEvidence({targetSha: capSha, directRuns: capRuns});
  assert.ok(capBundle.direct_runs.some((run) => run.id === 1),
    'the earliest push Gate run must not be truncated away');
  assert.equal(capBundle.direct_runs_dropped, capRuns.length - capBundle.direct_runs.length);
  assert.ok(capBundle.direct_runs_dropped > 0,
    'an over-cap SHA must report dropped runs instead of hiding them');
  // A path whose newest run is the evaluator's own in-progress run must still
  // expose that path's newest COMPLETED run at the same SHA.
  const liveSha='e'.repeat(40);
  const liveRun=(id,status,conclusion,createdAt)=>({
    id,path:'.github/workflows/agent-provider-smoke.yml',event:'push',status,conclusion,
    head_branch:'main',head_sha:liveSha,html_url:'https://example.invalid/'+id,
    created_at:createdAt,updated_at:createdAt});
  const liveBundle=normalizeCiEvidence({targetSha:liveSha,directRuns:[
    liveRun(10,'completed','success','2026-10-17T00:00:00Z'),
    liveRun(11,'in_progress',null,'2026-10-17T01:00:00Z'),
  ]});
  const liveIds=liveBundle.direct_runs.map(run=>run.id);
  assert.ok(liveIds.includes(10),
    'the newest completed run of a path must survive an in-progress successor');
  assert.ok(liveIds.includes(11));
  assert.deepEqual(evidence.pull_requests[0].runs.map((run) => run.id), [4]);
  const lineage = normalizeCiEvidence({
    targetSha: 'c'.repeat(40),
    pulls: [{number: 5, head: {sha: 'c'.repeat(40)}}],
    historicalE2EByPr: new Map([[5,[{run_id:2,results:[{id:'login',result:'Fail'}]}]]]),
  });
  assert.equal(lineage.pull_requests[0].historical_e2e_runs[0].run_id, 2);
  assert.deepEqual(normalizeCiEvidence({targetSha:'c'.repeat(40),linkedIssueE2E:[{
    pr_number:1718,verified_selected_runs:[{run_id:10}],verified_staging_full:null,
  }]}).linked_issue_e2e_evidence.map(x=>x.pr_number),[1718]);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Requirement: projection receipts (#1702)',
    body:'Child of #1702; verified on parent Issue.'}),1702);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1703)',body:'Child of #1702'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1759)',body:'Child of #1759'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#1702)',body:'Not a child'}),null);
  assert.equal(parentEvidenceDiscovery({number:1759,
    title:'Issue (#xyz)',body:'Child of #1702'}),null);
  assert.throws(() => normalizeCiEvidence({ targetSha: '' }), /targetSha is required/);
  // Real criteria select only pinned source SHA ancestors; unrelated report
  // logs cannot inject extra proof targets.
  const left = 'a'.repeat(40), right = 'b'.repeat(40), head = 'c'.repeat(40);
  assert.deepEqual(requestedAncestorsFromIssue(
    '### Success Criteria\n- [ ] SC-01 Exact ' + left + ' and ' + right +
    ' are ancestors of the merge commit.\n## Acceptance Report\n' +
    '- [ ] SC-99 fake ' + head + ' ancestors'), [left, right]);
  assert.deepEqual(requestedAncestorsFromIssue('### Success Criteria\n- [ ] SC-02 No Git ancestry claim.'), []);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 0})).is_ancestor, true);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 1})).is_ancestor, false);
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({status: 128})).status, 'unknown-object-or-error');
  assert.equal(checkGitAncestor('/tmp', head, left,
    () => ({error: new Error('git unavailable'), status: null})).is_ancestor, false);
  assert.throws(() => checkGitAncestor('/tmp', 'not-a-sha', left), /40-character SHAs/);
  assert.throws(() => requestedAncestorsFromIssue('### Success Criteria\n- [ ] SC-01 ' +
    Array.from({length: 9}, (_, i) => String(i).repeat(40)).join(' ') +
    ' are ancestors'), /excessive/);
  assert.deepEqual(normalizeCiEvidence({targetSha:head, sourceAncestry:[
    checkGitAncestor('/tmp', head, left, () => ({status:0})),
  ]}).source_ancestry.map(x => x.is_ancestor), [true]);

  const parentA='d'.repeat(40),parentB='e'.repeat(40);
  const mergeGit=()=>({status:0,stdout:head+' '+parentA+' '+parentB+'\n'});
  const mergeProof=checkGitMergeCommit('/tmp',head,[parentB],mergeGit);
  assert.deepEqual(mergeProof.parents,[parentA,parentB]);
  assert.equal(mergeProof.status,'verified');
  assert.equal(mergeProof.is_ordinary_merge,true);
  assert.equal(mergeProof.second_parent_matches_declared_source,true);
  // The main target may advance; a prior reachable merge retains its own
  // independently verifiable two-parent Git object identity.
  const historicalMerge=checkGitMergeCommit('/tmp',parentA,[parentB],
    ()=>({status:0,stdout:parentA+' '+left+' '+parentB+'\n'}));
  assert.equal(historicalMerge.target_sha,parentA);
  assert.deepEqual(historicalMerge.parents,[left,parentB]);
  assert.equal(historicalMerge.is_ordinary_merge,true);
  assert.equal(historicalMerge.second_parent_matches_declared_source,true);
  assert.equal(normalizeCiEvidence({targetSha:head,
    targetMergeProof:mergeProof,declaredMergeCommits:[mergeProof]})
    .declared_merge_commits[0].second_parent_sha,parentB);
  assert.equal(checkGitMergeCommit('/tmp',head,[left],mergeGit)
    .second_parent_matches_declared_source,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:head+' '+parentA+'\n'})).is_ordinary_merge,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:head+' '+parentA+' '+parentB+' '+left+'\n'}))
    .is_ordinary_merge,false);
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:0,stdout:'wrong-object '+parentA+' '+parentB+'\n'}))
    .status,'unknown-object-or-error');
  assert.equal(checkGitMergeCommit('/tmp',head,[parentB],
    ()=>({status:128,stdout:''})).is_ordinary_merge,false);
  assert.throws(()=>checkGitMergeCommit('/tmp','bad',[parentB]),/40-character/);

  const exact={id:38573830595,run_attempt:1,
    repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'},
    path:'.github/workflows/acceptance-orchestrator.yml',
    name:'Acceptance / Orchestrator',event:'push',head_branch:'main',
    head_sha:head,status:'completed',conclusion:'success'};
  assert.deepEqual(pinnedHistoricalOrchestratorIds(
    '### Success Criteria\n- [ ] SC-04 earlier Acceptance / Orchestrator Run `38573830595` completed\n## Acceptance Report'
  ),[38573830595]);
  assert.deepEqual(pinnedHistoricalOrchestratorIds(
    '### Success Criteria\n- [ ] SC-04 vague run 38573830595'
  ),[]);
  assert.equal(attestHistoricalOrchestrator(exact,head,exact.id,'BestNathan/nession').id,
    exact.id);
  for(const forged of [
    {...exact,conclusion:'failure'},
    {...exact,head_sha:left},
    {...exact,event:'workflow_dispatch'},
    {...exact,repository:{full_name:'foreign/repo'}},
    {...exact,run_attempt:0},
    {...exact,status:'in_progress'},
  ])assert.throws(()=>attestHistoricalOrchestrator(
    forged,head,exact.id,'BestNathan/nession'),/invalid historical/);
  assert.deepEqual(normalizeCiEvidence({targetSha:head,historicalAncestry:[
    checkGitAncestor('/tmp',parentA,left,()=>({status:0}))],
    historicalOrchestratorRuns:[attestHistoricalOrchestrator(exact,head,exact.id,
      'BestNathan/nession')],
  }).historical_merge_ancestry.map(p=>[p.target_sha,p.ancestor_sha,p.is_ancestor]),
    [[parentA,left,true]]);


  const sc='### Success Criteria\n- [ ] SC-04 in a real main run, #1715 SC-02/SC-04; '+
    'Historical evidence discovery constraint: main merge '+head+
    ' is an ancestor; Acceptance / Orchestrator Run `38397558926` attempt 2; '+
    'after Source Provider Run `38397558713` and Metrics Ingest Run `38397651981` completed.\n## Acceptance Report';
  const pins=pinnedHistoricalProviderChains(sc)[0];
  assert.equal(pins.issue_number,1715);
  assert.equal(pins.orchestrator_attempt,2);
  assert.deepEqual(pinnedHistoricalProviderChains('### Success Criteria\n- [ ] SC-01 no pins'),[]);
  assert.throws(()=>pinnedHistoricalProviderChains(sc.replace('Metrics Ingest Run','Untrusted Run')),
    /incomplete historical/);
  const sourceMeta={repository:{full_name:'BestNathan/nession'},
    head_repository:{full_name:'BestNathan/nession'},head_sha:head,
    head_branch:'main',status:'completed',conclusion:'success',run_attempt:1};
  const provider={...sourceMeta,id:pins.provider_run_id,
    name:'Agent / Provider Smoke',path:'.github/workflows/agent-provider-smoke.yml',
    event:'push',updated_at:'2026-10-13T12:29:20Z'};
  const metrics={...sourceMeta,id:pins.metrics_run_id,
    name:'Metrics / Agent Telemetry Ingest',path:'.github/workflows/metrics-agent-telemetry.yml',
    event:'workflow_run',run_started_at:'2026-10-13T12:29:23Z',
    updated_at:'2026-10-13T12:29:46Z'};
  const orchestration={...sourceMeta,id:pins.orchestrator_run_id,run_attempt:2,
    name:'Acceptance / Orchestrator',path:'.github/workflows/acceptance-orchestrator.yml',
    event:'push',run_started_at:'2026-10-13T12:35:47Z'};
  const validJobs={jobs:[
    {id:1,name:'merged-agent-acceptance (1715) / Execute acceptance',
      status:'completed',conclusion:'success',started_at:'2026-10-13T12:35:50Z'},
    {id:2,name:'merged-agent-acceptance (1715) / Deterministic Issue updater',
      status:'completed',conclusion:'success',started_at:'2026-10-13T12:37:50Z'},
  ]};
  const proof=attestHistoricalProviderChain(pins,provider,metrics,orchestration,
    validJobs,new Set([head]));
  assert.equal(proof.verified_order,true);
  assert.equal(proof.accepted_jobs.length,2);
  assert.deepEqual(normalizeCiEvidence({targetSha:head,historicalProviderChains:[proof]})
    .historical_provider_chains.map(x=>x.target_sha),[head]);
  const reject=(p,m,a,j,shas=new Set([head]))=>
    assert.throws(()=>attestHistoricalProviderChain(pins,p,m,a,j,shas),/historical/);
  reject(provider,metrics,orchestration,validJobs,new Set([left]));
  reject({...provider,event:'pull_request'},metrics,orchestration,validJobs);
  reject(provider,{...metrics,head_sha:left},orchestration,validJobs);
  reject(provider,{...metrics,updated_at:'2026-10-13T12:36:00Z'},orchestration,validJobs);
  reject(provider,metrics,{...orchestration,run_attempt:1},validJobs);
  reject(provider,metrics,orchestration,{jobs:validJobs.jobs.slice(0,1)});
  reject(provider,metrics,orchestration,{jobs:validJobs.jobs.map(x=>({...x,started_at:'2026-10-13T12:29:00Z'}))});
  reject(provider,metrics,orchestration,{jobs:validJobs.jobs.map(x=>({...x,conclusion:'failure'}))});

  selfTestCiCostStudy();
  selfTestHistoricalBrowserDesign();
  selfTestHistoricalCase();
  selfTestHistoricalRecovery();
  selfTestCaseReceipts();
  assert.deepEqual(normalizeCiEvidence({targetSha:head, verifiedCaseReceipts:[{changed_records:2}]}).verified_case_receipts,[{changed_records:2}]);
  console.log('acceptance-ci-evidence self-test: historical Case, authenticated receipt, reporter history and negative ancestry passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'collect') {
    const workspace = process.argv[3];
    const outFile = process.argv[4];
    if (!workspace || !outFile) throw new Error('usage: acceptance-ci-evidence.mjs collect WORKSPACE OUT');
    return collectCommand(workspace, outFile);
  }
  throw new Error('usage: acceptance-ci-evidence.mjs <self-test|collect WORKSPACE OUT>');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
