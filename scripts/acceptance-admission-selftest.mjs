#!/usr/bin/env node
// #2031: the initial PR event must record an admission without reporting a
// passing acceptance gate or a transient failure. Only an independently
// verified ready transition may replay the deferred run. This test executes
// the checked-in policy wiring, not a parallel description of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyPrDependencies, isDeferredRun} from './acceptance-dependency-state.mjs';
import {sourceApplicability} from './acceptance-source-applicability.mjs';
import {DEFERRED_REPLAY_JOB} from './acceptance-deferred-replay-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(
  path.join(root, '.github/workflows/acceptance-orchestrator.yml'), 'utf8');

function job(name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  [a-z][a-z0-9-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

// #2031: PR-head events must not expand unrelated Main/Issue/provider jobs.
// The exact-attempt replay jobs must retain their existing check identities.
const background = job('background');
assert.match(background, /github\.event_name == 'issues'/);
assert.match(background, /github\.event_name == 'push'/);
assert.match(background, /github\.event\.action == 'nession-agent-telemetry-ingested'/);
assert.match(background, /acceptance-orchestrator-background\.yml@main/,
  'non-PR jobs must use main-owned trusted tooling');
const backgroundSource = fs.readFileSync(
  path.join(root, '.github/workflows/acceptance-orchestrator-background.yml'), 'utf8');
assert.match(backgroundSource, /\n  workflow_call:/);
for (const name of [
  'acceptance-close-guard', 'prepare-merged-agent', 'merged-agent-acceptance',
  'prepare-post-merge-provider-evidence', 'post-merge-provider-evidence-acceptance',
]) {
  assert.doesNotMatch(source, new RegExp(`^  ${name}:`, 'm'),
    `${name} must not expand on every PR event`);
  assert.match(backgroundSource, new RegExp(`^  ${name}:`, 'm'),
    `${name} must remain available in the trusted non-PR workflow`);
}
for (const name of ['prepare-pre-merge', 'defer-pre-merge',
  'pre-merge-acceptance', 'pre-merge-gate', 'acceptance-pr-gate',
  'reconcile-issue-e2e', 'reconcile-completed-quality-e2e']) {
  assert.doesNotMatch(backgroundSource, new RegExp(`^  ${name}:`, 'm'),
    `${name} must retain its original caller-run check identity`);
}

const prepare = job('prepare-pre-merge');
assert.match(prepare, /id: barrier/, 'prepare must classify the source barrier');
assert.match(prepare, /acceptance-source-applicability\.mjs classify/,
  'applicability must come from the workflow path policy');
assert.match(prepare, /--quality-applicable=/);
assert.match(prepare, /--e2e-applicable=/);
assert.match(prepare, /acceptance-dependency-state\.mjs classify/);
assert.match(prepare, /admission: \$\{\{ steps\.admission\.outputs\.state \}\}/,
  'prepare must expose the admission state');
assert.doesNotMatch(prepare, /Check completed Quality Gate/,
  'the one-time Quality snapshot must not decide admission');
assert.doesNotMatch(prepare, /Check completed E2E Tests/,
  'the one-time E2E snapshot must not decide admission');
assert.match(prepare, /waiting\|superseded\)/,
  'waiting and superseded must take the deferral branch');
assert.match(prepare, /blocked\)[\s\S]*?exit 1/,
  'a genuinely failed source must still fail the run');
assert.match(prepare, /steps\.barrier\.outputs\.state == 'ready'/,
  'Issue E2E obligations may only be verified after admission is ready');

const defer = job('defer-pre-merge');
assert.match(defer, /needs\.prepare-pre-merge\.outputs\.admission != 'ready'/);
assert.match(defer, /actions: write/);
assert.match(defer, /actions\/runs\/\$GITHUB_RUN_ID\/cancel/,
  'a deferred initial run must be cancelled, not failed or green');
assert.match(defer, /No evaluator, Agent, or acceptance verdict ran/);

for (const name of ['pre-merge-acceptance', 'pre-merge-gate']) {
  assert.match(job(name), /admission == 'ready'/,
    `${name} must not run on a deferred admission`);
}

const waker = job('reconcile-completed-quality-e2e');
assert.match(waker, /acceptance-source-applicability\.mjs classify/,
  'the waker must use the same applicability contract');
