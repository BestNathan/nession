#!/usr/bin/env node

// #3707: trusted-Main, read-only source/CI proof for #3700's pinned repair.
// Never run code from the target checkout. This script only reads Git objects
// and authenticated GitHub REST responses; it never writes protected refs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const ISSUE = 3700;
const PR = 3701;
const PIN = Object.freeze({
  head: 'c9843793d01c0905550db7df86cded2eb464934d',
  staging: '3102fbc634f6e0ccaf31766613045c399ae2452e',
  main: '57c4e64555a2514e6a0f2ce5e26cfdb7a5ea30f5',
});
const BLOBS = Object.freeze({
  'crates/nession-erofs/src/build.rs': 'b0f3d59bc9029b0ee86b501043cd0984ed817f26',
  'crates/nession-erofs/src/overlay/storage.rs': '6ec6e2e8e20e8c338294a4aa28256165fd5274cd',
  'crates/nession-git/src/runtime/cmd.rs': '51de223bd4a4b3f0b9b231f75c7e943599551271',
  'scripts/requirement-acceptance.mjs': '977956d4dcd015b9643fe62684f8b2df4868db9f',
});
const MAIN_ONLY = Object.keys(BLOBS).filter(p => !p.endsWith('/build.rs')).sort();
const CHECK_WORKFLOWS = Object.freeze({
  'rust-check': 'CI / Quality Gate',
  'web-check': 'CI / Quality Gate',
  'case-smoke': 'Acceptance / Case Smoke',
  e2e: 'E2E / Tests',
});

function requireInvariant(ok, message) {
  if (!ok) throw new Error('3707 trusted PR evidence rejected: ' + message);
}

function git(workspace, ...args) {
  return execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function verifyGitSnapshot(snapshot) {
  requireInvariant(snapshot.head === PIN.head, 'incorrect source HEAD');
  requireInvariant(Array.isArray(snapshot.parents) &&
    snapshot.parents.length === 2 &&
    snapshot.parents[0] === PIN.staging &&
    snapshot.parents[1] === PIN.main, 'wrong ordered integration parents');
  requireInvariant(Array.isArray(snapshot.apiParents) &&
    snapshot.apiParents.length === 2 &&
    snapshot.apiParents[0] === PIN.staging &&
    snapshot.apiParents[1] === PIN.main, 'GitHub Commit API parent mismatch');
  requireInvariant(snapshot.delta.join('\n') === MAIN_ONLY.join('\n'),
    'integration delta includes missing or unexpected paths');
  for (const [p, sha] of Object.entries(BLOBS)) {
    requireInvariant(snapshot.blobs[p] === sha, 'unexpected target blob: ' + p);
    const parent = p.endsWith('/build.rs') ? PIN.staging : PIN.main;
    requireInvariant(snapshot.parentBlobs[p] === sha,
      'blob not preserved from expected pinned parent ' + parent + ': ' + p);
  }
  requireInvariant((snapshot.fixture.match(/command\.args\(\["-c", "exec sleep 30"\]\);/g) ?? []).length === 2,
    'expected two retained exec sleep 30 cancellation fixtures');
}

export function verifyCheckRuns(checkRuns, sha) {
  requireInvariant(checkRuns && Number.isInteger(checkRuns.total_count) &&
    Array.isArray(checkRuns.check_runs), 'missing GitHub Check Runs response');
  requireInvariant(checkRuns.total_count <= 100 &&
    checkRuns.check_runs.length === checkRuns.total_count,
    'truncated check runs cannot attest complete source check scope');
  const selected = {};
  for (const [name, expectedWorkflow] of Object.entries(CHECK_WORKFLOWS)) {
    const candidates = checkRuns.check_runs.filter(c => c.name === name &&
      c.app?.slug === 'github-actions' && c.app?.id === 15368)
      .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
    const check = candidates[0];
    requireInvariant(Boolean(check), 'missing official GitHub Actions check ' + name);
    requireInvariant(check.head_sha === sha && check.status === 'completed' &&
      check.conclusion === 'success', 'wrong-head, pending, skipped or failed ' + name);
    const match = String(check.details_url ?? '').match(
      /^https:\/\/github\.com\/BestNathan\/nession\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/);
    requireInvariant(Boolean(match), 'invalid authenticated check job URL ' + name);
    selected[name] = {
      name, workflow: expectedWorkflow, conclusion: 'success',
      head_sha: sha, run_id: Number(match[1]), job_id: Number(match[2]),
      url: check.details_url,
    };
  }
  requireInvariant(selected['rust-check'].run_id === selected['web-check'].run_id,
    'Rust and Web Quality checks must identify the same source run');
  return selected;
}

export function verifyPullAndStaging(pr, branch, sha) {
  requireInvariant(pr?.number === PR && pr?.state === 'open' &&
    pr?.draft === false && pr.head?.sha === sha &&
    pr.head?.repo?.full_name === REPO &&
    pr.base?.ref === 'staging' && pr.base?.sha === PIN.staging,
    'source PR identity or base/head no longer matches pinned repair');
  requireInvariant(branch?.name === 'staging' && branch?.protected === true &&
    branch?.commit?.sha === PIN.staging,
    'protected staging ref moved or is no longer protected');
}

async function github(path, token) {
  const response = await fetch('https://api.github.com/repos/' + REPO + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-3707-source-proof',
    },
  });
  requireInvariant(response.ok, 'authenticated GitHub REST ' + path + ' returned ' + response.status);
  return response.json();
}

