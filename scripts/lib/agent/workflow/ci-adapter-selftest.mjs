// Issue #4528 SC-01 executable adapter fixtures.
//
// Proves: the expected check set is frozen from trusted policy BEFORE
// observation; a required check that has not been created cannot disappear or
// pass; Quality scope proves optional skips; infrastructure classification
// comes from frozen policy provenance rather than a check name; exact
// Run/attempt/Job/step binding, bounded pagination, and material rerun
// invalidation. No Reviewer Check and no normal PR policy change is involved.
import assert from 'node:assert/strict';
import { freezeCiObligation, sameEvidenceGeneration } from './ci-barrier.mjs';
import { collectExactCheckEvidence } from './ci-evidence.mjs';
import {
  declarationsFromRequiredChecks, qualityChecksFromFamilies, readChangedPaths,
} from './ci-policy.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const REPO = 'BestNathan/nession';
const SCOPED = { rust: false, web: false, tooling: false, workflow: false,
  instruction: false, applicability: 'scoped' };

// ── policy composition: required contexts + Quality scope + Issue selectors ─
{
  const requiredChecks = [
    { context: 'rust-check', app_id: 15368 },
    { context: 'web-check', app_id: 15368 },
    { context: 'nession/convergence-qualification', app_id: 15368 },
    { context: 'custom-required', app_id: 15368 },
  ];
  const declarations = declarationsFromRequiredChecks({
    requiredChecks, families: SCOPED, e2e: 'not_applicable', cases: 'applicable',
  });
  const names = declarations.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['case-smoke', 'custom-required', 'e2e', 'rust-check', 'web-check']);
  assert.equal(declarations.find((entry) => entry.name === 'rust-check').applicability,
    'not_applicable', 'Quality scope positively attests the Rust skip');
  assert.equal(declarations.find((entry) => entry.name === 'e2e').applicability,
    'not_applicable', 'the Issue selector positively attests the browser skip');
  assert.ok(!declarations.some((entry) => /review/i.test(entry.name)),
    'no Reviewer check is part of the pre-review barrier');

  const obligation = freezeCiObligation({
    head_sha: HEAD, base_sha: BASE, checks: declarations,
  });
  assert.deepEqual(obligation.checks.map((entry) => entry.name),
    ['case-smoke', 'web-check', 'custom-required']);
  assert.equal(obligation.base_sha, BASE);
  const refrozen = freezeCiObligation({
    head_sha: HEAD, base_sha: BASE, checks: [...declarations].reverse(),
  });
  assert.equal(refrozen.obligation_sha256, obligation.obligation_sha256,
    'freeze is order independent');
  const movedBase = freezeCiObligation({
    head_sha: HEAD, base_sha: 'd'.repeat(40), checks: declarations,
  });
  assert.notEqual(movedBase.obligation_sha256, obligation.obligation_sha256,
    'base is part of the frozen generation');
  // The convergence qualification IS a required server-side context, but it is
  // merge admission evidence, not source CI; the existing owner supplies it.
  assert.ok(!declarations.some((entry) => entry.name.includes('convergence')));

  const rustApplicable = declarationsFromRequiredChecks({
    requiredChecks: [{ context: 'rust-check', app_id: 15368 }],
    families: { ...SCOPED, rust: true, applicability: 'scoped' },
    e2e: 'not_applicable', cases: 'not_applicable',
  });
  assert.ok(rustApplicable.some((entry) => entry.name === 'rust-check' &&
    entry.applicability === 'applicable'));
  const unknownQuality = qualityChecksFromFamilies({
    ...SCOPED, rust: true, web: true, tooling: true, applicability: 'unknown',
  });
  assert.ok(unknownQuality.every((entry) => entry.applicability === 'unknown'),
    'unknown scope keeps every Quality family required');
}

// ── bounded changed-path pagination keeps unknown diffs fail closed ────────
{
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ filename: 'docs/page-' + index + '.md' })),
    [{ filename: 'web/src/App.tsx' }],
  ];
  let calls = 0;
  const changed = await readChangedPaths({
    fetchGitHub: async (endpoint) => {
      assert.match(endpoint, /^pulls\/42\/files\?per_page=100&page=/);
      calls++;
      return pages[calls - 1];
    },
    pullNumber: 42,
  });
  assert.equal(calls, 2);
  assert.equal(changed.families.web, true);
  assert.equal(changed.families.rust, false);
  const oversized = await readChangedPaths({
    fetchGitHub: async () => Array.from({ length: 100 }, (_, index) =>
      ({ filename: 'bulk/file-' + index })),
    pullNumber: 42,
    maxFiles: 150,
  });
  assert.equal(oversized.families, null, 'unbounded diff cannot shrink the obligation');
}

