#!/usr/bin/env node
// Main-only trusted ingestion of bounded E2E Scenario observations.
// Never execute code from the source SHA or grant it write credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value, size, label) => {
  if (typeof value !== 'string' || !new RegExp('^[0-9a-f]{' + size + '}$').test(value))
    throw new Error(label + ' must be an exact hex digest');
  return value;
};
const positive = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(label + ' must be positive integer');
  return value;
};
const nonnegative = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be nonnegative integer');
  return value;
};
const iso = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(label + ' must be ISO datetime');
  return value;
};
const allowedKeys = (item, keys, label) => {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error(label + ' must be object');
  for (const key of Object.keys(item))
    if (!keys.includes(key)) throw new Error(label + ' contains forbidden field ' + key);
};
function validateObservation(item) {
  allowedKeys(item, ['at', 'stage', 'browser', 'backend'], 'observation');
  iso(item.at, 'observation.at');
  if (!['before-reload', 'after-reload'].includes(item.stage)) throw new Error('invalid observation stage');
  allowedKeys(item.browser, ['mounted', 'marker_count', 'viewport'], 'browser');
  if (typeof item.browser.mounted !== 'boolean') throw new Error('invalid browser.mounted');
  nonnegative(item.browser.marker_count, 'browser.marker_count');
  if (item.browser.viewport !== null) {
    allowedKeys(item.browser.viewport, ['baseY', 'viewportY'], 'viewport');
    nonnegative(item.browser.viewport.baseY, 'viewport.baseY');
    nonnegative(item.browser.viewport.viewportY, 'viewport.viewportY');
  }
  allowedKeys(item.backend, ['marker_count', 'sha256', 'bytes'], 'backend');
  nonnegative(item.backend.marker_count, 'backend.marker_count');
  nonnegative(item.backend.bytes, 'backend.bytes');
  hex(item.backend.sha256, 64, 'backend.sha256');
  return item;
}
export function sourceIdentity(event, repo) {
  const run = event?.workflow_run;
  if (!run || run.name !== 'E2E Scenario Smoke' || run.status !== 'completed'
      || !['success', 'failure'].includes(run.conclusion))
    throw new Error('not a completed E2E Scenario Smoke workflow_run');
  if (run.repository?.full_name !== repo || run.head_repository?.full_name !== repo)
    throw new Error('source workflow repository mismatch');
  const canonicalPath = '.github/workflows/e2e-scenario-smoke.yml';
  if (run.path !== canonicalPath && run.path !== repo + '/' + canonicalPath)
    throw new Error('unexpected source workflow path');
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(run.event))
    throw new Error('unsupported source workflow event');
  // The invariant: only branches this repository's own flow creates are
  // attested, and `CLAUDE.md`'s branch table names exactly four of them —
  // `feat/**` and `fix/**`, which reach main through staging, and `chore/**`
  // and `docs/**`, which go to main directly — plus the two long-lived
  // branches. `chore/` was missing here, so every Scenario Smoke run from a
  // `chore/*` branch failed this ingest on main and the workflow went red for
  // a branch the repository's own convention created (#1542).
  if (!/^(feat|fix|chore|docs)\//.test(run.head_branch)
      && !['staging', 'main'].includes(run.head_branch))
    throw new Error('untrusted/invalid branch');
  return {
    repository: repo, workflow_id: positive(run.workflow_id, 'workflow_id'),
    run_id: positive(run.id, 'run_id'), run_attempt: positive(run.run_attempt, 'run_attempt'),
    event: run.event, branch: run.head_branch,
    target_sha: hex(run.head_sha, 40, 'workflow_run.head_sha'),
    conclusion: run.conclusion,
    source_url: 'https://github.com/' + repo + '/actions/runs/' + run.id,
  };
}
export function validateScenario(raw, source) {
  if (!raw || raw.schema_version !== 1 || raw.kind !== 'e2e_scenario_observation'
    || raw.scenario !== 'terminal-attach-resume' || raw.evaluation !== null)
    throw new Error('unsupported/non-observational Scenario record');
  if (raw.target_sha !== source.target_sha || raw.scenario_revision !== source.target_sha ||
      raw.run_id !== source.run_id || raw.run_attempt !== source.run_attempt)
    throw new Error('Scenario identity disagrees with authenticated workflow_run');
  if (raw.status !== 'Completed' && raw.status !== 'Error') throw new Error('invalid observation status');
  if (raw.status === 'Completed' && source.conclusion !== 'success')
    throw new Error('Completed observation claims failed workflow as successful');
  positive(raw.run_index, 'run_index');
  if (raw.run_index > 3) throw new Error('run index exceeds bounded repeat');
  iso(raw.started_at, 'started_at'); iso(raw.finished_at, 'finished_at');
  if (Date.parse(raw.finished_at) < Date.parse(raw.started_at)) throw new Error('negative duration');
  hex(raw.config_sha256, 64, 'config_sha256');
  allowedKeys(raw.config, ['generated_lines', 'samples_max', 'transport', 'reload'], 'scenario.config');
  positive(raw.config.generated_lines, 'config.generated_lines');
  positive(raw.config.samples_max, 'config.samples_max');
  if (raw.config.generated_lines > 500 || raw.config.samples_max > 24 ||
      raw.config.transport !== 'Relay' || raw.config.reload !== true)
    throw new Error('unbounded or unsupported Scenario configuration');
  const configHash = hash(JSON.stringify({
    lines: raw.config.generated_lines, samples: raw.config.samples_max,
    transport: raw.config.transport, reload: raw.config.reload,
  }, null, 2) + '\n');
  if (raw.config_sha256 !== configHash)
    throw new Error('Scenario input digest mismatch');
  if (!Array.isArray(raw.observations) || raw.observations.length > 24)
    throw new Error('observation count/storage bound exceeded');
  if (raw.observations.length !== raw.observation_count)
    throw new Error('observation count mismatch');
  for (const o of raw.observations) validateObservation(o);
  if (raw.status === 'Completed' && (!raw.observations.some(o => o.stage === 'before-reload') ||
      !raw.observations.some(o => o.stage === 'after-reload') || raw.observations.length < 2))
    throw new Error('Completed Scenario has no real before/after observations');
  return {
    schema_version: 1, kind: raw.kind, mode: 'scenario',
    scenario: raw.scenario, target_sha: raw.target_sha, scenario_revision: raw.scenario_revision,
    run_id: raw.run_id, run_attempt: raw.run_attempt, run_index: raw.run_index,
    status: raw.status, evaluation: null,
    started_at: raw.started_at, finished_at: raw.finished_at,
    config_sha256: raw.config_sha256, config: raw.config,
    observation_count: raw.observation_count, observations: raw.observations,
    privacy: 'whitelisted counters/timestamps/digests only; no terminal bytes',
  };
}
// A retry may only reuse a deterministic path if its exact bytes match.
// This check is used by trusted ingestion AND the negative-test suite.
export function assertImmutableCollision(existing, proposed) {
  if (existing === null) return 'append';
  if (!Buffer.isBuffer(existing) || !Buffer.isBuffer(proposed))
    throw new Error('immutable record collision check requires bytes');
  if (!existing.equals(proposed)) throw new Error('Immutable record collision: divergent bytes');
  return 'idempotent';
}
export function checkExistingFile(existingPath, candidatePath) {
  const proposed = fs.readFileSync(candidatePath);
  const existing = fs.existsSync(existingPath) ? fs.readFileSync(existingPath) : null;
  return assertImmutableCollision(existing, proposed);
}