async function collect(workspace, out) {
  requireInvariant(process.env.GITHUB_REPOSITORY === REPO, 'wrong repository');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  requireInvariant(Boolean(token), 'GitHub read-only token unavailable');
  const head = git(workspace, 'rev-parse', 'HEAD^{commit}');
  requireInvariant(head === PIN.head, 'checked-out Git source ref differs from exact PR head');
  const parents = git(workspace, 'show', '-s', '--format=%P', 'HEAD').split(/\s+/);
  const delta = git(workspace, 'diff', '--name-only', PIN.staging, PIN.head)
    .split('\n').filter(Boolean).sort();
  const blobs = {};
  const parentBlobs = {};
  for (const p of Object.keys(BLOBS)) {
    blobs[p] = git(workspace, 'rev-parse', PIN.head + ':' + p);
    parentBlobs[p] = git(workspace, 'rev-parse',
      (p.endsWith('/build.rs') ? PIN.staging : PIN.main) + ':' + p);
  }
  const fixture = git(workspace, 'show', PIN.head + ':crates/nession-erofs/src/build.rs');
  const [commit, checkRuns, pull, staging] = await Promise.all([
    github('/git/commits/' + PIN.head, token),
    github('/commits/' + PIN.head + '/check-runs?per_page=100', token),
    github('/pulls/' + PR, token),
    github('/branches/staging', token),
  ]);
  requireInvariant(commit.sha === PIN.head, 'GitHub commit object identity mismatch');
  const snapshot = {
    head, parents, apiParents: (commit.parents ?? []).map(p => p.sha),
    delta, blobs, parentBlobs, fixture,
  };
  verifyGitSnapshot(snapshot);
  verifyPullAndStaging(pull, staging, head);
  const checks = verifyCheckRuns(checkRuns, head);
  const verifiedRuns = {};
  for (const check of Object.values(checks)) {
    const run = verifiedRuns[check.run_id] ?? await github('/actions/runs/' + check.run_id, token);
    verifiedRuns[check.run_id] = run;
    requireInvariant(run.head_sha === head && run.event === 'pull_request' &&
      run.status === 'completed' && run.conclusion === 'success' &&
      run.name === check.workflow,
      'inconsistent authenticated source Run/Attempt/HEAD ' + check.name);
  }
  const evidence = {
    schema_version: 1,
    kind: 'acceptance_ci_evidence',
    target_sha: head,
    verified_3700_git_integration: {
      verified: true, source: 'trusted-main git object + GitHub Git Commit API',
      exact_head: head, parent_shas: parents, delta_paths: delta,
      pinned_blobs: blobs, parent_blobs: parentBlobs,
      preserved_staging_fixture_occurrences: 2,
      commit_api_url: 'https://api.github.com/repos/' + REPO + '/git/commits/' + head,
    },
    verified_3700_pr_governance: {
      verified: true, source: 'authenticated GitHub PR, protected Branch and Actions REST',
      issue_number: ISSUE, pull_request_number: PR,
      head_sha: head, staging_branch_sha: staging.commit.sha,
      staging_branch_protected: true,
      checks: Object.values(checks),
      workflow_runs: Object.values(verifiedRuns).map(r => ({
        id: r.id, name: r.name, event: r.event,
        head_sha: r.head_sha, status: r.status, conclusion: r.conclusion,
        run_attempt: r.run_attempt, url: r.html_url,
      })),
      // The target remained on its pinned protected parent while the
      // candidate lived on an isolated PR branch. No ref write occurs here.
      protected_ref_unchanged_before_merge: true,
    },
  };
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
  console.log('Verified immutable #3700 Git/CI proof at ' + head);
}

