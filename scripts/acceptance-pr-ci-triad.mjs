#!/usr/bin/env node
// Trusted-main PR Acceptance readback for criteria explicitly requiring the
// Quality + E2E + Case Smoke CI triad. GitHub observations are the only proof;
// issue prose, an agent assertion and a green unrelated commit are not.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {validPagesMigrationReceipt}
  from './acceptance-pr-pages-migration-evidence.mjs';

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
      'Select PR-linked Case-method proofs (trusted main policy)'] },
]);

const VISUAL_CHECKS = Object.freeze([
  { key:'web_design', workflow:'ci-quality.yml', path:'.github/workflows/ci-quality.yml',
    name:'CI / Quality Gate', job:'web-tests', steps:['Verify Web and design Gates'] },
  { key:'browser_design', workflow:'e2e-tests.yml', path:'.github/workflows/e2e-tests.yml',
    name:'E2E / Tests', job:'e2e',
    steps:['Verify canonical browser design gate from the single E2E run'] },
]);
const checksFor = visual => visual ? [...CHECKS, ...VISUAL_CHECKS] : CHECKS;
const positive = value => Number.isSafeInteger(value) && value > 0;

export function requiresPrVisualEvidenceCriterion(criterion) {
  // A deterministic report-tooling Gate ID is not a product visual assertion.
  // Keep the rest of the criterion intact: an explicit visual obligation still applies.
  const text = String(criterion?.text ?? '').replace(/\be2e-browser-report-selftest\b/gi, ' ');
  return /\b(?:browser|viewport)\b/i.test(text) &&
    /\b(?:Quality|CI|Gate)\b/i.test(text) &&
    /\b(?:exact|source-aligned)\b/i.test(text) &&
    /\b(?:PR|head)\b/i.test(text);
}

export function requiresPrCiTriadCriterion(criterion) {
  const text = String(criterion?.text ?? '');
  return requiresPrVisualEvidenceCriterion(criterion) ||
    (/\bQuality\b/i.test(text) && /\bE2E\b/i.test(text) &&
      /\bCase Smoke\b/i.test(text) && /\b(?:pass|passes|passed|succeed|succeeds)\b/i.test(text));
}

export function requiresPrCiTriad(context) {
  return context?.stage === 'pr' &&
    (context.criteria ?? []).some(requiresPrCiTriadCriterion);
}

