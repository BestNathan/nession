'use strict';
// #3581 SC-03: an actual affected PR/run attempt must show the canonical
// deterministic updater completing (or reporting a precise bounded provenance
// denial), with the original Run/Job/Step and Issue projection linked.
//
// Receipt: after the fix merged to trusted main, Issue #3611's second PR-head
// projection (run 43705552358, job 132786319144, step 6) overwrote the prior
// accepted source ref 609127a3 with c5e84b1f and projected SC-01/SC-02. The
// projection projector refuses that overwrite unless the live supersession
// proof is supplied, so this run exercised the repaired bounded GitHub evidence
// collector and completed without ENOBUFS. The same updater step failed with
// `spawnSync gh ENOBUFS` in the original affected run 43669885175.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const FIX_SHA = 'b22222fe1107c0d61ecb228cb78cd30f24d40659';
const PREVIOUS_RUN = 43704912813;
const PREVIOUS_SHA = '609127a30ec862bdb68ba2c45f7a811471033fc9';
const CURRENT_RUN = 43705552358;
const CURRENT_SHA = 'c5e84b1fd7b3152a4735a2d1c5f862f5db21d18c';
const UPDATER_JOB = 132786319144;
const ARTIFACT_ID = 14158511496;
const ARTIFACT_NAME = 'acceptance-result-3611-pr-43704912813-1';
const ARTIFACT_DIGEST = 'sha256:5b7ceaf80aa65d3ce3ed628c8ffbbe608ecfabaf12f78bafec931935cc4f4a82';
const ISSUE = 3611;
const FAILED_RUN = 43669885175;
const FAILED_JOB = 132678304880;
const STEP_NAME = 'Apply Acceptance Report and checkbox projection';

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

(async () => {
  const evidence = [];
  try {
    const sha = targetSha();
    assert.notEqual(PREVIOUS_SHA, CURRENT_SHA, 'the receipt must span two distinct PR-head projections');

    const [currentRun, previousRun, job, artifact, issue] = await Promise.all([
      github('/actions/runs/' + CURRENT_RUN),
      github('/actions/runs/' + PREVIOUS_RUN),
      github('/actions/jobs/' + UPDATER_JOB),
      github('/actions/artifacts/' + ARTIFACT_ID),
      github('/issues/' + ISSUE),
    ]);

    assert.equal(currentRun.id, CURRENT_RUN);
    assert.equal(currentRun.name, 'Acceptance / Orchestrator');
    assert.equal(currentRun.event, 'pull_request_target');
    assert.equal(currentRun.conclusion, 'success');
    assert.equal(currentRun.head_sha, CURRENT_SHA);
    assert.equal(previousRun.id, PREVIOUS_RUN);
    assert.equal(previousRun.name, 'Acceptance / Orchestrator');
    assert.equal(previousRun.conclusion, 'success');
    assert.equal(previousRun.head_sha, PREVIOUS_SHA);
    assert.equal(currentRun.head_branch, previousRun.head_branch);

    assert.equal(job.id, UPDATER_JOB);
    assert.match(job.name, /pr-acceptance \(3611\) \/ Deterministic Issue updater/);
    assert.equal(job.conclusion, 'success');
    const step = (job.steps || []).find((item) => item.name === STEP_NAME);
    assert.ok(step, 'the deterministic updater step is missing');
    assert.equal(step.number, 6);
    assert.equal(step.conclusion, 'success');

    assert.equal(artifact.id, ARTIFACT_ID);
    assert.equal(artifact.name, ARTIFACT_NAME);
    assert.equal(artifact.digest, ARTIFACT_DIGEST);
    assert.equal(artifact.expired, false);
    assert.equal(artifact.workflow_run.id, PREVIOUS_RUN);
    assert.equal(artifact.workflow_run.head_sha, PREVIOUS_SHA);

    // The updater replaced the prior accepted source ref with the new head,
    // which is only allowed with a live supersession proof.
    const body = String(issue.body || '');
    for (const criterion of ['SC-01', 'SC-02']) {
      assert.match(body, new RegExp('\\| ' + criterion + ' \\| Pass \\| run ' +
        CURRENT_RUN + '; ref ' + CURRENT_SHA + ';'));
    }
    assert.doesNotMatch(body, new RegExp(PREVIOUS_SHA));

    // The fixed collector must be present in this exact merged-main checkout.
    execFileSync('git', ['merge-base', '--is-ancestor', FIX_SHA, sha], { cwd: process.cwd() });
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/acceptance-executor.mjs'), 'utf8');
    assert.match(source, /GITHUB_EVIDENCE_MAX_BUFFER/);
    assert.match(source, /'--jq'/);
    execFileSync(process.execPath, ['scripts/acceptance-executor.mjs', 'self-test'], {
      cwd: process.cwd(), stdio: 'ignore',
    });

    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ': Acceptance / Orchestrator run ' + CURRENT_RUN +
        ' (pull_request_target, success) job ' + UPDATER_JOB + ' step 6 "' + STEP_NAME +
        '" completed on trusted main after ' + FIX_SHA + '; the same updater step failed with ' +
        'spawnSync gh ENOBUFS in the original affected run ' + FAILED_RUN + ' job ' + FAILED_JOB,
    });
    evidence.push({
      type: 'runtime',
      value: 'the post-fix updater replaced Issue #' + ISSUE + ' SC-01/SC-02 source ref ' +
        PREVIOUS_SHA + ' (artifact ' + ARTIFACT_NAME + ' ' + ARTIFACT_DIGEST +
        ', run ' + PREVIOUS_RUN + ') with ' + CURRENT_SHA + ' and projected run ' +
        CURRENT_RUN + '; an accepted PR source overwrite requires the live supersession proof, ' +
        'so the bounded GitHub evidence collector ran and returned valid provenance without ENOBUFS',
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
