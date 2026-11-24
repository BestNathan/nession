#!/usr/bin/env node
// Trusted-main bounded PR-stage evidence for the public Pages React/Vite
// migration (#4448). This is NOT a generic PR collector or an Acceptance
// verdict. It re-authenticates the exact-head CI / Pages Run/Attempt and its
// required Jobs/Steps, downloads the bounded parity-evidence artifact from
// that exact Run/Attempt, and returns the observation summary to the
// independent Agent. It never executes PR-head code with a token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {downloadZip} from './acceptance-pr-pages-e2e-evidence.mjs';

const REPO = 'BestNathan/nession';
const ISSUE = 4448;
const BASELINE_SHA = '6fb8fe59cfa32d795fcc930bee4297184810cc84';
const WORKFLOW_NAME = 'CI / Pages';
const WORKFLOW_PATH = '.github/workflows/ci-pages.yml';
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const API = 'https://api.github.com/repos/' + REPO;
const MAX_ZIP = 2_000_000;
const MAX_JSONL = 4;
const MAX_RECORDS = 400;
const TOLERANCE = Object.freeze({
  maxDifferentPixelRatio: 0.001,
  maxChannelDelta: 2,
  maxGeometryDeltaPx: 0.05,
});
const VIEWPORTS = Object.freeze([
  [320, 568], [390, 844], [844, 390], [768, 1024],
  [1365, 740], [1440, 900], [1920, 1080],
]);
const SCHEMES = Object.freeze(['light', 'dark']);
const ROUTES = Object.freeze([
  'overview', 'agents', 'agent-detail', 'collaboration', 'work-issue',
  'work-pr', 'prototypes', 'knowledge', 'knowledge-article',
  'knowledge-changes', 'documents', 'protocol', 'protocol-v2', 'mcp',
  'mcp-tool', 'repository', 'evidence', 'missing', 'workflows',
]);
const INTERACTIONS = Object.freeze([
  'knowledge-search', 'knowledge-category', 'knowledge-article-navigation',
  'documents-search', 'mcp-search', 'agent-outcome-filter', 'workflows-select',
]);
const JOBS = Object.freeze([
  {
    name: 'Pages typecheck, unit and static build',
    steps: [
      'Install locked Pages dependencies',
      'Verify standalone projection, types and import boundary',
      'Build sanitized Pages without network credentials',
      'Verify output, compiled closure and null semantics',
    ],
  },
  {
    name: 'Pages browser smoke (Chromium only)',
    steps: [
      'Install isolated browser test dependencies',
      'Install locked Pages build dependencies',
      'Install headless Chromium',
      'Run standalone Pages browser scenarios (no product runtime)',
      'Preserve frozen-baseline parity evidence',
    ],
  },
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function sameRun(run, sha, prNumber) {
  assert.equal(run?.name, WORKFLOW_NAME);
  assert.equal(run?.path, WORKFLOW_PATH);
  assert.equal(run?.event, 'pull_request');
  assert.equal(run?.head_sha, sha);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'success');
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.ok(positive(run?.id));
  assert.ok(positive(run?.run_attempt));
  assert.ok(Array.isArray(run?.pull_requests));
  assert.ok(run.pull_requests.some((pull) => pull?.number === prNumber),
    'Pages run is not bound to the addressed PR');
}

function requireJob(payload, spec, run) {
  const jobs = payload?.jobs;
  assert.ok(Array.isArray(jobs) && jobs.length <= 100, 'bounded GitHub jobs required');
  const matches = jobs.filter((job) => job?.name === spec.name);
  assert.equal(matches.length, 1, 'missing/duplicate job ' + spec.name);
  const job = matches[0];
  assert.equal(job.run_id, run.id);
  assert.equal(job.run_attempt, run.run_attempt);
  assert.equal(job.head_sha, run.head_sha);
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  for (const stepName of spec.steps) {
    const steps = (job.steps || []).filter((step) => step?.name === stepName);
    assert.equal(steps.length, 1, 'missing/duplicate step ' + stepName);
    assert.equal(steps[0].status, 'completed');
    assert.equal(steps[0].conclusion, 'success');
  }
  return {name: spec.name, job_id: job.id, required_steps: [...spec.steps]};
}

function checkParityRecord(record, kind) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record));
  assert.deepEqual(record.tolerance, TOLERANCE);
  for (const field of ['text', 'links', 'geometry']) {
    assert.equal(record[field]?.equal, true, kind + ' ' + field + ' parity failed');
  }
  assert.equal(record.screenshot?.equal, true, kind + ' screenshot parity failed');
  const total = record.screenshot?.total_pixels;
  const different = record.screenshot?.different_pixels;
  assert.ok(Number.isSafeInteger(total) && total > 0);
  assert.ok(Number.isSafeInteger(different) && different >= 0 && different <= total);
  const ratio = different / total;
  assert.ok(ratio <= TOLERANCE.maxDifferentPixelRatio,
    kind + ' screenshot differs beyond the declared tolerance');
  return ratio;
}