// #4448: a criterion that explicitly names the standalone CI / Pages lane is
// proven by the trusted Pages migration receipt, not by the product E2E
// browser_design job (which is correctly not-required for Pages-only work).
export function isPagesMigrationCriterion(criterion) {
  const text = String(criterion?.text ?? '');
  return /\bCI \/ Pages\b/i.test(text) || /\bPages (?:browser|parity)\b/i.test(text);
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

export function attestPrCiTriad(sha, observations, {visual=false}={}) {
  if (!SHA.test(String(sha))) throw Error('exact PR head SHA required');
  const checks = [];
  for (const spec of checksFor(visual)) {
    const result = attestCheck(spec, sha, observations?.[spec.key]);
    if (result.status !== 'pass') return result;
    checks.push(result.check);
  }
  return { status:'pass', receipt:{
    kind:'pr_ci_triad_execution_v1', repository:REPO,
    head_sha:sha, ...(visual ? {variant:'visual'} : {}), checks,
  }};
}

export function validPrCiTriadReceipt(receipt, sha) {
  if (!receipt || receipt.kind !== 'pr_ci_triad_execution_v1' ||
      receipt.repository !== REPO || !SHA.test(String(sha)) ||
      receipt.head_sha !== sha || !Array.isArray(receipt.checks) ||
      ![undefined,'visual'].includes(receipt.variant) ||
      receipt.checks.length !== checksFor(receipt.variant === 'visual').length) return false;
  return checksFor(receipt.variant === 'visual').every(spec => {
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

export function collectPrCiTriad(sha, request=githubJson, {visual=false}={}) {
  if (!SHA.test(String(sha))) throw Error('exact PR head SHA required');
  try {
    const observations = {};
    for (const spec of checksFor(visual)) {
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
    return attestPrCiTriad(sha, observations, {visual});
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
  const needsVisual = (context.criteria ?? []).some(c =>
    required.has(c.criterion) && requiresPrVisualEvidenceCriterion(c));
  const valid = source?.status === 'pass' &&
    (!needsVisual || source.receipt?.variant === 'visual') &&
    validPrCiTriadReceipt(source.receipt, context.target_ref);
  const pages = validPagesMigrationReceipt(context.pr_pages_migration?.receipt,
    context.target_ref) ? context.pr_pages_migration.receipt : null;
  const pagesCriteria = new Set((context.criteria ?? [])
    .filter(isPagesMigrationCriterion).map((criterion) => criterion.criterion));
  return {...result,criteria:result.criteria.map(item => {
    if (!required.has(item.criterion) || item.result !== 'Pass') return item;
    if (!valid) {
      if (pages && pagesCriteria.has(item.criterion)) {
        return {...item,evidence:[...item.evidence,{type:'pages-ci',
          value:'CI / Pages run ' + pages.pages_run.id + '/' +
            pages.pages_run.run_attempt + ' exact HEAD ' + context.target_ref +
            '; parity artifact ' + pages.parity_artifact.id + ' sha256 ' +
            pages.parity_artifact.sha256}]};
      }
      return {...item,result:'Pending',
        summary:'Authenticated exact-head PR Quality/E2E/Case Smoke CI not verified: ' +
          String(source?.reason ?? 'missing source-bound receipt').slice(0,200),
        evidence:[{type:'quality-gate', value:'Pending: Quality/E2E/Case Smoke receipt at '+
          context.target_ref}]};
    }
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
  const web4050 = 'Source-aligned Quality/Gate checks succeed at the exact PR head; existing UI/browser checks remain green';
  const web4061 = 'Browser design/viewport checks confirm no regression; exact-PR-head CI and Case evidence required';
  assert.equal(requiresPrVisualEvidenceCriterion({text:web4050}),true);
  assert.equal(requiresPrVisualEvidenceCriterion({text:web4061}),true);
  assert.equal(requiresPrVisualEvidenceCriterion({text:'normal prose without CI proof'}),false);
  // #4700: the original release-gate criterion is tooling-only, despite the Gate ID.
  const release4576 = "`main-full-release-gate.mjs` accepts exact-Main-SHA Full runs with `push` or `workflow_dispatch` events as release receipts, and still rejects `schedule` runs, wrong SHA/branch/repo, and non-successful or attestation-incomplete runs — proven by the script self-test (including the new dispatch positive and negative fixtures) and the owning `e2e-browser-report-selftest` Gate at the exact PR head.";
  for (const text of [release4576, release4576.replaceAll('\x60', ''),
    'Run E2E-BROWSER-REPORT-SELFTEST Gate at the exact PR head']) {
    assert.equal(requiresPrVisualEvidenceCriterion({text}),false);
    assert.equal(requiresPrCiTriad({stage:'pr',criteria:[{text}]}),false);
    assert.equal(requiresPrVisualEvidenceCriterion({text:text+'; browser design checks remain green'}),true);
  }
  assert.equal(requiresPrCiTriad({stage:'pr',criteria:[{
    text:release4576+'; Quality / E2E / Case Smoke tests pass',
  }]}),true);

  assert.equal(requiresPrCiTriad({stage:'pr',criteria:[{criterion:'SC-03',text:web4050}]}),true);
  assert.equal(requiresPrCiTriad({stage:'pr',criteria:[{criterion:'SC-04',text:web4061}]}),true);
  const visualObservations=structuredClone(observations);
  for (const spec of VISUAL_CHECKS) {
    const run={...observations.quality.runs.workflow_runs[0],
      id:spec.key === 'web_design' ? 400 : 401,
      name:spec.name,path:spec.path};
    visualObservations[spec.key]={runs:{workflow_runs:[run]},
      jobs:{total_count:1,jobs:[{id:spec.key === 'web_design' ? 500 : 501,
        run_id:run.id,run_attempt:1,name:spec.job,
        status:'completed',conclusion:'success',
        steps:spec.steps.map(name=>({name,status:'completed',conclusion:'success'}))}]}};
  }
  const visual=attestPrCiTriad(sha,visualObservations,{visual:true});
  assert.equal(visual.status,'pass');
  assert.equal(visual.receipt.variant,'visual');
  assert.ok(validPrCiTriadReceipt(visual.receipt,sha));
  const visualContext={stage:'pr',target_ref:sha,
    criteria:[{criterion:'SC-04',text:web4061}],pr_ci_triad:pass};
  const visualClaim={criteria:[{criterion:'SC-04',result:'Pass',
    evidence:[{type:'test',value:'claim'}],summary:'claim'}]};
  assert.equal(enforcePrCiTriad(visualContext,visualClaim).criteria[0].result,'Pending',
    'generic triad must not substitute actual browser-design proof');
  visualContext.pr_ci_triad=visual;
  assert.equal(enforcePrCiTriad(visualContext,visualClaim).criteria[0].result,'Pass');
  assert.equal(enforcePrCiTriad(visualContext,visualClaim)
    .criteria[0].evidence.length,6,'five checked jobs accompany the original claim');
  const withoutBrowser=structuredClone(visualObservations);
  withoutBrowser.browser_design.jobs.jobs[0].steps[0].conclusion='skipped';
  assert.equal(attestPrCiTriad(sha,withoutBrowser,{visual:true}).status,'pending');
  const wrongHeadBrowser=structuredClone(visualObservations);
  wrongHeadBrowser.browser_design.runs.workflow_runs[0].head_sha='b'.repeat(40);
  assert.equal(attestPrCiTriad(sha,wrongHeadBrowser,{visual:true}).status,'pending');

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