// ── controlled GitHub adapter ────────────────────────────────────────────
function runResponse({ id, head = HEAD, path = '.github/workflows/ci-quality.yml',
  attempt = 1, conclusion = 'success', event = 'pull_request' }) {
  return {
    id, head_sha: head, path, run_attempt: attempt,
    status: 'completed', conclusion, event,
  };
}
function checkRun({ id, name, run, job, head = HEAD, status = 'completed',
  conclusion = 'success', app = 'github-actions', path = '.github/workflows/ci-quality.yml',
  attempt = 1 }) {
  return {
    id, name, head_sha: head, status, conclusion,
    app: { slug: app },
    details_url: 'https://github.com/' + REPO + '/actions/runs/' + run +
      (job == null ? '' : '/job/' + job),
    suite: { id: run },
    _path: path, _attempt: attempt,
  };
}
function fakeGitHub({ checkPages = [], runs = {}, jobs = {}, onPage = null }) {
  const calls = [];
  const fetchGitHub = async (endpoint) => {
    calls.push(endpoint);
    if (onPage != null) onPage(endpoint);
    const checkPage = /^commits\/([a-f0-9]{40})\/check-runs\?per_page=100&page=(\d+)$/
      .exec(endpoint);
    if (checkPage) {
      const page = Number(checkPage[2]);
      const body = checkPages[page - 1] ?? [];
      const total = checkPages.reduce((sum, items) => sum + items.length, 0);
      return { total_count: total, check_runs: body };
    }
    const run = /^actions\/runs\/(\d+)$/.exec(endpoint);
    if (run) {
      const body = runs[run[1]];
      if (body == null) throw new Error('missing run ' + run[1]);
      return body;
    }
    const jobPage = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/
      .exec(endpoint);
    if (jobPage) {
      const key = jobPage[1] + ':' + jobPage[2];
      const body = jobs[key] ?? [];
      return { total_count: body.length, jobs: body.slice((Number(jobPage[3]) - 1) * 100) };
    }
    throw new Error('unexpected endpoint ' + endpoint);
  };
  return { fetchGitHub, calls };
}
function jobResponse({ id, name, attempt = 1, head = HEAD, conclusion = 'success',
  steps = [{ name: 'run', conclusion: 'success' }] }) {
  return {
    id, name, head_sha: head, run_attempt: attempt,
    status: 'completed', conclusion, steps,
  };
}
async function observe(obligation, github, { base = BASE } = {}) {
  return collectExactCheckEvidence({
    fetchGitHub: github.fetchGitHub, repository: REPO, obligation,
    head_sha: HEAD, base_sha: base, observed_at: 5000,
  });
}

function obligationOf(checks) {
  return freezeCiObligation({ head_sha: HEAD, base_sha: BASE, checks });
}
function declaration(name, patch = {}) {
  return {
    name, workflow: 'ci-quality.yml', applicability: 'applicable',
    category: 'source', required: true, allow_neutral: false,
    run_path: '.github/workflows/ci-quality.yml',
    producer_app_slug: 'github-actions',
    ...patch,
  };
}

// ── missing-not-yet-created cannot pass and does not disappear ────────────
{
  const obligation = obligationOf([declaration('web-check')]);
  const github = fakeGitHub({ checkPages: [[]] });
  const ci = await observe(obligation, github);
  assert.equal(ci.status, 'missing');
  assert.deepEqual(ci.checks.map((check) => [check.name, check.conclusion]),
    [['web-check', 'missing']]);
  assert.equal(ci.checks[0].evidence_ref, null);
}

