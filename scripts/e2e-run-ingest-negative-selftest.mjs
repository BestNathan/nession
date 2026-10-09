#!/usr/bin/env node
// Security contract for main-owned immutable Scenario ingestion, independent
// of the normal happy-path harness self-test. This suite must run in Quality.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sourceIdentity, validateScenario, attest, assertImmutableCollision, recordPaths } from './e2e-run-ingest.mjs';

const sha = 'a'.repeat(40);
const config = { generated_lines: 240, samples_max: 12, transport: 'Relay', reload: true };
const config_sha256 = crypto.createHash('sha256').update(JSON.stringify({
  lines: config.generated_lines, samples: config.samples_max,
  transport: config.transport, reload: config.reload,
}, null, 2) + '\n').digest('hex');
const observation = (stage) => ({
  at: '2026-10-09T00:00:00.000Z',
  stage,
  browser: { mounted: true, marker_count: 2, viewport: { baseY: 0, viewportY: 1 } },
  backend: { marker_count: 2, sha256: 'f'.repeat(64), bytes: 16 },
});
const event = { workflow_run: {
  name: 'E2E Scenario Smoke', status: 'completed', conclusion: 'success',
  event: 'pull_request', head_branch: 'feat/scenario', workflow_id: 70,
  id: 12, run_attempt: 1, head_sha: sha,
  repository: { full_name: 'BestNathan/nession' },
  head_repository: { full_name: 'BestNathan/nession' },
  path: '.github/workflows/e2e-scenario-smoke.yml',
}};
const raw = {
  schema_version: 1, kind: 'e2e_scenario_observation',
  scenario: 'terminal-attach-resume', evaluation: null,
  target_sha: sha, scenario_revision: sha, run_id: 12, run_attempt: 1, run_index: 1,
  started_at: '2026-10-09T00:00:00.000Z', finished_at: '2026-10-09T00:01:00.000Z',
  status: 'Completed', config_sha256, config,
  observations: [observation('before-reload'), observation('after-reload')], observation_count: 2,
};
const repo = 'BestNathan/nession';
const source = sourceIdentity(event, repo);
for (const path of [undefined, '', 'other/.github/workflows/e2e-scenario-smoke.yml',
  '.github/workflows/e2e-scenario-smoke.yml.evil', '.github/workflows/other.yml']) {
  assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, path } }, repo),
    /unexpected source workflow path/);
}
assert.equal(validateScenario(raw, source).status, 'Completed');
const fail = (change, pattern = /identity|digest|non-observational|forbidden|observation/) =>
  assert.throws(() => validateScenario(change, source), pattern);

// Authenticated run identity rules reject cross-run, cross-attempt, cross-SHA,
// foreign repo/branch and workflow spoofing, even with a valid looking record.
fail({ ...raw, run_id: 13 });
fail({ ...raw, run_attempt: 2 });
fail({ ...raw, target_sha: 'b'.repeat(40) });
fail({ ...raw, scenario_revision: 'b'.repeat(40) });
fail({ ...raw, config_sha256: 'b'.repeat(64) }, /digest/);
fail({ ...raw, evaluation: 'Pass' }, /non-observational/);
fail({ ...raw, observations: [observation('before-reload'), { ...observation('after-reload'), raw_terminal_text: 'secret' }] }, /forbidden/);
assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, repository: { full_name: 'attacker/repo' } } }, repo), /repository mismatch/);
assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, name: 'Untrusted workflow' } }, repo), /not a completed/);
assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, event: 'workflow_run' } }, repo), /unsupported/);
// Eligibility is repository ownership, not a branch name: the source workflow
// admits any PR head branch and any dispatched ref, so every branch of this
// repository is attestable and the violation fixture is a malformed branch.
// The earlier name lists went red twice on the repository's own branches —
// `chore/*` (#1542), then `test/*` — because no list can express that surface.
for (const branch of [undefined, '', 'staging\nevil']) {
  assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, head_branch: branch } }, repo), /invalid branch/);
}
// ...and the valid counterexample beside it: every family the repository
// actually uses is accepted, including the ones no list had guessed yet.
for (const branch of ['feat/x', 'fix/x', 'chore/x', 'docs/x',
  'test/1516-canonical-case-ingest-proof', 'refactor/one-set-environment',
  'diag/terminal-io-p2p-freeze', 'staging', 'main']) {
  assert.equal(
    sourceIdentity({ workflow_run: { ...event.workflow_run, head_branch: branch } }, repo).branch,
    branch,
  );
}

const request = async (path) => path.includes('/git/commits/')
  ? { tree: { sha: 'c'.repeat(40) } }
  : { truncated: false, tree: [{
    path: 'e2e/scenarios/terminal-attach-resume', type: 'tree', sha: 'd'.repeat(40),
  }] };
const first = await attest(raw, event, repo, 'test', request);
const replay = await attest(structuredClone(raw), event, repo, 'test', request);
assert.deepEqual(replay.paths, first.paths);
const same = Buffer.from(JSON.stringify(first.record));
assert.equal(assertImmutableCollision(null, same), 'append');
assert.equal(assertImmutableCollision(same, Buffer.from(JSON.stringify(replay.record))), 'idempotent');

// Same run/attempt/index with changed observed evidence is NOT a new version:
// it addresses the same orphan path and must be rejected as a collision.
const tampered = { ...raw, observations: [raw.observations[0],
  { ...raw.observations[1], backend: { ...raw.observations[1].backend, bytes: 24 } }] };
const second = await attest(tampered, event, repo, 'test', request);
assert.deepEqual(recordPaths(second.record), first.paths);
assert.notEqual(second.record.execution_id, first.record.execution_id);
assert.throws(() => assertImmutableCollision(same, Buffer.from(JSON.stringify(second.record))), /divergent bytes/);

// Reuse of an old artifact on a new run or new attempt must fail before
// source-tree attestation and before any append to acceptance-results.
await assert.rejects(() => attest(raw, { workflow_run: { ...event.workflow_run, id: 13 } }, repo, 'test', request), /identity/);
await assert.rejects(() => attest(raw, { workflow_run: { ...event.workflow_run, run_attempt: 2 } }, repo, 'test', request), /identity/);
await assert.rejects(() => attest(raw, event, repo, 'test', async p => p.includes('/git/commits/')
  ? { tree: { sha: 'c'.repeat(40) } } : { truncated: true, tree: [] }), /truncated/);
await assert.rejects(() => attest(raw, event, repo, 'test', async p => p.includes('/git/commits/')
  ? { tree: { sha: 'c'.repeat(40) } } : { truncated: false, tree: [] }), /missing Scenario tree/);
console.log('Scenario negative-security-selftest: idempotence, replay, divergent collision, cross-run/attempt/SHA and tree guard passed');