export function verifyParityObservations(observations) {
  assert.ok(Array.isArray(observations) && observations.length <= MAX_RECORDS);
  const routes = new Map();
  const interactions = new Set();
  let worst = 0;
  for (const record of observations) {
    if (record?.route !== undefined) {
      assert.ok(ROUTES.includes(record.route), 'unexpected route ' + record.route);
      assert.equal(record.baseline_sha, BASELINE_SHA);
      assert.equal(record.title?.equal, true, record.route + ' title parity failed');
      const viewport = record.viewport;
      assert.ok(VIEWPORTS.some(([width, height]) =>
        viewport?.width === width && viewport?.height === height),
      'unexpected viewport for ' + record.route);
      assert.ok(SCHEMES.includes(record.color_scheme));
      const key = record.route + '@' + viewport.width + 'x' + viewport.height +
        ':' + record.color_scheme;
      const seen = routes.get(record.route) || new Set();
      assert.equal(seen.has(key), false, 'duplicate parity observation ' + key);
      seen.add(key);
      routes.set(record.route, seen);
      worst = Math.max(worst, checkParityRecord(record, 'route ' + record.route));
      continue;
    }
    assert.ok(INTERACTIONS.includes(record?.interaction),
      'unexpected interaction ' + record?.interaction);
    assert.equal(interactions.has(record.interaction), false,
      'duplicate interaction ' + record.interaction);
    interactions.add(record.interaction);
    worst = Math.max(worst, checkParityRecord(record, 'interaction ' + record.interaction));
  }
  assert.equal(routes.size, ROUTES.length, 'missing route parity coverage');
  for (const route of ROUTES) {
    assert.equal(routes.get(route)?.size, VIEWPORTS.length * SCHEMES.length,
      'incomplete route parity matrix for ' + route);
  }
  assert.equal(interactions.size, INTERACTIONS.length, 'missing interaction parity coverage');
  return {
    observations: observations.length,
    routes: [...routes.keys()].length,
    interactions: interactions.size,
    baseline_sha: BASELINE_SHA,
    tolerance: TOLERANCE,
    structural_mismatches: 0,
    worst_different_pixel_ratio: worst,
  };
}

export function verifyPagesMigrationEvidence(data, sha) {
  assert.match(sha, SHA);
  assert.equal(data?.issue?.number, ISSUE);
  const pull = data.pullRequest;
  assert.ok(positive(pull?.number));
  assert.equal(pull?.head?.sha, sha);
  assert.equal(pull?.base?.ref, 'main');
  assert.match(String(pull?.body || ''), /(?:^|\n)(?:Refs|Fixes|Closes) #4448\b/,
    'PR does not reference Issue #4448');
  sameRun(data.pagesRun, sha, pull.number);
  assert.ok(Array.isArray(data.pagesJobs?.jobs));
  const jobs = JOBS.map((spec) => requireJob(data.pagesJobs, spec, data.pagesRun));
  const artifact = data.artifact;
  assert.ok(positive(artifact?.id));
  assert.equal(artifact?.name, 'pages-parity-evidence');
  assert.equal(artifact?.expired, false);
  assert.equal(artifact?.workflow_run?.id, data.pagesRun.id);
  assert.ok(Number.isSafeInteger(artifact?.size_in_bytes) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ZIP);
  assert.ok(Array.isArray(data.zipMembers) &&
    data.zipMembers.length >= 1 && data.zipMembers.length <= MAX_JSONL);
  for (const member of data.zipMembers) {
    assert.match(member, /^parity-\d+\.jsonl$/);
  }
  assert.match(data.artifactSha256 || '', SHA256);
  const parity = verifyParityObservations(data.observations);
  return {
    schema_version: 1,
    kind: 'verified_pr_pages_migration_v1',
    repository: REPO,
    issue: ISSUE,
    head_sha: sha,
    pull_request: {
      number: pull.number,
      url: pull.html_url || ('https://github.com/' + REPO + '/pull/' + pull.number),
      state: pull.state,
      head_sha: pull.head.sha,
      base_ref: pull.base.ref,
    },
    pages_run: {
      id: data.pagesRun.id,
      run_attempt: data.pagesRun.run_attempt,
      html_url: data.pagesRun.html_url,
      created_at: data.pagesRun.created_at,
    },
    jobs,
    parity_artifact: {
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.size_in_bytes,
      sha256: data.artifactSha256,
    },
    parity,
  };
}

