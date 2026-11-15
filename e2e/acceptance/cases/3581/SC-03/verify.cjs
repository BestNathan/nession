'use strict';
// #3581 SC-03: an actual affected PR/run attempt must show the canonical
// deterministic updater completing (or reporting a precise bounded provenance
// denial), with the original Run/Job/Step and Issue projection linked.
//
// Receipt: after the fix merged to trusted main, Issue #3611's second PR-head
// projection (run 43705552358, job 132786319144, step 6) overwrote the prior
// accepted source ref 609127a3 with c5e84b1f. The projector refuses that
// overwrite unless the live supersession proof is supplied, so this run
// exercised the repaired bounded GitHub evidence collector and completed
// without ENOBUFS. The same updater step failed with `spawnSync gh ENOBUFS` in
// the original affected run 43669885175.
//
// The verifier deliberately binds only immutable evidence: run/job/step
// metadata, artifact names/digests and their linked runs. Issue bodies are
// mutable (later projections legitimately replace this one), so they cannot
// serve as the pinned receipt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const FIX_SHA = 'b22222fe1107c0d61ecb228cb78cd30f24d40659';
const ISSUE = 3611;
const BRANCH = 'fix/3611-trusted-pr-case-ingest';
const STEP_NAME = 'Apply Acceptance Report and checkbox projection';
const FAILED_RUN = 43669885175;
const FAILED_JOB = 132678304880;
const PREVIOUS = {
  run: 43704912813,
  sha: '609127a30ec862bdb68ba2c45f7a811471033fc9',
  job: 132784452761,
  artifact: 14158511496,
  artifactName: 'acceptance-result-3611-pr-43704912813-1',
  digest: 'sha256:5b7ceaf80aa65d3ce3ed628c8ffbbe608ecfabaf12f78bafec931935cc4f4a82',
};
const CURRENT = {
  run: 43705552358,
  sha: 'c5e84b1fd7b3152a4735a2d1c5f862f5db21d18c',
  job: 132786319144,
  artifact: 14158368114,
  artifactName: 'acceptance-result-3611-pr-43705552358-1',
  digest: 'sha256:8b36a2b7c1f18a9b2a413acba12f824d0fbe1be2dc53033bacc8fc401ba74e87',
};

async function github(route) {
  const response = await fetch('https://api.github.com/repos/' + REPO + route, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-case-3581-sc03',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GitHub API HTTP ' + response.status + ' for ' + route);
  return response.json();
}

async function updaterEvidence(receipt) {
  const [run, job, artifact] = await Promise.all([
    github('/actions/runs/' + receipt.run),
    github('/actions/jobs/' + receipt.job),
    github('/actions/artifacts/' + receipt.artifact),
  ]);
  assert.equal(run.id, receipt.run);
  assert.equal(run.name, 'Acceptance / Orchestrator');
  assert.equal(run.event, 'pull_request_target');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.head_sha, receipt.sha);
  assert.equal(run.head_branch, BRANCH);

  assert.equal(job.id, receipt.job);
  assert.match(job.name, new RegExp('pr-acceptance \\(' + ISSUE + '\\) / Deterministic Issue updater'));
  assert.equal(job.conclusion, 'success');
  const step = (job.steps || []).find((item) => item.name === STEP_NAME);
  assert.ok(step, 'the deterministic updater projection step is missing');
  assert.equal(step.number, 6);
  assert.equal(step.conclusion, 'success');

  assert.equal(artifact.id, receipt.artifact);
  assert.equal(artifact.name, receipt.artifactName);
  assert.equal(artifact.digest, receipt.digest);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run.id, receipt.run);
  assert.equal(artifact.workflow_run.head_sha, receipt.sha);
  return { run, job, artifact };
}

(async () => {
  const evidence = [];
  try {
    const sha = targetSha();
    assert.notEqual(PREVIOUS.sha, CURRENT.sha,
      'the receipt must span two distinct PR-head projections');

    const [previous, current, issue] = await Promise.all([
      updaterEvidence(PREVIOUS),
      updaterEvidence(CURRENT),
      github('/issues/' + ISSUE),
    ]);
    assert.equal(issue.number, ISSUE, 'the attempted Issue projection is not linked to Issue #' + ISSUE);

    // The fixed collector must be present in this exact merged-main checkout.
    // The Acceptance checkout is shallow, so authenticate ancestry through the
    // GitHub compare API instead of a local merge-base.
    const ancestry = await github('/compare/' + FIX_SHA + '...' + sha);
    assert.equal(ancestry.status, 'ahead');
    assert.equal(ancestry.base_commit?.sha, FIX_SHA);
    assert.equal(ancestry.merge_base_commit?.sha, FIX_SHA);
    assert.equal(ancestry.behind_by, 0);
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/acceptance-executor.mjs'), 'utf8');
    assert.match(source, /GITHUB_EVIDENCE_MAX_BUFFER/);
    assert.match(source, /'--jq'/);
    execFileSync(process.execPath, ['scripts/acceptance-executor.mjs', 'self-test'], {
      cwd: process.cwd(), stdio: 'ignore',
    });

    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': Acceptance / Orchestrator run ' + CURRENT.run +
        ' (pull_request_target, success) job ' + CURRENT.job + ' step 6 "' + STEP_NAME +
        '" completed on trusted main after ' + FIX_SHA + '; the same updater step failed with ' +
        'spawnSync gh ENOBUFS in the original affected run ' + FAILED_RUN + ' job ' + FAILED_JOB,
    });
    evidence.push({
      type: 'runtime',
      value: 'two successive PR-acceptance projections for Issue #' + ISSUE + ' are bound by ' +
        'run/job/step and artifact digest: run ' + PREVIOUS.run + ' artifact ' + PREVIOUS.artifactName +
        ' ' + PREVIOUS.digest + ' (' + PREVIOUS.sha + ') and run ' + CURRENT.run + ' artifact ' +
        CURRENT.artifactName + ' ' + CURRENT.digest + ' (' + CURRENT.sha + '); overwriting the prior ' +
        'accepted PR source requires the live supersession proof, so the bounded GitHub evidence ' +
        'collector ran and returned valid provenance without ENOBUFS',
    });
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary: 'An actual affected post-fix PR Acceptance run completed the deterministic updater and projected Issue evidence after replacing a prior accepted PR source, satisfying the bounded provenance path',
      evidence,
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{ type: 'runtime', value: 'the authenticated affected-PR runtime receipt was not established' }],
    }) + '\n');
    process.exitCode = 1;
  }
})();
