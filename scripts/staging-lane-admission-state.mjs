#!/usr/bin/env node
// Owner: #2323 SC-10. Authenticate WHICH previous lane-admission artifact may
// seed the next admission decision.
//
// An artifact's name is not provenance: any workflow (including a PR run) can
// upload `staging-lane-admission`. The scheduler must only trust state written
// by the canonical lane workflow on main, from a trusted event, by a completed
// successful run, pinned to that exact run/attempt. Everything else is ignored;
// losing previous state is safer than trusting a forged interval.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export const ADMISSION_ARTIFACT = 'staging-lane-admission';
export const ADMISSION_WORKFLOW = '.github/workflows/e2e-staging-lanes.yml';
export const ADMISSION_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);
export const ADMISSION_BRANCH = 'main';
export const REPO = 'BestNathan/nession';
const POS = (x) => Number.isSafeInteger(x) && x > 0;
const MAX_CANDIDATES = 10;

function fail(message) {
  throw new Error(message);
}

// The artifact must name a run we can re-read; expired or empty artifacts are
// never state.
export function admissionCandidates(artifacts) {
  if (!Array.isArray(artifacts)) fail('admission artifacts must be an array');
  const candidates = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail('admission artifact entry must be an object');
    }
    if (artifact.name !== ADMISSION_ARTIFACT) continue;
    if (artifact.expired === true) continue;
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) continue;
    const run = artifact.workflow_run;
    if (!run || typeof run !== 'object' || !POS(run.id)) continue;
    candidates.push({
      artifact_id: artifact.id,
      run_id: run.id,
      head_branch: run.head_branch ?? null,
      head_sha: run.head_sha ?? null,
      created_at: String(artifact.created_at ?? ''),
    });
  }
  return candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Re-read the producing run and prove it is the canonical lane writer.
export function isTrustedAdmissionRun(run, { repo = REPO, artifact = null } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return false;
  if (run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) {
    return false;
  }
  if (String(run.path ?? '').replace(/@refs\/[^\s]+$/, '') !== ADMISSION_WORKFLOW) {
    return false;
  }
  if (!ADMISSION_EVENTS.includes(run.event)) return false;
  if (run.head_branch !== ADMISSION_BRANCH) return false;
  if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  if (!POS(run.run_attempt)) return false;
  if (artifact && artifact.run_id !== run.id) return false;
  if (artifact?.head_branch && artifact.head_branch !== run.head_branch) return false;
  if (artifact?.head_sha && run.head_sha !== artifact.head_sha) return false;
  return true;
}

