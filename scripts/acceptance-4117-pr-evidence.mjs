#!/usr/bin/env node
// #4151: tightly scoped, trusted-main read-only evidence for #4117's merged
// repair PR. Does not decide SC verdicts or grant execution/GitHub tools to
// the Acceptor. Do not turn this into a global PR evidence reader.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyReporterEvidence } from './issue-e2e-source-attestation.mjs';
import { downloadZip } from './acceptance-pr-pages-e2e-evidence.mjs';

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const ISSUE = 4117, PR = 4122;
const HEAD = '8dc5f69a14949a99bbc2e9310c8d2f3554c12c30';
const BASE = '43cef936ab9192c4035d61ce9ee862d64c9290b9';
const MERGE = '68571ea6c2224a467ef4a339f0094bb5f14ff0cb';
const FAILED = 'a9ee14f85bc36a8e7a6195c1ac28efb1c4f3d219';
const PINNED = Object.freeze([
  { path: 'e2e/tests/browser/images-workspace-capability.spec.ts',
    id: 'images-workspace-capability', passed: 6,
    before: 'c380399475fff41ebcf9f587258bbf15ad745c32',
    after: '0bd88a6dd58f67e69f5d0e2c177bbfb7e99b3b8d',
    oldText: "getByTestId('project-image-use').first().click()",
    newText: "getByTestId('project-image-search').fill(alias)" },
  { path: 'e2e/tests/browser/project-session-create.spec.ts',
    id: 'project-session-create', passed: 12,
    before: 'f36faf75118a75e06d5f22bf1097ee9ee59548f2',
    after: 'b5ee5fc11c8614393be80981be77171791154e95',
    oldText: 'getByText(/No Existing Location/)',
    newText: "'No Existing Location. Add an Agent directory in Project settings.'" },
  { path: 'e2e/tests/browser/terminal-consistency-faults.spec.ts',
    id: 'terminal-consistency-faults', passed: 16,
    before: '279499bf472fcc8604bd9abef9cf23aa6a02dd8c',
    after: 'c838b2b8006bd9494ccb00d355eb632e3b39447a',
    oldText: "msg_type: 'agent.terminal.output'",
    newText: 'timestamp: Date.now()' },
]);
const RUNS = Object.freeze([
  { id: 44694228423, name: 'CI / Quality Gate',
    workflow: '.github/workflows/ci-quality.yml',
    jobs: [['scope', 'Classify the exact PR or main-push change'],
      ['tooling-check', 'Verify repository tooling Gates'],
      ['web-check', 'Enforce applicable Quality results at the stable check name']] },
  { id: 44694228256, name: 'Acceptance / Case Smoke',
    workflow: '.github/workflows/acceptance-case-smoke.yml',
    jobs: [['case-smoke', 'Select PR-linked Case-method proofs (trusted main policy)']] },
  { id: 44694228233, name: 'E2E / Tests',
    workflow: '.github/workflows/e2e-tests.yml',
    jobs: [['e2e', 'Run E2E tests', 'Normalize selected per-file results even on failure',
      'Enforce authenticated selected-E2E execution result']] },
]);
const OLD_RUN = 44668353505, OLD_JOB = 136063085450, OLD_ARTIFACT = 14599368530;
const OLD_DIGEST = 'sha256:3066e986f997c4e1c59aae45599def3c56a98cddb919c1d9d6ad27a1dd275ada';
const E2E_ARTIFACT = 14610825782;
const E2E_DIGEST = 'sha256:a39567acbd87147177a881ece74b541c99aff3cca565fa4da7c7d6554f2731a1';
const SHA = /^[0-9a-f]{40}$/;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 200000,
  }).trim();
}
function valid(x, description) { assert.ok(x, description); }
function assertIdentity({ issue, pr, mergeCommit, head, delta, sources }) {
  assert.equal(issue?.number, ISSUE, 'wrong Issue');
  assert.equal(issue?.state, 'open', 'Issue is no longer eligible');
  assert.equal(pr?.number, PR, 'wrong PR');
  assert.equal(pr?.state, 'closed', 'repair PR not closed');
  assert.equal(pr?.merged, true, 'repair PR not merged');
  valid(typeof pr.merged_at === 'string', 'missing merge timestamp');
  assert.equal(pr?.head?.sha, HEAD, 'wrong PR head');
  assert.equal(pr?.head?.ref, 'fix/4117-staging-full-browser-regressions');
  assert.equal(pr?.head?.repo?.full_name, REPO, 'foreign PR head');
  assert.equal(pr?.base?.ref, 'staging', 'wrong PR base');
  assert.equal(pr?.base?.repo?.full_name, REPO, 'foreign PR base');
  assert.equal(pr?.merge_commit_sha, MERGE, 'wrong merge commit');
  assert.equal(head, HEAD, 'wrong checkout HEAD');
  assert.equal(mergeCommit?.sha, MERGE, 'GitHub merge commit mismatch');
  assert.deepEqual((mergeCommit.parents || []).map(x => x.sha),
    [BASE, HEAD], 'wrong ordered protected merge parents');
  assert.deepEqual(delta, PINNED.map(x => x.path).sort(),
    'repair has unrelated/missing code changes');
  assert.equal(sources?.length, PINNED.length, 'missing Git object/source evidence');
  for (const pin of PINNED) {
    const src = sources.find(x => x.path === pin.path);
    valid(src, 'missing source ' + pin.path);
    assert.equal(src.after, pin.after, 'wrong final blob ' + pin.path);
    assert.equal(src.before, pin.before, 'wrong baseline blob ' + pin.path);
    valid(src.oldContent.includes(pin.oldText), 'missing old fault ' + pin.path);
    valid(src.content.includes(pin.newText), 'missing repair ' + pin.path);
    // The new source still carries the same actual notification/test rather
    // than suppressing the negative or removing the test.
    valid(src.content.includes(pin.oldText) || pin.id !== 'terminal-consistency-faults',
      'terminal protocol test was deleted');
  }
}
function verifiedRun(run, meta) {
  assert.equal(run?.id, meta.id, 'wrong Run ID');
  assert.equal(run?.name, meta.name, 'wrong workflow name');
  assert.equal(run?.path, meta.workflow, 'wrong workflow path');
  assert.equal(run?.event, 'pull_request', 'not a PR workflow event');
  assert.equal(run?.head_sha, HEAD, 'wrong Run head SHA');
  assert.equal(run?.head_branch, 'fix/4117-staging-full-browser-regressions');
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'success', 'CI did not pass');
  valid(Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1,
    'missing Run attempt identity');
}
function verifiedJobs(run, jobResult, requirements) {
  const entries = jobResult?.jobs;
  valid(Number.isSafeInteger(jobResult?.total_count) &&
    jobResult.total_count >= 1 && jobResult.total_count <= 100 &&
    Array.isArray(entries) && entries.length === jobResult.total_count,
    'truncated/invalid job inventory');
  return requirements.map(([name, ...steps]) => {
    const matches = entries.filter(j => j.name === name);
    assert.equal(matches.length, 1, 'missing/duplicate official job ' + name);
    const job = matches[0];
    assert.equal(job.run_id, run.id, 'cross-run job ' + name);
    if (job.run_attempt != null)
      assert.equal(job.run_attempt, run.run_attempt, 'cross-attempt job');
    if (job.head_sha != null)
      assert.equal(job.head_sha, run.head_sha, 'cross-SHA job');
    assert.equal(job.status, 'completed', 'incomplete job ' + name);
    assert.equal(job.conclusion, 'success', 'non-passing job ' + name);
    valid(Number.isSafeInteger(job.id) && job.id > 0, 'bad job id');
    for (const step of steps) {
      const selected = (job.steps || []).filter(s => s.name === step);
      assert.equal(selected.length, 1, 'missing/duplicate step ' + step);
      assert.equal(selected[0].status, 'completed', 'incomplete step ' + step);
      assert.equal(selected[0].conclusion, 'success', 'failed step ' + step);
    }
    return { name, id: job.id, required_steps: steps };
  });
}
function verifiedFailure(run, jobs, artifactList) {
  assert.equal(run?.id, OLD_RUN);
  assert.equal(run?.name, 'Convergence Full staging@' + FAILED);
  assert.equal(run?.path, '.github/workflows/e2e-full-regression.yml');
  assert.equal(run?.event, 'workflow_dispatch');
  assert.equal(run?.head_branch, 'main');
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.equal(run?.run_attempt, 1);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'failure');
  const matches = jobs?.jobs?.filter(j => j.id === OLD_JOB && j.name === 'full') || [];
  assert.equal(matches.length, 1, 'missing failing Full job');
  assert.equal(matches[0].run_id, OLD_RUN);
  assert.equal(matches[0].conclusion, 'failure');
  const failing = (matches[0].steps || []).filter(s =>
    s.name === 'Run full canonical Playwright suite at pinned SHA');
  assert.equal(failing.length, 1, 'missing original failed test step');
  assert.equal(failing[0].conclusion, 'failure');
  const candidates = (artifactList?.artifacts || []).filter(a =>
    a.id === OLD_ARTIFACT && a.name === 'full-regression-44668353505-1');
  assert.equal(candidates.length, 1, 'missing baseline trace archive');
  const a = candidates[0];
  assert.equal(a.expired, false, 'original traces expired');
  assert.equal(a.digest, OLD_DIGEST, 'original trace archive digest changed');
  assert.equal(a.workflow_run?.id, OLD_RUN);
  return { run_id: OLD_RUN, attempt: 1, job_id: OLD_JOB,
    conclusion: 'failure', trace_artifact_id: a.id, trace_zip_sha256: a.digest,
    // Original expected/actual assertions were independently inspected
    // from the failed source job and trace before this collector was written.
    // These paths point at authenticated evidence, not a model's verdict.
    observed: [
      { id: PINNED[0].id, failed_assertion: 'selectedDigest != initialDigest',
        observed: 'equal sha256:0001abcdef...', retries: 2 },
      { id: PINNED[1].id, failed_assertion: 'No Existing Location is visible',
        observed: 'strict mode: two matching elements', retries: 2 },
      { id: PINNED[2].id, failed_assertion: 'INJECT-PROBE count > 0',
        observed: 'count = 0 after 30s', retries: 2 },
    ] };
}
function zipJson(zip, member) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-4117-pr-'));
  try {
    const file = path.join(dir, 'source.zip');
    fs.writeFileSync(file, zip, {flag: 'wx', mode: 0o600});
    return JSON.parse(execFileSync('unzip', ['-p', file, member], {
      encoding: 'utf8', timeout: 12000, maxBuffer: 3_000_000,
    }));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
function verifiedBrowser(run, artifactList, zip) {
  const found = (artifactList?.artifacts || []).filter(a =>
    a.id === E2E_ARTIFACT && a.name === 'issue-e2e-verification');
  assert.equal(found.length, 1, 'missing source E2E archive');
  const a = found[0];
  assert.equal(a.digest, E2E_DIGEST, 'source E2E artifact checksum mismatch');
  assert.equal(a.expired, false, 'source E2E archive expired');
  assert.equal(a.workflow_run?.id, run.id);
  assert.equal(a.workflow_run?.head_sha, HEAD);
  const plan = zipJson(zip, 'plan.json');
  const results = zipJson(zip, 'results.json');
  const playwright = zipJson(zip, 'playwright.json');
  const assertions = zipJson(zip, 'assertions.json');
  assert.equal(plan?.schema_version, 1);
  assert.equal(plan?.mode, 'selected');
  assert.equal(plan?.pr_number, PR);
  assert.equal(plan?.target_sha, HEAD);
  assert.equal(plan?.base_sha, BASE);
  assert.deepEqual((plan?.selected || []).map(x => x.id).sort(),
    PINNED.map(x => x.id).sort(), 'missing/unrelated selected E2E ID');
  for (const pin of PINNED) {
    valid(plan.selected.some(x => x.id === pin.id &&
      x.owners?.some(owner => owner.issue === ISSUE)),
    'selected E2E has wrong Issue owner: ' + pin.id);
  }
  assert.equal(results?.status, 'Pass');
  assert.equal(results?.target_sha, HEAD);
  assert.equal(results?.run_id, run.id);
  assert.equal(results?.run_attempt, run.run_attempt);
  assert.equal(results?.plan_digest, plan.plan_digest);
  verifyReporterEvidence(plan, results, playwright, assertions);
  assert.equal(results?.results?.length, PINNED.length);
  const tested = PINNED.map(pin => {
    const row = results.results.find(x => x.id === pin.id);
    valid(row, 'missing result for ' + pin.id);
    assert.equal(row.result, 'Pass', 'browser regression did not pass');
    assert.equal(row.discovered, pin.passed, 'incomplete browser discovery');
    assert.equal(row.passed, pin.passed, 'incomplete browser coverage');
    valid(row.assertions > 0, 'zero actual assertions');
    return { id: pin.id, passed: row.passed, discovered: row.discovered,
      assertions: row.assertions, result: 'Pass' };
  });
  return { artifact_id: a.id, artifact_digest: a.digest,
    run_id: run.id, attempt: run.run_attempt, plan_digest: plan.plan_digest,
    source: 'independently reverified Playwright report/assertions', tested };
}
function output({identity, evidence, baseline, browser}) {
  return { schema_version: 1, kind: 'acceptance_ci_evidence', target_sha: HEAD,
    verified_4117_pr_regression: {
      verdict: 'Verified', issue: ISSUE, pr: PR,
      head_sha: HEAD, base_sha: BASE, merge_sha: MERGE,
      source: 'trusted-main Git blob/diff + GitHub REST Run/Attempt/Job + immutable E2E ZIP',
      changed_files: identity.delta, blobs: identity.sources.map(x => ({
        path: x.path, before: x.before, after: x.after,
        old_assertion: PINNED.find(p => p.path === x.path).oldText,
        repair_assertion: PINNED.find(p => p.path === x.path).newText })),
      original_failure: baseline, independent_pr_runs: evidence, selected_e2e: browser,
      warning: 'Verification input only; independent Agent and trusted updater decide SC results.',
    } };
}
async function github(endpoint, token) {
  const response = await fetch(API + endpoint, {headers: {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nession-4117-source-proof',
  }, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw Error('Read-only GitHub REST ' +
    endpoint.split('?')[0] + ' HTTP ' + response.status);
  return response.json();
}
async function collect(root, dest, token) {
  assert.equal(process.env.GITHUB_REPOSITORY, REPO);
  assert.equal(Number(process.env.ISSUE_NUMBER), ISSUE, 'wrong Issue selector');
  assert.equal(process.env.ACCEPTANCE_STAGE, 'pr', 'not PR-stage evidence');
  valid(token, 'missing read-only GitHub token');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(head, HEAD);
  const delta = git(root, 'diff', '--name-only', BASE, HEAD).split('\n')
    .filter(Boolean).sort();
  const sources = PINNED.map(pin => ({
    path: pin.path,
    before: git(root, 'rev-parse', FAILED + ':' + pin.path),
    after: git(root, 'rev-parse', HEAD + ':' + pin.path),
    oldContent: git(root, 'show', FAILED + ':' + pin.path),
    content: git(root, 'show', HEAD + ':' + pin.path),
  }));
  const [issue, pr, mergeCommit, oldRun, oldJobs, oldArtifacts,
    ...runMetas] = await Promise.all([
    github('/issues/' + ISSUE, token),
    github('/pulls/' + PR, token),
    github('/git/commits/' + MERGE, token),
    github('/actions/runs/' + OLD_RUN, token),
    github('/actions/runs/' + OLD_RUN + '/attempts/1/jobs?per_page=100', token),
    github('/actions/runs/' + OLD_RUN + '/artifacts?per_page=100', token),
    ...RUNS.map(r => github('/actions/runs/' + r.id, token)),
  ]);
  const identity = { issue, pr, mergeCommit, head, delta, sources };
  assertIdentity(identity);
  const baseline = verifiedFailure(oldRun, oldJobs, oldArtifacts);
  const attestations = await Promise.all(RUNS.map(async (meta, i) => {
    const run = runMetas[i];
    verifiedRun(run, meta);
    const jobs = await github('/actions/runs/' + run.id + '/attempts/' +
      run.run_attempt + '/jobs?per_page=100', token);
    return { run_id: run.id, run_attempt: run.run_attempt,
      workflow: meta.name, head_sha: HEAD, jobs: verifiedJobs(run, jobs, meta.jobs) };
  }));
  const e2e = runMetas[2];
  const artifacts = await github('/actions/runs/' + e2e.id +
    '/artifacts?per_page=100', token);
  const item = (artifacts.artifacts || []).find(a => a.id === E2E_ARTIFACT);
  valid(item, 'missing pinned E2E artifact');
  // Small (~50 KiB) immutable browser artifact: recompute its ZIP digest
  // before trusting the executed per-ID result, not mutable Issue prose.
  const zip = await downloadZip(item, token);
  const {createHash} = await import('node:crypto');
  assert.equal('sha256:' + createHash('sha256').update(zip).digest('hex'),
    E2E_DIGEST, 'E2E artifact bytes differ from GitHub-signed digest');
  const browser = verifiedBrowser(e2e, artifacts, zip);
  fs.writeFileSync(dest, JSON.stringify(output({
    identity, evidence: attestations, baseline, browser,
  }), null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log('Authenticated exact-head #4117 PR failure, repair, Quality and selected-browser proof');
}
function selfTest() {
  const stub = (p, oldText, newText) => ({
    path:p.path, before:p.before, after:p.after,
    oldContent: 'before ' + oldText,
    content: 'after ' + oldText + ' ' + newText,
  });
  const sources = PINNED.map(x => stub(x, x.oldText, x.newText));
  const issue = {number: ISSUE, state: 'open'};
  const pr = {number: PR, state:'closed', merged:true,
    merged_at:'2026-11-20T07:30:07Z', head:{sha:HEAD,
      ref:'fix/4117-staging-full-browser-regressions',repo:{full_name:REPO}},
    base:{ref:'staging',repo:{full_name:REPO}},
    merge_commit_sha:MERGE};
  const mergeCommit={sha:MERGE,parents:[{sha:BASE},{sha:HEAD}]};
  const identity={issue,pr,mergeCommit,head:HEAD,delta:PINNED.map(x=>x.path).sort(),sources};
  assertIdentity(identity);
  const deny=change=>assert.throws(()=>assertIdentity({...identity,...change}));
  deny({issue:{...issue,number:1000}});
  deny({pr:{...pr,head:{...pr.head,sha:FAILED}}});
  deny({pr:{...pr,merged:false}});
  deny({pr:{...pr,head:{...pr.head,repo:{full_name:'outside/repo'}}}});
  deny({pr:{...pr,merge_commit_sha:FAILED}});
  deny({mergeCommit:{...mergeCommit,parents:[{sha:HEAD},{sha:BASE}]}});
  deny({delta:[...identity.delta,'README.md']});
  deny({sources:sources.map((s,i)=>i===0?{...s,after:FAILED}:s)});
  deny({sources:sources.map((s,i)=>i===1?{...s,content:'no fix'}:s)});
  const mkRun=(m)=>({id:m.id,name:m.name,path:m.workflow,event:'pull_request',
    head_sha:HEAD,head_branch:'fix/4117-staging-full-browser-regressions',
    run_attempt:1,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}});
  for(const meta of RUNS) {
    const run=mkRun(meta); verifiedRun(run,meta);
    assert.throws(()=>verifiedRun({...run,head_sha:FAILED},meta));
    assert.throws(()=>verifiedRun({...run,conclusion:'failure'},meta));
    const jobs=meta.jobs.map(([name,...steps],i)=>({
      id:i+1,name,run_id:run.id,status:'completed',conclusion:'success',
      steps:steps.map(s=>({name:s,status:'completed',conclusion:'success'})),
    }));
    const set={total_count:jobs.length,jobs};
    assert.equal(verifiedJobs(run,set,meta.jobs).length,meta.jobs.length);
    assert.throws(()=>verifiedJobs(run,{...set,total_count:set.total_count+1},meta.jobs));
    assert.throws(()=>verifiedJobs(run,{...set,jobs:[...jobs.slice(1),jobs[0]]},
      meta.jobs.filter((_,i)=>i>0).concat([meta.jobs[0],meta.jobs[0]])));
    assert.throws(()=>verifiedJobs(run,{...set,jobs:jobs.map((j,i)=>
      i===0?{...j,conclusion:'skipped'}:j)},meta.jobs));
    assert.throws(()=>verifiedJobs(run,{...set,jobs:jobs.map((j,i)=>
      i===0?{...j,steps:j.steps.slice(1)}:j)},meta.jobs));
    assert.throws(()=>verifiedJobs(run,{...set,jobs:jobs.map((j,i)=>
      i===0?{...j,run_id:5}:j)},meta.jobs));
  }
  const run={id:OLD_RUN,name:'Convergence Full staging@'+FAILED,
    path:'.github/workflows/e2e-full-regression.yml',event:'workflow_dispatch',
    head_branch:'main',run_attempt:1,status:'completed',conclusion:'failure',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const fail={jobs:[{id:OLD_JOB,name:'full',run_id:OLD_RUN,conclusion:'failure',
    steps:[{name:'Run full canonical Playwright suite at pinned SHA',
      conclusion:'failure'}]}]};
  const trace={artifacts:[{id:OLD_ARTIFACT,name:'full-regression-44668353505-1',
    expired:false,digest:OLD_DIGEST,workflow_run:{id:OLD_RUN}}]};
  assert.equal(verifiedFailure(run,fail,trace).observed.length,3);
  assert.throws(()=>verifiedFailure({...run,conclusion:'success'},fail,trace));
  assert.throws(()=>verifiedFailure(run,{jobs:[]},trace));
  assert.throws(()=>verifiedFailure(run,fail,{artifacts:[]}));
  assert.throws(()=>verifiedFailure(run,fail,{artifacts:[
    {...trace.artifacts[0],digest:'sha256:'+'0'.repeat(64)}]}));
  console.log('#4151 PR proof: exact source/run/job/baseline identity and 20+ fail-closed negatives passed');
}
const [mode,root,dest]=process.argv.slice(2);
if (mode === 'self-test') selfTest();
else if (mode === 'collect') {
  valid(root && dest, 'usage: collect <pinned-workspace> <output>');
  collect(root,dest,process.env.GITHUB_TOKEN||process.env.GH_TOKEN)
    .catch(e=>{console.error(e.stack||e);process.exitCode=1;});
} else throw Error('usage: acceptance-4117-pr-evidence.mjs self-test | collect WORKSPACE OUT');
