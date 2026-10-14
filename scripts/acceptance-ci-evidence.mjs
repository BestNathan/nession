#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const MAX_RUNS_PER_SHA = 20;
const MAX_ASSOCIATED_PULLS = 5;
const MAX_PR_E2E_HISTORY = 4;
const MAX_ARTIFACT_ZIP_BYTES = 2 * 1024 * 1024;

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

export function normalizeCiEvidence({ targetSha, directRuns = [], pulls = [], pullRunsBySha = new Map(), sourceAncestry = [] }) {
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
      };
    });

  return {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: sha,
    direct_runs: compactRuns(directRuns, sha),
    pull_requests: associated,
    source_ancestry: sourceAncestry,
  };
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
async function collectSourceAncestry(repo, workspace, targetSha) {
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  if (!/^\d+$/.test(issueNumber)) return [];
  const issue = await githubGet('/repos/' + repo + '/issues/' + issueNumber);
  const wanted = requestedAncestorsFromIssue(issue.body);
  return wanted.map((sha) => checkGitAncestor(workspace, targetSha, sha));
}


// Acceptance history may cover earlier SHAs *of the same authenticated PR*.
// It never creates Pass evidence by itself, and never derives selectors from
// an arbitrary Issue comment or URL. Per-run ZIP manifest data is untrusted
// until checked against GitHub workflow/run identity and source plan digest.
export function summarizePrE2EArtifact({ prNumber, issueNumber, run, plan, results, artifact }) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 ||
      !Number.isSafeInteger(issueNumber) || issueNumber <= 0 ||
      !run || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      run.name !== 'E2E / Tests' || run.event !== 'pull_request' ||
      run.status !== 'completed' ||
      !['success','failure'].includes(run.conclusion) ||
      !(run.pull_requests || []).some(p => p.number === prNumber) ||
      !artifact || artifact.name !== 'issue-e2e-verification' ||
      artifact.expired || artifact.workflow_run?.id !== run.id ||
      artifact.workflow_run?.head_sha !== run.head_sha)
    throw new Error('untrusted PR E2E source or artifact identity');
  if (plan?.schema_version !== 1 || plan.kind !== 'issue_e2e_selection' ||
      plan.mode !== 'selected' || plan.pr_number !== prNumber ||
      plan.target_sha !== run.head_sha || !/^[a-f0-9]{64}$/.test(plan.plan_digest) ||
      !Array.isArray(plan.issues) || !Array.isArray(plan.selected) ||
      !plan.issues.some(x => x.issue === issueNumber))
    throw new Error('selected PR Issue/plan identity mismatch');
  const canonical = {
    schema_version: plan.schema_version, kind: plan.kind, base_sha: plan.base_sha,
    target_sha: plan.target_sha, issues: plan.issues, selected: plan.selected, mode: plan.mode,
  };
  const calculated = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if (calculated !== plan.plan_digest) throw new Error('selection plan digest mismatch');
  const ids = new Set(), selected = [];
  for (const row of plan.selected) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) ||
        ids.has(row.id) || !Array.isArray(row.owners) ||
        row.owners.length === 0 || row.owners.some(o =>
          !plan.issues.some(x => x.issue === o.issue)))
      throw new Error('invalid/duplicate selected ID or foreign Issue owner');
    ids.add(row.id);
    selected.push({id: row.id, owners: row.owners.map(o => o.issue).sort((a,b)=>a-b)});
  }
  if (results?.kind !== 'issue_e2e_test_results' ||
      results.target_sha !== run.head_sha || results.run_id !== run.id ||
      results.plan_digest !== plan.plan_digest ||
      !Array.isArray(results.results) || results.results.length !== ids.size ||
      results.results.some(r => !ids.has(r.id) || !['Pass','Fail','Pending','Error'].includes(r.result)) ||
      new Set(results.results.map(r => r.id)).size !== ids.size)
    throw new Error('per-ID result/run provenance mismatch');
  return {
    run_id: run.id, head_sha: run.head_sha, conclusion: run.conclusion,
    run_url: run.html_url, artifact_id: artifact.id,
    artifact_digest: artifact.digest ?? null, plan_digest: plan.plan_digest,
    selected, results: results.results.map(r => ({
      id: r.id, result: r.result, discovered: r.discovered,
      passed: r.passed, failed: r.failed, skipped: r.skipped,
      flaky: r.flaky, assertions: r.assertions,
    })),
    evidence_level: 'GitHub-run-and-artifact-identity; historical claims only, not a new SC Pass',
  };
}