export function validPagesMigrationReceipt(receipt, sha) {
  if (!receipt || receipt.kind !== 'verified_pr_pages_migration_v1' ||
      receipt.repository !== REPO || receipt.issue !== ISSUE ||
      !SHA.test(String(sha)) || receipt.head_sha !== sha ||
      !positive(receipt.pages_run?.id) ||
      !positive(receipt.pages_run?.run_attempt) ||
      !positive(receipt.parity_artifact?.id) ||
      !SHA256.test(receipt.parity_artifact?.sha256 || '') ||
      receipt.parity?.observations !== ROUTES.length * VIEWPORTS.length * SCHEMES.length +
        INTERACTIONS.length ||
      receipt.parity?.routes !== ROUTES.length ||
      receipt.parity?.interactions !== INTERACTIONS.length ||
      receipt.parity?.baseline_sha !== BASELINE_SHA ||
      receipt.parity?.structural_mismatches !== 0 ||
      JSON.stringify(receipt.parity?.tolerance) !== JSON.stringify(TOLERANCE) ||
      !(receipt.parity?.worst_different_pixel_ratio <= TOLERANCE.maxDifferentPixelRatio)) {
    return false;
  }
  if (!Array.isArray(receipt.jobs) || receipt.jobs.length !== JOBS.length) return false;
  return JOBS.every((spec) => {
    const items = receipt.jobs.filter((job) => job?.name === spec.name);
    return items.length === 1 && positive(items[0].job_id) &&
      JSON.stringify(items[0].required_steps) === JSON.stringify(spec.steps);
  });
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'nession-trusted-pr-pages-migration-acceptance',
      authorization: 'Bearer ' + token,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('GitHub API HTTP ' + response.status + ' for ' + url);
  const text = await response.text();
  if (text.length > 2_000_000) throw Error('oversized GitHub JSON response');
  return JSON.parse(text);
}

function readZipEntries(zip) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-pages-parity-'));
  try {
    const file = path.join(directory, 'artifact.zip');
    fs.writeFileSync(file, zip, {flag: 'wx', mode: 0o600});
    const names = execFileSync('unzip', ['-Z1', file], {
      encoding: 'utf8', timeout: 20000, maxBuffer: 200000,
    }).trim().split('\n').filter(Boolean);
    assert.ok(names.length >= 1 && names.length <= MAX_JSONL);
    const observations = [];
    for (const name of names) {
      assert.match(name, /^parity-\d+\.jsonl$/);
      const content = execFileSync('unzip', ['-p', file, name], {
        encoding: 'utf8', timeout: 20000, maxBuffer: 2_000_000,
      });
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        observations.push(JSON.parse(line));
      }
    }
    assert.ok(observations.length <= MAX_RECORDS);
    return {names, observations};
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

export async function collect({root, token, issueNumber, stage}) {
  if (Number(issueNumber) !== ISSUE ||
      !['pr', 'pre-merge'].includes(String(stage))) {
    throw Error('unapproved PR-stage Pages migration evidence selector');
  }
  if (!token) throw Error('read-only GitHub token required');
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 15000,
  }).trim();
  assert.match(sha, SHA);
  const [pulls, runList] = await Promise.all([
    githubJson(API + '/commits/' + sha + '/pulls?per_page=100', token),
    githubJson(API + '/actions/runs?head_sha=' + sha +
      '&event=pull_request&per_page=100', token),
  ]);
  const candidates = (Array.isArray(pulls) ? pulls : []).filter((pull) =>
    pull?.head?.sha === sha && pull?.base?.ref === 'main' &&
    /(?:^|\n)(?:Refs|Fixes|Closes) #4448\b/.test(String(pull.body || '')));
  assert.equal(candidates.length, 1, 'exactly one exact-head PR referencing #4448 required');
  const pullRequest = candidates[0];
  const runs = (runList.workflow_runs || []).filter((run) =>
    run?.name === WORKFLOW_NAME && run?.path === WORKFLOW_PATH &&
    run?.event === 'pull_request' && run?.head_sha === sha &&
    run?.repository?.full_name === REPO &&
    run?.head_repository?.full_name === REPO &&
    run?.status === 'completed' && run?.conclusion === 'success' &&
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some((pull) => pull?.number === pullRequest.number))
    .sort((a, b) => b.id - a.id);
  assert.ok(runs.length >= 1, 'missing exact-head CI / Pages run');
  const pagesRun = runs[0];
  const [pagesJobs, artifactList] = await Promise.all([
    githubJson(API + '/actions/runs/' + pagesRun.id + '/attempts/' +
      pagesRun.run_attempt + '/jobs?per_page=100', token),
    githubJson(API + '/actions/runs/' + pagesRun.id + '/artifacts?per_page=100', token),
  ]);
  const artifacts = (artifactList.artifacts || []).filter((artifact) =>
    artifact?.name === 'pages-parity-evidence' && artifact?.expired === false &&
    artifact?.workflow_run?.id === pagesRun.id);
  assert.equal(artifacts.length, 1, 'missing/ambiguous Pages parity evidence artifact');
  const artifact = artifacts[0];
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ZIP);
  const zip = await downloadZip(artifact, token);
  assert.ok(zip.length <= MAX_ZIP);
  const {names, observations} = readZipEntries(zip);
  return verifyPagesMigrationEvidence({
    issue: {number: ISSUE},
    pullRequest,
    pagesRun,
    pagesJobs,
    artifact,
    zipMembers: names,
    observations,
    artifactSha256: hash(zip),
  }, sha);
}