// Bounded, newest-first: a forged newest artifact must fall through to an older
// trusted one, and a trusted one beyond the bound is explicitly not state.
export async function selectTrustedAdmissionArtifact({
  artifacts, fetchRun, repo = REPO, maxCandidates = MAX_CANDIDATES,
}) {
  if (typeof fetchRun !== 'function') fail('fetchRun must be a function');
  if (!POS(maxCandidates)) fail('maxCandidates must be a positive integer');
  const candidates = admissionCandidates(artifacts).slice(0, maxCandidates);
  for (const candidate of candidates) {
    const run = await fetchRun(candidate.run_id);
    if (!isTrustedAdmissionRun(run, { repo, artifact: candidate })) continue;
    return Object.freeze({
      artifact_id: candidate.artifact_id,
      run_id: run.id,
      run_attempt: run.run_attempt,
      head_sha: run.head_sha,
      created_at: candidate.created_at,
    });
  }
  return null;
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const now = '2026-10-26T06:00:00Z';
  const artifact = (id, runId, extra = {}) => ({
    id, name: ADMISSION_ARTIFACT, expired: false, size_in_bytes: 1024,
    created_at: new Date(Date.parse(now) - (100 - id) * 60_000).toISOString(),
    workflow_run: { id: runId, head_branch: 'main', head_sha: sha },
    ...extra,
  });
  const run = (id, extra = {}) => ({
    id, run_attempt: 1, path: ADMISSION_WORKFLOW, event: 'schedule',
    head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    ...extra,
  });
  const fetchFrom = (runs) => async (id) => {
    if (!(id in runs)) throw Error('unexpected run fetch ' + id);
    return runs[id];
  };

  // The newest trusted artifact wins.
  return (async () => {
    const trusted = await selectTrustedAdmissionArtifact({
      artifacts: [artifact(1, 11), artifact(2, 12)],
      fetchRun: fetchFrom({ 11: run(11), 12: run(12) }),
    });
    assert.equal(trusted.artifact_id, 2);
    assert.equal(trusted.run_id, 12);
    assert.equal(trusted.run_attempt, 1);
    assert.equal(trusted.head_sha, sha);

    // A forged newest artifact falls through to an older trusted one.
    const forged = await selectTrustedAdmissionArtifact({
      artifacts: [artifact(1, 11), artifact(2, 12)],
      fetchRun: fetchFrom({
        11: run(11),
        12: run(12, { path: '.github/workflows/ci-quality.yml' }),
      }),
    });
    assert.equal(forged.artifact_id, 1, 'foreign workflow artifact is not state');

    const cases = [
      ['push', { event: 'push' }],
      ['pull_request branch', { head_branch: 'feature-x' }],
      ['failure', { conclusion: 'failure' }],
      ['in progress', { status: 'in_progress', conclusion: null }],
      ['foreign repository', { repository: { full_name: 'evil/nession' } }],
      ['zero attempt', { run_attempt: 0 }],
    ];
    for (const [name, patch] of cases) {
      const selected = await selectTrustedAdmissionArtifact({
        artifacts: [artifact(1, 11)],
        fetchRun: fetchFrom({ 11: run(11, patch) }),
      });
      assert.equal(selected, null, name + ' must not be trusted state');
    }
    // Wrong run identity between artifact and re-read run.
    const mismatch = await selectTrustedAdmissionArtifact({
      artifacts: [artifact(1, 11)],
      fetchRun: async () => run(99),
    });
    assert.equal(mismatch, null, 'artifact/run identity mismatch is not state');
    // Expired, empty and unnamed artifacts never become candidates.
    assert.deepEqual(admissionCandidates([
      artifact(1, 11, { expired: true }),
      artifact(2, 12, { size_in_bytes: 0 }),
      { ...artifact(3, 13), name: 'other' },
      { ...artifact(4, 14), workflow_run: { id: 0 } },
    ]), []);
    assert.throws(() => admissionCandidates({}), /must be an array/);
    // Bounded fall-through: a trusted artifact beyond the bound is not read.
    const overBound = await selectTrustedAdmissionArtifact({
      artifacts: [artifact(1, 11), artifact(2, 12)],
      fetchRun: fetchFrom({
        11: run(11),
        12: run(12, { conclusion: 'failure' }),
      }),
      maxCandidates: 1,
    });
    assert.equal(overBound, null, 'a trusted artifact beyond the bound is not read');
    console.log('staging lane admission state: provenance, fall-through and fail-closed fixtures passed');
  })();
}

async function main() {
  if (process.argv[2] === 'self-test') {
    await selfTest();
    return;
  }
  if (process.argv[2] === 'select') {
    const [artifactsFile, output] = process.argv.slice(3);
    if (!artifactsFile || !output) throw new Error('usage: select ARTIFACTS_JSON OUTPUT_JSON');
    const payload = JSON.parse(fs.readFileSync(artifactsFile, 'utf8'));
    const artifacts = Array.isArray(payload) ? payload : payload.artifacts;
    const token = String(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
    if (!token) throw new Error('GH_TOKEN/GITHUB_TOKEN is required');
    const fetchRun = async (id) => {
      const response = await fetch('https://api.github.com/repos/' + REPO +
        '/actions/runs/' + id, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error('admission run read HTTP ' + response.status);
      return response.json();
    };
    const selected = await selectTrustedAdmissionArtifact({ artifacts, fetchRun });
    fs.writeFileSync(output, JSON.stringify(selected ?? {}, null, 2) + '\n');
    return;
  }
  throw new Error('usage: self-test | select ARTIFACTS_JSON OUTPUT_JSON');
}

if (process.argv[1]?.endsWith('staging-lane-admission-state.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
