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
import {parseReplayDenialLog,attestReplayDenial} from './metrics-replay-denial-receipt.mjs';
import {historicalCaseEvidence,selfTestHistoricalCase} from './acceptance-historical-case-replay.mjs';
import { collectAuthenticatedCaseReadbacks, selfTestCaseReceipts } from './acceptance-case-readback-evidence.mjs';
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

function compactRuns(runs, expectedSha) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => String(run?.head_sha ?? '') === expectedSha)
    .map(compactRun)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, MAX_RUNS_PER_SHA);
}

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [], historicalE2EByPr = new Map(), linkedIssueE2E = [], implementationPulls = [], targetMergeProof = null, declaredMergeCommits = [], providerWakeEvidence = null, historicalAncestry = [], historicalOrchestratorRuns = [], historicalProviderChains = [], exactHeadE2eSteps = [], historicalReporterE2eRerun = null, verifiedHistoricalCaseReplays = [], verifiedCaseReceipts = [], relatedAcceptance = [], relatedBugCompletion = null, targetPushE2eRuns = [], postE2eWakeReceipts = [], replayDenials = [] }) {
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
        historical_e2e_runs: historicalE2EByPr.get(Number(pull.number)) ?? [],
      };
    });

  return {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: sha,
    direct_runs: compactRuns(directRuns, sha),
    verified_metrics_replay_denials: replayDenials,
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
    evidence.push(attestReplayDenial(receipt,source,recipient,jobs));
  }
  return evidence;
}

async function githubJobLog(path){
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)throw Error('historical Case read requires GitHub token');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('GitHub historical Case logs HTTP '+response.status);
  const body=await response.text();
  if(body.length>=1048576)throw Error('historical Case log too large');
  return body;
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

async function workflowRunsForSha(repo, sha) {
  const query = new URLSearchParams({ head_sha: sha, per_page: '100' });
  const payload = await githubGet('/repos/' + repo + '/actions/runs?' + query.toString());
  return payload.workflow_runs ?? [];
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
  const targetPushE2eRuns=process.env.ACCEPTANCE_STAGE==='post-merge'
    ? await collectTargetPushE2eRuns(repo,sha) : [];
  // A post-E2E Agent cannot prove its own Waker has completed. Read the
  // bounded, exact-attempt, SHA256-bound prior cycle independently instead.
  const postE2eWakeReceipts=process.env.ACCEPTANCE_STAGE==='post-merge'&&
    String(process.env.ISSUE_NUMBER??'')==='1850'
    ? await collectE2eWakeReceipts({repo,sha,issue:1850,get:githubGet,getText:githubJobLog}) : [];
  // Independently bound Git-byte Case receipts only, never green no-op success.
  const verifiedCaseReceipts = process.env.ACCEPTANCE_STAGE === 'post-merge'
    ? await collectAuthenticatedCaseReadbacks({repo,targetSha:sha,runs:directRuns,request:githubGet})
    : [];
  const issueNumberForReplay=String(process.env.ISSUE_NUMBER||'');
  const replayIssue=process.env.ACCEPTANCE_STAGE==='post-merge'&&
    /^[1-9][0-9]*$/.test(issueNumberForReplay)
    ? await githubGet('/repos/'+repo+'/issues/'+issueNumberForReplay) : null;
  const verifiedHistoricalCaseReplays=replayIssue ? await historicalCaseEvidence({
    repo,target:sha,body:replayIssue.body,get:githubGet,getText:githubJobLog,
  }) : [];
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
  const sourceAncestry = await collectSourceAncestry(repo, workspace, sha);
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
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls,
    pullRunsBySha, sourceAncestry, historicalE2EByPr, linkedIssueE2E, implementationPulls, targetMergeProof, declaredMergeCommits, providerWakeEvidence, historicalAncestry, historicalOrchestratorRuns, historicalProviderChains, exactHeadE2eSteps, historicalReporterE2eRerun, verifiedHistoricalCaseReplays, verifiedCaseReceipts, relatedAcceptance, relatedBugCompletion, targetPushE2eRuns, postE2eWakeReceipts, replayDenials });
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'collected acceptance CI evidence for ' + sha +
    ': ' + evidence.direct_runs.length + ' direct run(s), ' +
    evidence.pull_requests.length + ' associated PR(s)'
  );
}

async function selfTest() {

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

  selfTestHistoricalCase();
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