function parityFixture() {
  const observations = [];
  for (const route of ROUTES) {
    for (const [width, height] of VIEWPORTS) {
      for (const colorScheme of SCHEMES) {
        observations.push({
          baseline_sha: BASELINE_SHA,
          route,
          path: '#/' + route,
          viewport: {width, height},
          color_scheme: colorScheme,
          title: {equal: true},
          text: {equal: true},
          links: {equal: true},
          geometry: {equal: true},
          screenshot: {equal: true, different_pixels: 0, total_pixels: 1000},
          tolerance: TOLERANCE,
        });
      }
    }
  }
  for (const interaction of INTERACTIONS) {
    observations.push({
      interaction,
      path: '#/' + interaction,
      text: {equal: true},
      links: {equal: true},
      geometry: {equal: true},
      screenshot: {equal: true, different_pixels: 1, total_pixels: 1000},
      tolerance: TOLERANCE,
    });
  }
  return observations;
}

function selfTestFixture() {
  const sha = 'a'.repeat(40);
  const run = {
    id: 101, run_attempt: 1, name: WORKFLOW_NAME, path: WORKFLOW_PATH,
    event: 'pull_request', head_sha: sha, status: 'completed',
    conclusion: 'success', repository: {full_name: REPO},
    head_repository: {full_name: REPO}, html_url: 'https://example.test/run/101',
    created_at: '2026-11-24T00:00:00Z',
    pull_requests: [{number: 4462}],
  };
  const job = (name, steps, id) => ({
    id, run_id: run.id, run_attempt: run.run_attempt, head_sha: sha,
    name, status: 'completed', conclusion: 'success',
    steps: steps.map((step) => ({name: step, status: 'completed', conclusion: 'success'})),
  });
  const pagesJobs = {jobs: JOBS.map((spec, index) => job(spec.name, spec.steps, 200 + index))};
  const artifact = {
    id: 301, name: 'pages-parity-evidence', expired: false,
    size_in_bytes: 1024, workflow_run: {id: run.id},
  };
  return {
    sha, run, pagesJobs, artifact,
    data: {
      issue: {number: ISSUE},
      pullRequest: {
        number: 4462, state: 'open', html_url: 'https://example.test/pull/4462',
        body: 'Refs #4448', head: {sha}, base: {ref: 'main'},
      },
      pagesRun: run,
      pagesJobs,
      artifact,
      zipMembers: ['parity-1.jsonl'],
      observations: parityFixture(),
      artifactSha256: 'b'.repeat(64),
    },
  };
}

