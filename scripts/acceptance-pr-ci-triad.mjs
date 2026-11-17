#!/usr/bin/env node
// Trusted-main PR Acceptance readback for criteria explicitly requiring the
// Quality + E2E + Case Smoke CI triad. GitHub observations are the only proof;
// issue prose, an agent assertion and a green unrelated commit are not.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/i;
const CHECKS = Object.freeze([
  { key: 'quality', workflow: 'ci-quality.yml', path: '.github/workflows/ci-quality.yml',
    name: 'CI / Quality Gate', job: 'tooling-check',
    steps: ['Verify repository tooling Gates'] },
  { key: 'e2e', workflow: 'e2e-tests.yml', path: '.github/workflows/e2e-tests.yml',
    name: 'E2E / Tests', job: 'e2e',
    steps: ['Resolve linked Issue E2E obligations', 'Run E2E tests',
      'Enforce authenticated selected-E2E execution result'] },
  { key: 'case_smoke', workflow: 'acceptance-case-smoke.yml',
    path: '.github/workflows/acceptance-case-smoke.yml',
    name: 'Acceptance / Case Smoke', job: 'case-smoke',
    steps: ['Validate canonical Case contracts and generic selection',
      'Select PR-linked Case-method proofs'] },
]);

const positive = value => Number.isSafeInteger(value) && value > 0;

export function requiresPrCiTriadCriterion(criterion) {
  const text = String(criterion?.text ?? '');
  return /\bQuality\b/i.test(text) && /\bE2E\b/i.test(text) &&
    /\bCase Smoke\b/i.test(text) && /\b(?:pass|passes|passed|succeed|succeeds)\b/i.test(text);
}

export function requiresPrCiTriad(context) {
  return context?.stage === 'pr' &&
    (context.criteria ?? []).some(requiresPrCiTriadCriterion);
}

function matchingRun(spec, sha, payload) {
  if (!Array.isArray(payload?.workflow_runs)) return null;
  return payload.workflow_runs.filter(run =>
    run?.name === spec.name &&
    run.path === spec.path &&
    run.event === 'pull_request' &&
    run.head_sha === sha &&
    run.repository?.full_name === REPO &&
    run.head_repository?.full_name === REPO &&
    positive(run.id) && positive(run.run_attempt)
  ).sort((a,b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
    b.id - a.id)[0] ?? null;
}

function attestCheck(spec, sha, observation) {
  const run = matchingRun(spec, sha, observation?.runs);
  if (!run) return { status:'pending', reason:spec.key + ' authenticated exact-head PR run missing' };
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return { status:run.status === 'completed' ? 'fail' : 'pending',
      reason:spec.key + ' run is ' + run.status + '/' + String(run.conclusion ?? 'pending') };
  }
  const payload = observation?.jobs;
  if (!Array.isArray(payload?.jobs) || payload.total_count > 100 ||
      payload.jobs.length > 100) {
    return { status:'pending', reason:spec.key + ' exact-attempt jobs unavailable/incomplete' };
  }
  const candidates = payload.jobs.filter(job => job?.name === spec.job);
  if (candidates.length !== 1) {
    return { status:'pending', reason:spec.key + ' expected job missing or ambiguous' };
  }
  const job = candidates[0];
  if (job.run_id !== run.id || (job.run_attempt != null &&
      job.run_attempt !== run.run_attempt)) {
    return { status:'pending', reason:spec.key + ' job run/attempt mismatch' };
  }
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    return { status:job.status === 'completed' ? 'fail' : 'pending',
      reason:spec.key + ' job is ' + job.status + '/' + String(job.conclusion ?? 'pending') };
  }
  if (!positive(job.id) || !Array.isArray(job.steps) ||
      !spec.steps.every(step => job.steps.filter(s => s.name === step &&
        s.status === 'completed' && s.conclusion === 'success').length === 1)) {
    return { status:'pending', reason:spec.key + ' required job steps not proven successful' };
  }
  return { status:'pass', check:{
    key:spec.key, workflow:spec.path, run_id:run.id,
    run_attempt:run.run_attempt, job_id:job.id, required_steps:[...spec.steps],
  }};
}

export function attestPrCiTriad(sha, observations) {
  if (!SHA.test(String(sha))) throw Error('exact PR head SHA required');
  const checks = [];
  for (const spec of CHECKS) {
    const result = attestCheck(spec, sha, observations?.[spec.key]);
    if (result.status !== 'pass') return result;
    checks.push(result.check);
  }
  return { status:'pass', receipt:{
    kind:'pr_ci_triad_execution_v1', repository:REPO,
    head_sha:sha, checks,
  }};
}

export function validPrCiTriadReceipt(receipt, sha) {
  if (!receipt || receipt.kind !== 'pr_ci_triad_execution_v1' ||
      receipt.repository !== REPO || !SHA.test(String(sha)) ||
      receipt.head_sha !== sha || !Array.isArray(receipt.checks) ||
      receipt.checks.length !== CHECKS.length) return false;
  return CHECKS.every(spec => {
    const items = receipt.checks.filter(x => x.key === spec.key);
    return items.length === 1 && items[0].workflow === spec.path &&
      positive(items[0].run_id) && positive(items[0].run_attempt) &&
      positive(items[0].job_id) &&
      JSON.stringify(items[0].required_steps) === JSON.stringify(spec.steps);
  });
}