function selfTest() {
  const fixture = 'command.args(["-c", "exec sleep 30"]);' + '\n' +
    'command.args(["-c", "exec sleep 30"]);';
  const snapshot = {
    head: PIN.head, parents: [PIN.staging, PIN.main],
    apiParents: [PIN.staging, PIN.main], delta: MAIN_ONLY,
    blobs: { ...BLOBS }, parentBlobs: { ...BLOBS }, fixture,
  };
  verifyGitSnapshot(snapshot);
  assert.throws(() => verifyGitSnapshot({ ...snapshot, parents: [PIN.main, PIN.staging] }), /ordered/);
  assert.throws(() => verifyGitSnapshot({ ...snapshot, apiParents: [PIN.staging] }), /Commit API/);
  assert.throws(() => verifyGitSnapshot({ ...snapshot, delta: [...MAIN_ONLY, 'README.md'] }), /delta/);
  assert.throws(() => verifyGitSnapshot({ ...snapshot, fixture: fixture.slice(0, 15) }), /fixture/);
  assert.throws(() => verifyGitSnapshot({
    ...snapshot, blobs: { ...BLOBS, [MAIN_ONLY[0]]: '0'.repeat(40) },
  }), /blob/);

  const makeRun = (name, runId) => ({
    name, app: { slug: 'github-actions', id: 15368 },
    head_sha: PIN.head, status: 'completed', conclusion: 'success',
    started_at: '2026-11-16T03:00:00Z',
    details_url: 'https://github.com/' + REPO + '/actions/runs/' + runId + '/job/123',
  });
  const checks = {total_count: 4, check_runs: [
    makeRun('rust-check', 1), makeRun('web-check', 1),
    makeRun('case-smoke', 2), makeRun('e2e', 3),
  ]};
  assert.equal(Object.keys(verifyCheckRuns(checks, PIN.head)).length, 4);
  assert.throws(() => verifyCheckRuns({ ...checks, total_count: 5 }, PIN.head), /truncated/);
  assert.throws(() => verifyCheckRuns({ ...checks, check_runs: checks.check_runs.slice(1), total_count: 3 }, PIN.head), /missing/);
  assert.throws(() => verifyCheckRuns({ ...checks, check_runs: checks.check_runs.map(c => c.name === 'e2e' ? { ...c, conclusion: 'failure' } : c) }, PIN.head), /failed/);
  assert.throws(() => verifyCheckRuns({ ...checks, check_runs: checks.check_runs.map(c => c.name === 'case-smoke' ? { ...c, head_sha: PIN.main } : c) }, PIN.head), /wrong-head/);
  assert.throws(() => verifyCheckRuns({ ...checks, check_runs: checks.check_runs.map(c => c.name === 'rust-check' ? { ...c, app: { slug: 'untrusted', id: 1 } } : c) }, PIN.head), /missing/);

  const pr = {number: PR, state: 'open', draft: false,
    head: {sha: PIN.head, repo: {full_name: REPO}},
    base: {ref: 'staging', sha: PIN.staging}};
  const branch = {name: 'staging', protected: true, commit: {sha: PIN.staging}};
  verifyPullAndStaging(pr, branch, PIN.head);
  assert.throws(() => verifyPullAndStaging({ ...pr, head: { ...pr.head, sha: PIN.main } }, branch, PIN.head), /identity/);
  assert.throws(() => verifyPullAndStaging(pr, { ...branch, commit: { sha: PIN.head } }, PIN.head), /protected/);
  console.log('#3707 read-only source/CI proof self-tests pass');
}

const action = process.argv[2];
if (action === 'self-test') selfTest();
else if (action === 'collect') {
  requireInvariant(process.argv.length === 5, 'usage: collect <trusted-read-only-workspace> <output>');
  await collect(process.argv[3], process.argv[4]);
} else throw new Error('usage: acceptance-3700-git-ci-proof.mjs self-test | collect <workspace> <output>');