async function selfTest() {
  const {sha, data} = selfTestFixture();
  const receipt = verifyPagesMigrationEvidence(data, sha);
  assert.equal(receipt.kind, 'verified_pr_pages_migration_v1');
  assert.equal(receipt.parity.observations, 273);
  assert.equal(receipt.parity.routes, 19);
  assert.equal(receipt.parity.interactions, 7);
  assert.equal(receipt.parity.structural_mismatches, 0);
  assert.equal(validPagesMigrationReceipt(receipt, sha), true);
  assert.equal(validPagesMigrationReceipt(receipt, 'c'.repeat(40)), false);
  const deny = (edit) => assert.throws(() => verifyPagesMigrationEvidence(edit(data), sha));
  deny((value) => ({...value, observations: value.observations.slice(1)}));
  deny((value) => ({...value, observations: [...value.observations,
    {...value.observations[0], route: 'overview'}]}));
  deny((value) => ({...value, observations: value.observations.map((record, index) =>
    index === 0 ? {...record, geometry: {equal: false}} : record)}));
  deny((value) => ({...value, observations: value.observations.map((record, index) =>
    index === 0 ? {...record, screenshot: {equal: true, different_pixels: 100, total_pixels: 1000}} : record)}));
  deny((value) => ({...value, observations: value.observations.map((record, index) =>
    index === 0 ? {...record, tolerance: {...TOLERANCE, maxDifferentPixelRatio: 0.01}} : record)}));
  deny((value) => ({...value, observations: value.observations.map((record, index) =>
    index === 0 ? {...record, baseline_sha: 'f'.repeat(40)} : record)}));
  deny((value) => ({...value, pullRequest: {...value.pullRequest, body: 'no issue'}}));
  deny((value) => ({...value, pullRequest: {...value.pullRequest, head: {sha: 'f'.repeat(40)}}}));
  deny((value) => ({...value, pagesRun: {...value.pagesRun, head_sha: 'f'.repeat(40)}}));
  deny((value) => ({...value, pagesRun: {...value.pagesRun, pull_requests: [{number: 1}]}}));
  deny((value) => ({...value, pagesJobs: {jobs: value.pagesJobs.jobs.slice(0, 1)}}));
  deny((value) => ({...value, pagesJobs: {jobs: [{...value.pagesJobs.jobs[0],
    steps: value.pagesJobs.jobs[0].steps.slice(0, 1)}, value.pagesJobs.jobs[1]]}}));
  deny((value) => ({...value, artifact: {...value.artifact, expired: true}}));
  deny((value) => ({...value, artifact: {...value.artifact, workflow_run: {id: 999}}}));
  deny((value) => ({...value, zipMembers: ['../escape.jsonl']}));
  deny((value) => ({...value, zipMembers: []}));
  const receiptWithoutJob = {...receipt, jobs: receipt.jobs.slice(0, 1)};
  assert.equal(validPagesMigrationReceipt(receiptWithoutJob, sha), false);
  assert.equal(validPagesMigrationReceipt({...receipt, head_sha: 'f'.repeat(40)}, sha), false);
  assert.equal(validPagesMigrationReceipt({...receipt,
    parity: {...receipt.parity, structural_mismatches: 1}}, sha), false);
  // The visual-triad fallback accepts this receipt only for a criterion that
  // explicitly names the standalone CI / Pages lane.
  const {enforcePrCiTriad, isPagesMigrationCriterion, requiresPrCiTriadCriterion} =
    await import('./acceptance-pr-ci-triad.mjs');
  const context = {
    stage: 'pr', target_ref: sha,
    criteria: [{criterion: 'SC-07',
      text: 'Exact-head CI / Pages browser smoke and parity at this PR head pass.'}],
    pr_ci_triad: {status: 'pending', reason: 'product browser_design not applicable'},
    pr_pages_migration: {status: 'pass', receipt},
  };
  const result = {criteria: [{criterion: 'SC-07', result: 'Pass', evidence: [], summary: ''}]};
  assert.equal(requiresPrCiTriadCriterion(context.criteria[0]), true);
  assert.equal(isPagesMigrationCriterion(context.criteria[0]), true);
  assert.equal(validPagesMigrationReceipt(context.pr_pages_migration.receipt,
    context.target_ref), true);
  const accepted = enforcePrCiTriad(context, result);
  assert.equal(accepted.criteria[0].result, 'Pass');
  assert.ok(accepted.criteria[0].evidence.some((item) => item.type === 'pages-ci'));
  const denied = enforcePrCiTriad({...context, pr_pages_migration: null}, result);
  assert.equal(denied.criteria[0].result, 'Pending');
  console.log('PR Pages migration acceptance: exact Run/Job/Step, ZIP artifact identity, 273-observation matrix, Pages-triad fallback and fail-closed negatives passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root, out] = process.argv.slice(2);
  if (mode === 'self-test') {
    selfTest().catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
  } else if (mode === 'collect') {
    collect({
      root,
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      issueNumber: process.env.ISSUE_NUMBER,
      stage: process.env.ACCEPTANCE_STAGE,
    }).then((receipt) => {
      fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
      console.log('Authenticated exact-head PR Pages migration CI/parity proof');
    }).catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
  } else {
    throw Error('usage: acceptance-pr-pages-migration-evidence.mjs self-test | collect ROOT OUTPUT');
  }
}