// ── pagination, exact HEAD, Run/attempt/Job/step evidence ────────────────
{
  const obligation = obligationOf([
    declaration('web-check'),
    declaration('case-smoke', {
      workflow: 'acceptance-case-smoke.yml',
      run_path: '.github/workflows/acceptance-case-smoke.yml',
    }),
    declaration('custom-required', { run_path: null }),
  ]);
  const filler = Array.from({ length: 100 }, (_, index) =>
    checkRun({ id: 1000 + index, name: 'filler-' + index, run: 9000 + index, job: 1 }));
  const decoy = checkRun({ id: 5001, name: 'web-check', head: OTHER, run: 6001, job: 1 });
  const web = checkRun({ id: 5002, name: 'web-check', run: 6002, job: 42 });
  const cases = checkRun({
    id: 5003, name: 'case-smoke', run: 6003, job: 43,
    path: '.github/workflows/acceptance-case-smoke.yml',
  });
  const custom = checkRun({ id: 5004, name: 'custom-required', run: 6004, job: 44 });
  const github = fakeGitHub({
    checkPages: [filler, [decoy, web, cases, custom]],
    runs: {
      6002: runResponse({ id: 6002 }),
      6003: runResponse({ id: 6003, path: '.github/workflows/acceptance-case-smoke.yml' }),
      6004: runResponse({ id: 6004 }),
    },
    jobs: {
      '6002:1': [jobResponse({ id: 42, name: 'web-check' })],
      '6003:1': [jobResponse({ id: 43, name: 'case-smoke' })],
      '6004:1': [jobResponse({ id: 44, name: 'custom-required' })],
    },
  });
  const ci = await observe(obligation, github);
  assert.equal(ci.status, 'pass');
  const webCheck = ci.checks.find((check) => check.name === 'web-check');
  assert.match(webCheck.evidence_ref, /^run:6002\/attempt:1\/job:42\/steps:[a-f0-9]{24}$/,
    'evidence binds the exact run/attempt/job/steps');
  assert.ok(github.calls.filter((endpoint) => endpoint.includes('check-runs')).length === 2,
    'check-run pagination is bounded but complete');
  const decoyIgnored = ci.checks.find((check) => check.name === 'web-check');
  assert.equal(decoyIgnored.evidence_ref, webCheck.evidence_ref,
    'a check run for another HEAD is not the accepted evidence');

  // A same-name run from the wrong producer app is not proof.
  const wrongApp = checkRun({ id: 7001, name: 'web-check', run: 6002, job: 42,
    app: 'evil-app' });
  const wrongAppCi = await observe(obligation, fakeGitHub({
    checkPages: [[wrongApp]],
    runs: { 6002: runResponse({ id: 6002 }) },
    jobs: { '6002:1': [jobResponse({ id: 42, name: 'web-check' })] },
  }));
  assert.equal(wrongAppCi.status, 'missing');
}

// ── unverifiable terminal results fail closed ────────────────────────────
{
  const obligation = obligationOf([declaration('web-check')]);
  const cases = [
    // Run identity belongs to another HEAD.
    { check: checkRun({ id: 1, name: 'web-check', run: 11, job: 1 }),
      run: runResponse({ id: 11, head: OTHER }),
      job: jobResponse({ id: 1, name: 'web-check' }) },
    // Run path differs from the trusted declaration.
    { check: checkRun({ id: 1, name: 'web-check', run: 11, job: 1 }),
      run: runResponse({ id: 11, path: '.github/workflows/other.yml' }),
      job: jobResponse({ id: 1, name: 'web-check' }) },
    // Job conclusion differs from the check run.
    { check: checkRun({ id: 1, name: 'web-check', run: 11, job: 1, conclusion: 'success' }),
      run: runResponse({ id: 11 }),
      job: jobResponse({ id: 1, name: 'web-check', conclusion: 'failure' }) },
    // Non-PR event.
    { check: checkRun({ id: 1, name: 'web-check', run: 11, job: 1 }),
      run: runResponse({ id: 11, event: 'push' }),
      job: jobResponse({ id: 1, name: 'web-check' }) },
  ];
  for (const item of cases) {
    const ci = await observe(obligation, fakeGitHub({
      checkPages: [[item.check]],
      runs: { 11: item.run },
      jobs: { '11:1': [item.job] },
    }));
    assert.equal(ci.status, 'missing', 'unverifiable evidence is not a pass');
  }
  // A details_url that does not belong to this repository is never followed.
  const foreign = checkRun({ id: 1, name: 'web-check', run: 11, job: 1 });
  foreign.details_url = 'https://github.com/evil/repo/actions/runs/11/job/1';
  const ci = await observe(obligation, fakeGitHub({ checkPages: [[foreign]] }));
  assert.equal(ci.status, 'missing');
  await assert.rejects(() => validateMissingBase(obligation), /stale obligation base/);
}
function validateMissingBase(obligation) {
  return observe(obligation, fakeGitHub({ checkPages: [[]] }), { base: 'e'.repeat(40) });
}

// ── skip only when the trusted owner proved non-applicability ────────────
{
  const skipped = checkRun({ id: 1, name: 'rust-check', run: 21, job: 1,
    conclusion: 'skipped' });
  const applicable = obligationOf([declaration('rust-check')]);
  const ciSkipped = await observe(applicable, fakeGitHub({
    checkPages: [[skipped]],
    runs: { 21: runResponse({ id: 21 }) },
    jobs: { '21:1': [jobResponse({ id: 1, name: 'rust-check', conclusion: 'skipped' })] },
  }));
  assert.equal(ciSkipped.status, 'missing', 'an applicable skip proves nothing');

  // Scope-proven not-applicable is excluded from the obligation entirely.
  const notApplicable = obligationOf([
    declaration('rust-check', { applicability: 'not_applicable' }),
    declaration('web-check'),
  ]);
  const web = checkRun({ id: 2, name: 'web-check', run: 22, job: 2 });
  const ciOk = await observe(notApplicable, fakeGitHub({
    checkPages: [[web, skipped]],
    runs: { 22: runResponse({ id: 22 }) },
    jobs: { '22:1': [jobResponse({ id: 2, name: 'web-check' })] },
  }));
  assert.equal(ciOk.status, 'pass');
  assert.deepEqual(ciOk.checks.map((check) => check.name), ['web-check']);
}