export function recordPaths(record) {
  const date = record.finished_at.slice(0, 10);
  const prefix = 'runs/' + date + '/' + record.run_id + '-' + record.run_attempt +
    '/scenario/' + record.scenario + '-' + record.run_index;
  return { record: prefix + '.json',
    index: 'indexes/by-sha/' + record.target_sha + '/scenario/' +
      record.run_id + '-' + record.run_attempt + '-' + record.scenario + '-' + record.run_index + '.json' };
}
async function githubJson(route, token) {
  if (!token) throw new Error('GITHUB_TOKEN missing');
  const response = await fetch('https://api.github.com' + route, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nession-e2e-record-ingest' },
  });
  if (!response.ok) throw new Error('GitHub source attestation failed: ' + response.status);
  return response.json();
}
export async function attest(raw, event, repo, token, request = githubJson) {
  const source = sourceIdentity(event, repo);
  const record = validateScenario(raw, source);
  const root = '/repos/' + repo;
  const commit = await request(root + '/git/commits/' + source.target_sha, token);
  const tree = await request(root + '/git/trees/' + commit.tree.sha + '?recursive=1', token);
  if (tree.truncated) throw new Error('source Git tree truncated');
  const manifestPath = 'e2e/scenarios/' + record.scenario;
  const manifest = tree.tree?.find(item => item.path === manifestPath && item.type === 'tree');
  if (!manifest || !/^[a-f0-9]{40}$/.test(manifest.sha))
    throw new Error('authenticated commit is missing Scenario tree');
  const sourceHash = hash(JSON.stringify(raw));
  const paths = recordPaths(record);
  const immutable = { ...record,
    source: { ...source, scenario_tree_sha: manifest.sha, original_sha256: sourceHash },
    evidence: { provider: 'github-actions-artifact',
      artifact_name: 'e2e-terminal-scenario-' + source.run_id + '-' + source.run_attempt,
      sha256: sourceHash, retention_days: 14,
      retrieval_url: source.source_url, durability: 'time-limited; object archival not configured' },
    execution_id: hash(JSON.stringify({ source, scenario_tree_sha: manifest.sha,
      original_sha256: sourceHash, run_index: record.run_index })) ,
  };
  return { record: immutable, paths };
}
function selfTest() {
  const source = { run_id: 12, run_attempt: 1, target_sha: 'a'.repeat(40), conclusion: 'success' };
  const observation = (stage) => ({ at: '2026-10-09T00:00:00.000Z', stage,
    browser: { mounted: true, marker_count: 1, viewport: { baseY: 0, viewportY: 0 } },
    backend: { marker_count: 1, sha256: 'f'.repeat(64), bytes: 20 } });
  const valid = { schema_version: 1, kind: 'e2e_scenario_observation',
    scenario: 'terminal-attach-resume', evaluation: null,
    target_sha: source.target_sha, scenario_revision: source.target_sha,
    run_id: 12, run_attempt: 1, run_index: 1,
    started_at: '2026-10-09T00:00:00.000Z', finished_at: '2026-10-09T00:01:00.000Z',
    status: 'Completed', config_sha256: hash(JSON.stringify({ lines: 240, samples: 12, transport: 'Relay', reload: true }, null, 2) + '\n'), config: { generated_lines: 240, samples_max: 12, transport: 'Relay', reload: true },
    observations: [observation('before-reload'), observation('after-reload')], observation_count: 2 };
  assert.equal(validateScenario(valid, source).status, 'Completed');
  assert.throws(() => validateScenario({ ...valid, run_id: 99 }, source), /identity/);
  assert.throws(() => validateScenario({ ...valid, run_attempt: 2 }, source), /identity/);
  assert.throws(() => validateScenario({ ...valid, target_sha: 'b'.repeat(40) }, source), /identity/);
  assert.throws(() => validateScenario({ ...valid, config_sha256: 'c'.repeat(64) }, source), /input digest/);
  assert.throws(() => validateScenario({ ...valid, evaluation: 'Pass' }, source), /non-observational/);
  const b = Buffer.from('same record');
  assert.equal(assertImmutableCollision(null, b), 'append');
  assert.equal(assertImmutableCollision(b, Buffer.from(b)), 'idempotent');
  assert.throws(() => assertImmutableCollision(b, Buffer.from('tampered')), /divergent bytes/);
  assert.throws(() => validateScenario({ ...valid, observations: [] }, source), /count mismatch/);
  assert.throws(() => validateScenario({ ...valid, observations:
    [{ ...observation('before-reload'), terminal_output: 'secret' }, observation('after-reload')] }, source), /forbidden/);
  assert.throws(() => validateScenario({ ...valid, observations:
    [observation('before-reload'), observation('before-reload')] }, source), /before\/after/);
  const event = { workflow_run: { name: 'E2E Scenario Smoke', status: 'completed',
    conclusion: 'success', event: 'pull_request', head_branch: 'feat/scenario',
    id: 12, run_attempt: 1, workflow_id: 70, head_sha: source.target_sha,
    repository: { full_name: 'BestNathan/nession' },
    head_repository: { full_name: 'BestNathan/nession' },
    path: '.github/workflows/e2e-scenario-smoke.yml' } };
  assert.equal(sourceIdentity(event, 'BestNathan/nession').run_id, 12);
  assert.equal(sourceIdentity({ workflow_run: { ...event.workflow_run,
    path: 'BestNathan/nession/.github/workflows/e2e-scenario-smoke.yml' } }, 'BestNathan/nession').run_id, 12);
  for (const path of [undefined, '', 'other/.github/workflows/e2e-scenario-smoke.yml',
    '.github/workflows/untrusted.yml', '.github/workflows/e2e-scenario-smoke.yml.backup']) {
    assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run, path } },
      'BestNathan/nession'), /unexpected source workflow path/);
  }
  assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run,
    event: 'workflow_run' } }, 'BestNathan/nession'), /unsupported/);
  assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run,
    head_branch: 'other-repo' } }, 'BestNathan/nession'), /invalid branch/);
  assert.throws(() => sourceIdentity({ workflow_run: { ...event.workflow_run,
    head_repository: { full_name: 'other/repo' } } }, 'BestNathan/nession'), /repository mismatch/);
  return { valid, event };
}
async function selfTestAttestation() {
  const { valid, event } = selfTest();
  const request = async (route) => {
    if (route.includes('/git/commits/')) return { tree: { sha: 'b'.repeat(40) } };
    return { truncated: false, tree: [{ type: 'tree',
      path: 'e2e/scenarios/terminal-attach-resume', sha: 'd'.repeat(40) }] };
  };
  const first = await attest(valid, event, 'BestNathan/nession', 'test', request);
  assert.equal(first.record.source.scenario_tree_sha, 'd'.repeat(40));
  assert.ok(first.paths.record.startsWith('runs/2026-10-09/12-1/scenario/'));
  await assert.rejects(() => attest(valid, event, 'BestNathan/nession', 'test',
    async(route) => route.includes('/git/commits/') ? {tree:{sha:'b'.repeat(40)}} :
      {truncated:false,tree:[]}), /missing Scenario tree/);
  console.log('trusted Scenario orphan ingest self-test: identity, bounded evidence and source tree passed');
}
async function main() {
  const [cmd, input, eventFile, output, indexFile] = process.argv.slice(2);
  if (cmd === 'self-test') return selfTestAttestation();
  if (cmd === 'check-collision') {
    if (!input || !eventFile) throw new Error('check-collision EXISTING CANDIDATE required');
    console.log(checkExistingFile(input, eventFile));
    return;
  }
  if (!['attest', 'enrich'].includes(cmd) || !input || !eventFile)
    throw new Error('usage: e2e-run-ingest.mjs self-test|attest INPUT EVENT|enrich INPUT EVENT OUT INDEX');
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const result = await attest(raw, event, process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  if (cmd === 'attest') return console.log(JSON.stringify(result.paths));
  if (!output || !indexFile) throw new Error('output and index path required');
  fs.writeFileSync(output, JSON.stringify(result.record, null, 2) + '\n');
  fs.writeFileSync(indexFile, JSON.stringify({ schema_version: 1,
    mode: 'scenario', source: result.record.source,
    record: result.paths.record, execution_id: result.record.execution_id }, null, 2) + '\n');
}
// Importing the deterministic validators for security tests must not run the CLI.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