function githubJson(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding:'utf8', timeout:20000, stdio:['ignore','pipe','pipe'],
  }));
}

export function collectPrCiTriad(sha, request=githubJson) {
  if (!SHA.test(String(sha))) throw Error('exact PR head SHA required');
  try {
    const observations = {};
    for (const spec of CHECKS) {
      const query = new URLSearchParams({
        head_sha:sha, event:'pull_request', per_page:'25',
      });
      const runs = request('/repos/' + REPO + '/actions/workflows/' +
        spec.workflow + '/runs?' + query.toString());
      const selected = matchingRun(spec, sha, runs);
      const jobs = selected && selected.status === 'completed' && selected.conclusion === 'success'
        ? request('/repos/' + REPO + '/actions/runs/' + selected.id +
          '/attempts/' + selected.run_attempt + '/jobs?per_page=100') : null;
      observations[spec.key] = {runs,jobs};
    }
    return attestPrCiTriad(sha, observations);
  } catch (error) {
    console.error('Trusted PR Quality/E2E/Case Smoke readback failed:',
      error instanceof Error ? error.message : String(error));
    return {status:'pending',reason:'authenticated exact-head PR CI triad unavailable'};
  }
}

export function enforcePrCiTriad(context, result) {
  if (context.stage !== 'pr') return result;
  const required = new Set((context.criteria ?? [])
    .filter(requiresPrCiTriadCriterion).map(c => c.criterion));
  if (!required.size) return result;
  const source = context.pr_ci_triad;
  const valid = source?.status === 'pass' &&
    validPrCiTriadReceipt(source.receipt, context.target_ref);
  return {...result,criteria:result.criteria.map(item => {
    if (!required.has(item.criterion) || item.result !== 'Pass') return item;
    if (!valid) return {...item,result:'Pending',
      summary:'Authenticated exact-head PR Quality/E2E/Case Smoke CI not verified: ' +
        String(source?.reason ?? 'missing source-bound receipt').slice(0,200),
      evidence:[{type:'quality-gate', value:'Pending: Quality/E2E/Case Smoke receipt at '+
        context.target_ref}]};
    return {...item,evidence:[...item.evidence, ...source.receipt.checks.map(c => ({
      type:'quality-gate',value:c.key + ' workflow run ' + c.run_id + '/' +
      c.run_attempt + ' job ' + c.job_id + ' exact HEAD ' + context.target_ref,
    }))]};
  })};
}

export function selfTestPrCiTriad() {
  const sha='a'.repeat(40);
  const observations={};
  for (let i=0;i<CHECKS.length;i++) {
    const spec=CHECKS[i], id=100+i;
    const run={id,run_attempt:1,name:spec.name,path:spec.path,
      event:'pull_request',head_sha:sha,repository:{full_name:REPO},
      head_repository:{full_name:REPO},created_at:'2026-11-15T12:00:00Z',
      status:'completed',conclusion:'success'};
    observations[spec.key]={runs:{workflow_runs:[run]},
      jobs:{total_count:1,jobs:[{id:200+i,run_id:id,run_attempt:1,
        name:spec.job,status:'completed',conclusion:'success',
        steps:spec.steps.map(name=>({name,status:'completed',conclusion:'success'}))}]}};
  }
  const pass=attestPrCiTriad(sha,observations);
  assert.equal(pass.status,'pass');
  assert.ok(validPrCiTriadReceipt(pass.receipt,sha));
  assert.equal(validPrCiTriadReceipt(pass.receipt,'b'.repeat(40)),false);
  assert.equal(requiresPrCiTriad({stage:'pr',criteria:[{
    criterion:'SC-03',text:'Source-bound Quality / E2E / Case Smoke tests pass on the repair PR',
  }]}),true);
  assert.equal(requiresPrCiTriad({stage:'staging',criteria:[{
    text:'Quality / E2E / Case Smoke tests pass',
  }]}),false);
  const forged=structuredClone(observations);
  forged.e2e.runs.workflow_runs[0].event='push';
  assert.equal(attestPrCiTriad(sha,forged).status,'pending');
  const stale=structuredClone(observations);
  stale.quality.runs.workflow_runs[0].head_sha='b'.repeat(40);
  assert.equal(attestPrCiTriad(sha,stale).status,'pending');
  const failed=structuredClone(observations);
  failed.case_smoke.jobs.jobs[0].conclusion='failure';
  assert.equal(attestPrCiTriad(sha,failed).status,'fail');
  const skipped=structuredClone(observations);
  skipped.e2e.jobs.jobs[0].steps[1].conclusion='skipped';
  assert.equal(attestPrCiTriad(sha,skipped).status,'pending');
  const ctx={stage:'pr',target_ref:sha,criteria:[{
    criterion:'SC-03',text:'Quality E2E Case Smoke tests pass',
  }],pr_ci_triad:{status:'pending',reason:'missing'}};
  const result={criteria:[{criterion:'SC-03',result:'Pass',
    evidence:[{type:'test',value:'claimed'}],summary:'claimed'}]};
  assert.equal(enforcePrCiTriad(ctx,result).criteria[0].result,'Pending');
  ctx.pr_ci_triad=pass;
  assert.equal(enforcePrCiTriad(ctx,result).criteria[0].result,'Pass');
  return true;
}