// ── neutral follows canonical required-check semantics ───────────────────
{
  const neutral = checkRun({ id: 1, name: 'web-check', run: 31, job: 1,
    conclusion: 'neutral' });
  const github = fakeGitHub({
    checkPages: [[neutral]],
    runs: { 31: runResponse({ id: 31, conclusion: 'neutral' }) },
    jobs: { '31:1': [jobResponse({ id: 1, name: 'web-check', conclusion: 'neutral' })] },
  });
  const strict = await observe(obligationOf([declaration('web-check')]), github);
  assert.equal(strict.status, 'missing', 'neutral is not universally a pass');
  const allowed = await observe(obligationOf([
    declaration('web-check', { allow_neutral: true }),
  ]), github);
  assert.equal(allowed.status, 'pass');
}

// ── infrastructure category comes from frozen policy, not the check name ─
{
  function failing(name, category) {
    return {
      check: checkRun({ id: 1, name, run: 41, job: 1, conclusion: 'timed_out' }),
      run: runResponse({ id: 41, conclusion: 'timed_out' }),
      job: jobResponse({ id: 1, name, conclusion: 'timed_out' }),
    };
  }
  const infra = failing('web-check', 'infrastructure');
  const ciInfra = await observe(obligationOf([
    declaration('web-check', { category: 'infrastructure' }),
  ]), fakeGitHub({
    checkPages: [[infra.check]],
    runs: { 41: infra.run },
    jobs: { '41:1': [infra.job] },
  }));
  assert.equal(ciInfra.status, 'infrastructure');

  const source = failing('runner-infrastructure-network', 'source');
  const ciSource = await observe(obligationOf([
    declaration('runner-infrastructure-network', { category: 'source' }),
  ]), fakeGitHub({
    checkPages: [[source.check]],
    runs: { 41: source.run },
    jobs: { '41:1': [source.job] },
  }));
  assert.equal(ciSource.status, 'actionable_fail',
    'a name that merely looks infrastructural never weakens the classification');
}

// ── rerun invalidation: new attempt/job evidence is a new generation ────
{
  const obligation = obligationOf([declaration('web-check')]);
  const firstRun = checkRun({ id: 100, name: 'web-check', run: 51, job: 1 });
  const first = await observe(obligation, fakeGitHub({
    checkPages: [[firstRun]],
    runs: { 51: runResponse({ id: 51, attempt: 1 }) },
    jobs: { '51:1': [jobResponse({ id: 1, name: 'web-check' })] },
  }));
  assert.equal(first.status, 'pass');

  const rerunRun = checkRun({ id: 200, name: 'web-check', run: 51, job: 2,
    conclusion: 'failure' });
  const rerun = await observe(obligation, fakeGitHub({
    checkPages: [[rerunRun]],
    runs: { 51: runResponse({ id: 51, attempt: 2, conclusion: 'failure' }) },
    jobs: { '51:2': [jobResponse({ id: 2, name: 'web-check', attempt: 2,
      conclusion: 'failure' })] },
  }));
  assert.equal(rerun.status, 'actionable_fail');
  assert.notEqual(rerun.digest, first.digest);
  assert.equal(sameEvidenceGeneration(first, rerun), false,
    'material rerun invalidates the old aggregate');

  // A queued rerun supersedes the older success even before it finishes.
  const queued = checkRun({ id: 300, name: 'web-check', run: 51, job: 3,
    status: 'queued', conclusion: null });
  const pending = await observe(obligation, fakeGitHub({ checkPages: [[firstRun, queued]] }));
  assert.equal(pending.status, 'pending');
}

// ── the Reviewer itself and downstream acceptance are outside the barrier ─
{
  const obligation = obligationOf([declaration('web-check')]);
  const web = checkRun({ id: 1, name: 'web-check', run: 61, job: 1 });
  const reviewer = checkRun({ id: 2, name: 'Agent / Review', run: 62, job: 2 });
  const acceptance = checkRun({ id: 3, name: 'pr-acceptance', run: 63, job: 3 });
  const ci = await observe(obligation, fakeGitHub({
    checkPages: [[web, reviewer, acceptance]],
    runs: { 61: runResponse({ id: 61 }) },
    jobs: { '61:1': [jobResponse({ id: 1, name: 'web-check' })] },
  }));
  assert.equal(ci.status, 'pass');
  assert.deepEqual(ci.checks.map((check) => check.name), ['web-check']);
}

console.log('agent workflow ci-adapter selftest: OK');