async function readSelectedArtifactZip(repo, artifact) {
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ARTIFACT_ZIP_BYTES ||
      artifact.size_in_bytes <= 0) throw new Error('E2E artifact ZIP exceeds bounded history budget');
  const url = '/repos/' + repo + '/actions/artifacts/' + artifact.id + '/zip';
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetch('https://api.github.com' + url, {
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json'},
  });
  if (!response.ok) throw new Error('E2E artifact fetch failed: ' + response.status);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_ARTIFACT_ZIP_BYTES) throw new Error('actual E2E ZIP exceeds bound');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-e2e-history-'));
  const zip = path.join(dir,'artifact.zip');
  try {
    fs.writeFileSync(zip,buf,{flag:'wx'});
    const readJson = filename => {
      const result = spawnSync('unzip',['-p',zip,filename],{encoding:'utf8',maxBuffer:1024*1024,timeout:10000});
      if (result.error || result.status !== 0) throw new Error('required E2E ZIP entry missing: '+filename);
      return JSON.parse(result.stdout);
    };
    return {plan:readJson('plan.json'),results:readJson('results.json')};
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

export async function collectPrE2EHistory(repo, targetSha, issueNumber) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath) || !/^[1-9]\d*$/.test(String(issueNumber))) return [];
  const event = JSON.parse(fs.readFileSync(eventPath,'utf8'));
  const pr = event.pull_request;
  if (event.repository?.full_name !== repo ||
      !pr || pr.head?.sha !== targetSha || pr.head?.repo?.full_name !== repo ||
      !Number.isSafeInteger(pr.number) || pr.number <= 0 || !pr.head.ref)
    return [];
  const verified = await githubGet('/repos/' + repo + '/pulls/' + pr.number);
  if (verified.head?.sha !== targetSha ||
      verified.head?.repo?.full_name !== repo || verified.number !== pr.number) return [];
  const query = new URLSearchParams({
    branch: String(pr.head.ref), event:'pull_request', per_page:'100',
  });
  const runs = await githubGet('/repos/' + repo + '/actions/runs?' + query);
  const relevant = (runs.workflow_runs ?? [])
    .filter(r => r.name === 'E2E / Tests' && r.event === 'pull_request' &&
      r.status === 'completed' && ['success','failure'].includes(r.conclusion) &&
      (r.pull_requests ?? []).some(p => p.number === pr.number))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0,MAX_PR_E2E_HISTORY);
  const history = [];
  for (const run of relevant) {
    const list = await githubGet('/repos/' + repo + '/actions/runs/' + run.id + '/artifacts?per_page=20');
    const eligible = (list.artifacts ?? []).filter(a => a.name === 'issue-e2e-verification' &&
      !a.expired && a.workflow_run?.id === run.id &&
      a.workflow_run?.head_sha === run.head_sha);
    if (eligible.length !== 1) continue;
    try {
      const {plan,results} = await readSelectedArtifactZip(repo,eligible[0]);
      history.push(summarizePrE2EArtifact({
        prNumber:pr.number, issueNumber:Number(issueNumber),
        run,plan,results,artifact:eligible[0],
      }));
    } catch (error) {
      // Malformed PR-head artifacts are never trusted or promoted to evidence.
      console.warn('Ignored unverified historical E2E artifact for run '+run.id+': '+error.message);
    }
  }
  return history;
}

async function collectCommand(workspace, outFile) {
  const repo = requireText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const sha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const directRuns = await workflowRunsForSha(repo, sha);
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
  const prE2EHistory = await collectPrE2EHistory(repo,sha,process.env.ISSUE_NUMBER);
  const evidence = normalizeCiEvidence({ targetSha: sha, directRuns, pulls: selectedPulls, pullRunsBySha, sourceAncestry });
  evidence.pr_e2e_history = prE2EHistory;
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    'collected acceptance CI evidence for ' + sha +
    ': ' + evidence.direct_runs.length + ' direct run(s), ' +
    evidence.pull_requests.length + ' associated PR(s)'
  );
}

function selfTest() {
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
  assert.equal(evidence.target_sha, 'merge123');
  assert.deepEqual(evidence.direct_runs.map((run) => run.id), [2]);
  assert.deepEqual(evidence.pull_requests[0].runs.map((run) => run.id), [4]);
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


  const prNum=1718, issueNum=1717, fullA='a'.repeat(40), fullB='b'.repeat(40);
  const src={schema_version:1,kind:'issue_e2e_selection',base_sha:fullB,
    target_sha:fullA,issues:[{issue:1702},{issue:1717}],
    selected:[{id:'login',owners:[{issue:1702},{issue:1717}]}],mode:'selected'};
  const digest=createHash('sha256').update(JSON.stringify(src)).digest('hex');
  const plan={...src,plan_digest:digest,pr_number:prNum};
  const run={id:100,name:'E2E / Tests',event:'pull_request',status:'completed',
    conclusion:'failure',head_sha:fullA,html_url:'https://github.com/BestNathan/nession/actions/runs/100',
    pull_requests:[{number:prNum}]};
  const artifact={id:55,name:'issue-e2e-verification',expired:false,digest:'sha256:test',
    workflow_run:{id:100,head_sha:fullA}};
  const results={kind:'issue_e2e_test_results',target_sha:fullA,run_id:100,
    plan_digest:digest,results:[{id:'login',result:'Fail',discovered:1,passed:0,
      failed:1,skipped:0,flaky:0,assertions:2}]};
  const history=summarizePrE2EArtifact({prNumber:prNum,issueNumber:issueNum,
    run,plan,results,artifact});
  assert.deepEqual(history.selected,[{id:'login',owners:[1702,1717]}]);
  assert.equal(history.results[0].result,'Fail');
  assert.throws(()=>summarizePrE2EArtifact({prNumber:prNum,issueNumber:issueNum,
    run:{...run,head_sha:fullB},plan,results,artifact}),/untrusted PR/);
  assert.throws(()=>summarizePrE2EArtifact({prNumber:prNum,issueNumber:issueNum,
    run,plan:{...plan,plan_digest:'0'.repeat(64)},results,artifact}),/digest mismatch/);
  assert.throws(()=>summarizePrE2EArtifact({prNumber:prNum,issueNumber:999,
    run,plan,results,artifact}),/Issue\/plan identity/);
  assert.throws(()=>summarizePrE2EArtifact({prNumber:prNum,issueNumber:issueNum,
    run:{...run,pull_requests:[{number:999}]},plan,results,artifact}),/untrusted PR/);
  assert.throws(()=>summarizePrE2EArtifact({prNumber:prNum,issueNumber:issueNum,
    run,plan,results:{...results,run_id:999},artifact}),/per-ID result/);

  console.log('acceptance-ci-evidence self-test: collector, bounded criteria and positive/negative Git ancestry passed');
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