assert.match(waker, /acceptance-dependency-state\.mjs deferred/,
  'the waker must authenticate deferral from exact-attempt evidence');
assert.match(waker, /actions\/runs\/\$id\/rerun"/,
  'a deferred run is replayed in full, not as failed-jobs-only');
assert.match(waker, /current_state/,
  'the waker must re-read the run immediately before the replay write');
// #2461 SC-02: the replayed run lives on the PR head, so the merged-main
// evaluator can only learn about it from a receipt in the replaying job's log.
// BOTH replay paths must emit through the canonical producer: the
// workflow_run waker and the E2E-projection reconcile each replay a deferred
// run, and the latter is the path that wins when the E2E Report is projected
// after the waker already ran.
for (const name of ['reconcile-completed-quality-e2e', 'reconcile-issue-e2e']) {
  assert.match(job(name), /acceptance-deferred-replay-receipt\.mjs emit/,
    `${name} must emit the machine-readable deferred replay receipt`);
}
assert.ok(waker.indexOf('acceptance-deferred-replay-receipt.mjs emit') >
  waker.indexOf('actions/runs/$id/rerun"'),
'the waker receipt is emitted only after the full rerun is dispatched');
const projection = job('reconcile-issue-e2e');
assert.ok(projection.indexOf('acceptance-dependency-state.mjs deferred') <
  projection.indexOf('acceptance-deferred-replay-receipt.mjs emit'),
'the projection receipt is emitted only after the attempt proves a deferral');
assert.ok(waker.includes(DEFERRED_REPLAY_JOB),
  'the receipt travels in the reconcile job log the collector reads');

// End-to-end shape of the decision the workflow embeds: a workflow-only PR
// has no E2E obligation, while a Rust PR still waits for both sources.
const sha = 'a'.repeat(40);
const run = (conclusion = 'success') => ({
  databaseId: 10, headSha: sha, event: 'pull_request', status: 'completed', conclusion,
});
const workflowOnly = sourceApplicability(['.github/workflows/agent-review.yml']);
assert.deepEqual([workflowOnly.quality, workflowOnly.e2e], [true, false]);
assert.equal(classifyPrDependencies([run()], [], sha,
  {quality: workflowOnly.quality, e2e: workflowOnly.e2e}).state, 'ready',
'a workflow-only PR must not wait for a source its path policy never launched');
assert.equal(classifyPrDependencies([], [], sha,
  {quality: workflowOnly.quality, e2e: workflowOnly.e2e}).state, 'waiting',
'a missing applicable source must remain waiting, never an inferred Pass');
const rust = sourceApplicability(['crates/nession-server/src/lib.rs']);
assert.deepEqual([rust.quality, rust.e2e], [true, true]);
assert.equal(classifyPrDependencies([run()], [], sha,
  {quality: rust.quality, e2e: rust.e2e}).state, 'waiting',
'an applicable missing E2E source must keep the barrier waiting');

// Deferral evidence is fail-closed and bound to the exact attempt.
const deferredRun = {
  id: 30, head_sha: sha, event: 'pull_request_target',
  path: '.github/workflows/acceptance-orchestrator.yml',
  status: 'completed', conclusion: 'cancelled', run_attempt: 1,
};
const prepareJob = {
  name: 'prepare-pre-merge', conclusion: 'success',
  steps: [{name: 'Classify exact-head source barrier', conclusion: 'success'}],
};
const deferJob = {name: 'defer-pre-merge', conclusion: 'cancelled'};
const jobs = (list) => ({total_count: list.length, jobs: list});
assert.equal(isDeferredRun(jobs([prepareJob, deferJob]), deferredRun, sha), true);
assert.equal(isDeferredRun(jobs([prepareJob, { ...deferJob, conclusion: 'success' }]),
  deferredRun, sha), true, 'an accepted cancellation ends the defer job successfully (#2323)');
assert.equal(isDeferredRun(jobs([prepareJob]), deferredRun, sha), false);
assert.equal(isDeferredRun(jobs([prepareJob, deferJob]),
  {...deferredRun, conclusion: 'failure'}, sha), false);
assert.equal(isDeferredRun(jobs([prepareJob, deferJob]),
  {...deferredRun, run_attempt: 3}, sha), false);

console.log('Acceptance admission: trusted pre-merge deferral, applicability, ready-transition replay and fail-closed negatives passed');
