'use strict';
// Shared read-only proof helpers for the #1664 post-merge Cases. Every helper
// re-reads public GitHub/Store bytes or runs the canonical exact-SHA selftest;
// nothing here writes a Store, Issue, PR or workflow.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function targetSha() {
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  assert.match(sha, HEX40, 'exact Acceptance target SHA is required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(head, sha, 'checkout HEAD is not the Acceptance target SHA');
  return sha;
}

function runNode(script, argsOrTimeout = 240000, timeoutMaybe) {
  const args = Array.isArray(argsOrTimeout) ? argsOrTimeout : [];
  const timeout = Array.isArray(argsOrTimeout) ? (timeoutMaybe ?? 240000) : argsOrTimeout;
  return execFileSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GITHUB_REPOSITORY: REPO, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
}

function requireSummary(output, text, label) {
  if (!String(output).includes(text)) {
    throw new Error(label + ' did not report: ' + text + '\n' + String(output).slice(-3500));
  }
}

function requireSource(file, patterns) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [expression, label] of patterns) assert.match(text, expression, label + ' (' + file + ')');
  return text;
}

async function read(url, json = true) {
  const host = new URL(url).hostname;
  assert.equal(host, 'api.github.com', 'only the fixed GitHub API origin is allowed');
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nession-1664-post-merge-proof',
    'Cache-Control': 'no-cache',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  assert.equal(response.status, 200, 'public GitHub evidence unavailable: HTTP ' +
    response.status + ' ' + new URL(url).pathname);
  return json ? response.json() : response.text();
}

async function api(route) {
  return read(API + route);
}

async function storeJson(storePath) {
  const entry = await api('/contents/' + storePath + '?ref=agent-store');
  assert.equal(entry.encoding, 'base64', 'Store entry is not a regular blob: ' + storePath);
  assert.match(entry.sha, HEX40, 'Store blob SHA is invalid');
  const bytes = Buffer.from(entry.content.replace(/\s/g, ''), 'base64');
  assert.ok(bytes.length > 1 && bytes.length <= 1024 * 1024, 'Store blob is empty or oversized');
  return JSON.parse(bytes.toString('utf8'));
}

async function assertAncestor(sha, target) {
  assert.match(sha, HEX40);
  // The exact-SHA Case checkout is intentionally shallow, so old chain commits
  // are not local Git objects. The trusted GitHub compare endpoint re-reads the
  // real ancestry without requiring an unshallow of the target checkout.
  const comparison = await api('/compare/' + sha + '...' + target);
  assert.equal(comparison.merge_base_commit?.sha, sha,
    'chain SHA is not an ancestor of the Acceptance target');
  assert.ok(['ahead', 'identical'].includes(comparison.status),
    'unexpected GitHub compare status for chain SHA');
}

async function verifyRun(id, { attempt, name, path: workflowPath, event, headSha,
  actor, headBranch = 'main' }) {
  const run = await api('/actions/runs/' + id);
  assert.equal(run.id, id);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.name, name);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, event);
  assert.equal(run.head_sha, headSha);
  assert.equal(run.head_branch, headBranch);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  if (actor != null) assert.equal(run.actor?.login, actor);
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  return run;
}

async function storeBytes(storePath) {
  const entry = await api('/contents/' + storePath + '?ref=agent-store');
  assert.equal(entry.encoding, 'base64', 'Store entry is not a regular blob: ' + storePath);
  assert.match(entry.sha, HEX40, 'Store blob SHA is invalid');
  const bytes = Buffer.from(entry.content.replace(/\s/g, ''), 'base64');
  assert.ok(bytes.length > 1 && bytes.length <= 1024 * 1024,
    'Store blob is empty or oversized');
  return bytes;
}

async function fileAt(filePath, ref) {
  const entry = await api('/contents/' + filePath + '?ref=' + encodeURIComponent(ref));
  assert.equal(entry.encoding, 'base64', 'file entry is not a regular blob: ' + filePath);
  const bytes = Buffer.from(entry.content.replace(/\s/g, ''), 'base64');
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, 'file is empty or oversized');
  return bytes.toString('utf8');
}

// Public raw Git bytes are not subject to the unauthenticated REST budget that
// the Case runner shares with other jobs. The content-addressed ref makes the
// read immutable.
async function rawEvidence(pathname) {
  const url = 'https://raw.githubusercontent.com/BestNathan/nession/' + pathname;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'nession-1664-case-proof', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, 200,
    'public raw evidence unavailable: HTTP ' + response.status + ' ' + pathname);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024,
    'raw evidence is empty or oversized: ' + pathname);
  return bytes;
}

async function rawStore(storePath) {
  return rawEvidence('agent-store/' + storePath);
}

async function rawFileAt(filePath, ref) {
  assert.match(ref, HEX40, 'raw file ref must be an exact commit SHA');
  return rawEvidence(ref + '/' + filePath);
}

const QWEN = Object.freeze({
  developerRun: 42344231027,
  developerSha: 'c5372a9c4865750182319f38ec642238b23dc2f5',
  storeIngestRun: 42353290383,
  storeIngestSha: '0bd85f78ce315323c617d11e65d0cc9861cebe35',
  publisherRun: 42353330828,
  reviewRun: 42354175666,
  reviewAttempt: 6,
  prHead: '52ecf6640f6d22f97e58a3ef559aa03493651680',
  prMerge: '357b5aa17554cbdeb426c1bb94ca710f82caf8cf',
  prNumber: 2891,
  workerAction: '1eafaeb9a57b5ed5619fb0bfbce7474b11618239348ec334f142020b95ee9ef7',
  reviewAction: '152e80d25594beccd24b4b1f60820c5def69393a7af8cd1f81bcab6a77c8c6f1',
});

async function verifyQwenChain(target) {
  const [developer, review, pr, state] = await Promise.all([
    verifyRun(QWEN.developerRun, {
      attempt: 1, name: 'Agent / Development',
      path: '.github/workflows/agent-develop.yml', event: 'workflow_dispatch',
      headSha: QWEN.developerSha, actor: 'github-actions[bot]',
    }),
    verifyRun(QWEN.reviewRun, {
      attempt: QWEN.reviewAttempt, name: 'Agent / Review',
      path: '.github/workflows/agent-review.yml', event: 'workflow_dispatch',
      headSha: QWEN.storeIngestSha, actor: 'github-actions[bot]',
    }),
    api('/pulls/' + QWEN.prNumber),
    storeJson('workflows/issues/2817/states/00000016.json'),
  ]);
  assert.equal(pr.number, QWEN.prNumber);
  assert.equal(pr.state, 'closed');
  assert.equal(pr.merged, true);
  assert.equal(pr.head?.sha, QWEN.prHead);
  assert.equal(pr.head?.repo?.full_name, REPO);
  assert.equal(pr.base?.ref, 'main');
  assert.equal(pr.merge_commit_sha, QWEN.prMerge);
  assert.equal(pr.merged_by?.login, 'BestNathan');
  assert.equal(state.version, 16);
  assert.equal(state.phase, 'quality');
  assert.equal(state.target_sha, QWEN.prHead);
  assert.equal(state.assignments?.developer, 'dev-qwen-01');
  assert.equal(state.assignments?.reviewer, 'review-qwen-01');
  assert.equal(state.assignments?.acceptor, 'accept-qwen-01');
  const transition = (kind, run, attempt, outcome) => state.transitions?.some(t =>
    t.kind === kind && t.run_id === run && t.attempt === attempt &&
    t.target_sha === QWEN.prHead && t.outcome === outcome);
  assert.ok(transition('publisher', QWEN.publisherRun, 1, 'published'),
    'Store lacks the authenticated Publisher transition');
  assert.ok(transition('reviewer', QWEN.reviewRun, QWEN.reviewAttempt, 'approved'),
    'Store lacks the authenticated Reviewer approval');
  await assertAncestor(QWEN.developerSha, target);
  await assertAncestor(QWEN.storeIngestSha, target);
  await assertAncestor(QWEN.prMerge, target);
  return [
    { type: 'runtime', value: 'real Qwen Developer Run ' + developer.id + '/1 completed/success at ' + QWEN.developerSha + '; Store Ingest ' + QWEN.storeIngestRun + '; Publisher ' + QWEN.publisherRun },
    { type: 'runtime', value: 'real PR #' + QWEN.prNumber + ' head ' + QWEN.prHead + ' merged by the owner at ' + QWEN.prMerge + '; Reviewer Run ' + review.id + '/' + QWEN.reviewAttempt + ' approved that exact head' },
    { type: 'store', value: 'agent-store state v16 has publisher:' + QWEN.publisherRun + '=published and reviewer:' + QWEN.reviewRun + '/' + QWEN.reviewAttempt + '=approved at ' + QWEN.prHead + '; all chain SHAs are ancestors of target ' + target },
  ];
}

// #1664 SC-17: the real controlled v4 repair chain. Unlike the #2817 chain
// (initial publication + approval), this fixture was reviewed once at SHA A,
// sent back through the SAME resumed Developer, republished at SHA B and
// approved there. Every identity below is pinned from the exact Runs/Store
// bytes; the Case re-reads them instead of trusting Issue prose.
const REPAIR_2961 = Object.freeze({
  issue: 2961,
  initSha: '1244766abad9d2496492e67d49a158a35b877bbc',
  fixSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
  shaA: '1f925d21129fe5731aec4235a9ff680ac7453785',
  shaB: 'cfe6eacdce242086b6f549645fbf8a7b05c100ad',
  prNumber: 2963,
  prMerge: '6de4b645c75255e1762ac8ba7de8657aabbeab4e',
  branch: 'agent/2961/qwen-9362b32b6c256474',
  file: 'e2e/fixtures/agent-development/qwen-repair-source-v4.md',
  actions: Object.freeze({
    init: '9362b32b6c256474bca3d38a7fb945f32303a92f5b85812892e4aec9b6c22d4a',
    reviewA: '785a872c628f4ccd93ab40170de031502faf57f7b98b2fa5c4aa7b801005c851',
    repair: '5457a863166cef80b723a43cc60d6d690b34a223e4f3084aca15517bb28fac90',
    reviewB: '6d4b22deb807e20b8745cfa9d6f50a7b10cc285b1b620ae958f4935ec45d7d2a',
  }),
  checkpoints: Object.freeze({
    initial: Object.freeze({
      version: 1,
      commit: '1841f76e2a3fa8d87a70937977b0005706ce9736',
      ciphertext: '26699f1d6f2b6f6242c22330b813c634e12afe67987adac114098495b1cc5a96',
      path: 'roles/developer/dev-qwen-01/issues/2961/checkpoints/00000001.json',
      receipt: 'roles/developer/dev-qwen-01/issues/2961/runs/42401513247-1.json',
    }),
    repair: Object.freeze({
      version: 2,
      commit: 'e7ba4e329cfcf8372f23cf1f332ecafc95812954',
      ciphertext: '00b4eb8ddd35bfee54d0393461aca74abd5094f90a31b956a08de37683ddab9d',
      path: 'roles/developer/dev-qwen-01/issues/2961/checkpoints/00000002.json',
      receipt: 'roles/developer/dev-qwen-01/issues/2961/runs/42403004351-1.json',
    }),
  }),
  runs: Object.freeze({
    request: Object.freeze({ id: 42401380057, attempt: 1,
      name: 'Acceptance / Agent Controller',
      path: '.github/workflows/acceptance-agent-controller.yml',
      event: 'workflow_dispatch', headSha: '1244766abad9d2496492e67d49a158a35b877bbc',
      actor: 'BestNathan' }),
    controllerIngest: Object.freeze({ id: 42401398831, attempt: 1,
      name: 'Store / Agent Controller Ingest',
      path: '.github/workflows/store-agent-controller-ingest.yml',
      event: 'workflow_run', headSha: '1244766abad9d2496492e67d49a158a35b877bbc',
      actor: 'BestNathan' }),
    initDispatch: Object.freeze({ id: 42401476302, attempt: 1,
      name: 'Agent / Controller Dispatch',
      path: '.github/workflows/agent-controller-dispatch.yml',
      event: 'workflow_dispatch', headSha: '1244766abad9d2496492e67d49a158a35b877bbc',
      actor: 'BestNathan' }),
    developerA: Object.freeze({ id: 42401513247, attempt: 1,
      name: 'Agent / Development', path: '.github/workflows/agent-develop.yml',
      event: 'workflow_dispatch', headSha: '1244766abad9d2496492e67d49a158a35b877bbc',
      actor: 'github-actions[bot]' }),
    devIngestA: Object.freeze({ id: 42402389235, attempt: 1,
      name: 'Store / Agent Development Ingest',
      path: '.github/workflows/store-agent-development-ingest.yml',
      event: 'issue_comment', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    publisherA: Object.freeze({ id: 42402434528, attempt: 1,
      name: 'Store / Qwen Publisher',
      path: '.github/workflows/store-qwen-publisher.yml',
      event: 'workflow_run', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    reviewDispatchA: Object.freeze({ id: 42402562688, attempt: 1,
      name: 'Agent / Controller Dispatch',
      path: '.github/workflows/agent-controller-dispatch.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    reviewerA: Object.freeze({ id: 42402597971, attempt: 1,
      name: 'Agent / Review', path: '.github/workflows/agent-review.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'github-actions[bot]' }),
    reviewIngestA: Object.freeze({ id: 42402794746, attempt: 1,
      name: 'Store / Agent Review Result Ingest',
      path: '.github/workflows/store-agent-review-result-ingest.yml',
      event: 'repository_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'github-actions[bot]' }),
    repairDispatch: Object.freeze({ id: 42402956330, attempt: 1,
      name: 'Agent / Controller Dispatch',
      path: '.github/workflows/agent-controller-dispatch.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    developerB: Object.freeze({ id: 42403004351, attempt: 1,
      name: 'Agent / Development', path: '.github/workflows/agent-develop.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'github-actions[bot]' }),
    devIngestB: Object.freeze({ id: 42403167451, attempt: 1,
      name: 'Store / Agent Development Ingest',
      path: '.github/workflows/store-agent-development-ingest.yml',
      event: 'issue_comment', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    publisherB: Object.freeze({ id: 42403209086, attempt: 1,
      name: 'Store / Qwen Publisher',
      path: '.github/workflows/store-qwen-publisher.yml',
      event: 'workflow_run', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    reviewDispatchB: Object.freeze({ id: 42403321929, attempt: 1,
      name: 'Agent / Controller Dispatch',
      path: '.github/workflows/agent-controller-dispatch.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'BestNathan' }),
    reviewerB: Object.freeze({ id: 42403363557, attempt: 1,
      name: 'Agent / Review', path: '.github/workflows/agent-review.yml',
      event: 'workflow_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'github-actions[bot]' }),
    reviewIngestB: Object.freeze({ id: 42403537430, attempt: 1,
      name: 'Store / Agent Review Result Ingest',
      path: '.github/workflows/store-agent-review-result-ingest.yml',
      event: 'repository_dispatch', headSha: 'f610d133cd245329ecf42f69e95e14327e0fd981',
      actor: 'github-actions[bot]' }),
    quality: Object.freeze({ id: 42403269834, attempt: 1,
      name: 'CI / Quality Gate', path: '.github/workflows/ci-quality.yml',
      event: 'pull_request', headSha: 'cfe6eacdce242086b6f549645fbf8a7b05c100ad',
      actor: 'nession-publisher[bot]', headBranch: 'agent/2961/qwen-9362b32b6c256474' }),
    e2e: Object.freeze({ id: 42403269775, attempt: 1,
      name: 'E2E / Tests', path: '.github/workflows/e2e-tests.yml',
      event: 'pull_request', headSha: 'cfe6eacdce242086b6f549645fbf8a7b05c100ad',
      actor: 'nession-publisher[bot]', headBranch: 'agent/2961/qwen-9362b32b6c256474' }),
    caseSmoke: Object.freeze({ id: 42403269793, attempt: 1,
      name: 'Acceptance / Case Smoke',
      path: '.github/workflows/acceptance-case-smoke.yml',
      event: 'pull_request', headSha: 'cfe6eacdce242086b6f549645fbf8a7b05c100ad',
      actor: 'nession-publisher[bot]', headBranch: 'agent/2961/qwen-9362b32b6c256474' }),
    acceptance: Object.freeze({ id: 42403268820, attempt: 1,
      name: 'Acceptance / Orchestrator',
      path: '.github/workflows/acceptance-orchestrator.yml',
      event: 'pull_request_target', headSha: 'cfe6eacdce242086b6f549645fbf8a7b05c100ad',
      actor: 'nession-publisher[bot]', headBranch: 'agent/2961/qwen-9362b32b6c256474' }),
  }),
});

async function verifyQwenRepairChain2961(target) {
  // The Case checkout is shallow. Re-read ancestry from GitHub, then verify
  // only the core chain Runs. Publisher/Ingest/Controller Run IDs are bound by
  // the committed Store transitions and result records; re-fetching all of
  // them would exhaust the unauthenticated Case API budget without adding
  // evidence. Store bytes and the fixture diff come from raw.githubusercontent
  // so the remaining API calls stay bounded.
  for (const sha of [REPAIR_2961.initSha, REPAIR_2961.prMerge]) {
    await assertAncestor(sha, target);
  }
  const verified = {};
  for (const key of ['developerA', 'reviewerA', 'developerB', 'reviewerB',
    'quality', 'acceptance']) {
    const spec = REPAIR_2961.runs[key];
    verified[key] = await verifyRun(spec.id, spec);
  }
  const [pr, files] = await Promise.all([
    api('/pulls/' + REPAIR_2961.prNumber),
    api('/pulls/' + REPAIR_2961.prNumber + '/files?per_page=100'),
  ]);
  assert.equal(pr.number, REPAIR_2961.prNumber);
  assert.equal(pr.state, 'closed');
  assert.equal(pr.merged, true);
  assert.equal(pr.head?.sha, REPAIR_2961.shaB);
  assert.equal(pr.head?.ref, REPAIR_2961.branch);
  assert.equal(pr.head?.repo?.full_name, REPO);
  assert.equal(pr.base?.ref, 'main');
  assert.equal(pr.merge_commit_sha, REPAIR_2961.prMerge);
  assert.equal(pr.merged_by?.login, 'BestNathan');
  assert.equal(files.length, 1, 'the controlled fixture PR must change exactly one file');
  assert.equal(files[0].filename, REPAIR_2961.file);
  assert.equal(files[0].status, 'modified');
  const base = (await rawFileAt(REPAIR_2961.file, pr.base.sha)).toString('utf8');
  const head = (await rawFileAt(REPAIR_2961.file, REPAIR_2961.shaB)).toString('utf8');
  const baseState = base.split('## Required final content')[0];
  const headState = head.split('## Required final content')[0];
  assert.match(baseState, /^implementation: pending$/m,
    'SHA A base did not contain the phase-1 starting marker');
  assert.match(baseState, /^verification: missing$/m,
    'SHA A base did not contain the missing verification marker');
  assert.match(headState, /^implementation: qwen-verified$/m,
    'SHA B did not establish the implementation marker');
  assert.match(headState, /^verification: complete$/m,
    'SHA B did not establish the repaired verification marker');
  assert.doesNotMatch(headState, /^review:/m,
    'the Developer must not author the Reviewer-owned review marker');
  assert.match(head, /^review: pending$/m,
    'the fixture contract lost its Reviewer-owned review marker');

  const pointer = JSON.parse((await rawStore('workflows/issues/2961/head.json'))
    .toString('utf8'));
  assert.equal(pointer.version, 14);
  assert.equal(pointer.path, 'workflows/issues/2961/states/00000014.json');
  const stateBytes = await rawStore(pointer.path);
  assert.equal(crypto.createHash('sha256').update(stateBytes).digest('hex'),
    pointer.sha256, 'agent-store head does not commit the exact state bytes');
  const state = JSON.parse(stateBytes.toString('utf8'));
  assert.equal(state.version, 14);
  assert.equal(state.issue, REPAIR_2961.issue);
  assert.equal(state.phase, 'quality');
  assert.equal(state.target_sha, REPAIR_2961.shaB);
  assert.equal(state.assignments?.developer, 'dev-qwen-01');
  assert.equal(state.assignments?.reviewer, 'review-qwen-01');
  assert.equal(state.assignments?.acceptor, 'accept-qwen-01');
  assert.equal(state.transitions?.length, 4, 'Store must contain exactly the four chain transitions');
  const transition = (kind, run, targetSha, outcome) => state.transitions.some(t =>
    t.kind === kind && t.run_id === run && t.attempt === 1 &&
    t.target_sha === targetSha && t.outcome === outcome);
  assert.ok(transition('publisher', REPAIR_2961.runs.publisherA.id,
    REPAIR_2961.shaA, 'published'), 'missing Publisher A publication at SHA A');
  assert.ok(transition('reviewer', REPAIR_2961.runs.reviewerA.id,
    REPAIR_2961.shaA, 'changes_requested'), 'missing changes_requested at SHA A');
  assert.ok(transition('publisher', REPAIR_2961.runs.publisherB.id,
    REPAIR_2961.shaB, 'published'), 'missing repair publication at SHA B');
  assert.ok(transition('reviewer', REPAIR_2961.runs.reviewerB.id,
    REPAIR_2961.shaB, 'approved'), 'missing approval at SHA B');

  const storeJson = async path => JSON.parse((await rawStore(path)).toString('utf8'));
  const initialIntent = await storeJson('workflows/issues/2961/results/' +
    REPAIR_2961.runs.developerA.id + '-1-' + REPAIR_2961.actions.init + '.json');
  assert.equal(initialIntent.kind, 'trusted_qwen_publisher_write_ahead_intent');
  assert.equal(initialIntent.issue, REPAIR_2961.issue);
  assert.equal(initialIntent.action_id, REPAIR_2961.actions.init);
  assert.equal(initialIntent.worker_run_id, REPAIR_2961.runs.developerA.id);
  assert.equal(initialIntent.worker_source_sha, REPAIR_2961.initSha);
  assert.equal(initialIntent.source_sha, REPAIR_2961.fixSha);
  assert.equal(initialIntent.target_main_sha, REPAIR_2961.fixSha);
  assert.equal(initialIntent.checkpoint_version, REPAIR_2961.checkpoints.initial.version);
  assert.equal(initialIntent.checkpoint_commit_sha, REPAIR_2961.checkpoints.initial.commit);
  assert.equal(initialIntent.checkpoint_ciphertext_sha256,
    REPAIR_2961.checkpoints.initial.ciphertext);
  assert.equal(initialIntent.branch, REPAIR_2961.branch);
  assert.equal(initialIntent.publisher_run_id, REPAIR_2961.runs.publisherA.id);

  const repairIntent = await storeJson('workflows/issues/2961/results/' +
    REPAIR_2961.runs.developerB.id + '-1-' + REPAIR_2961.actions.repair + '.json');
  assert.equal(repairIntent.kind, 'trusted_qwen_repair_publisher_write_ahead');
  assert.equal(repairIntent.issue, REPAIR_2961.issue);
  assert.equal(repairIntent.action_id, REPAIR_2961.actions.repair);
  assert.equal(repairIntent.worker_run_id, REPAIR_2961.runs.developerB.id);
  assert.equal(repairIntent.worker_sha, REPAIR_2961.fixSha);
  assert.equal(repairIntent.source_sha, REPAIR_2961.shaA);
  assert.equal(repairIntent.original_main_sha, REPAIR_2961.fixSha);
  assert.equal(repairIntent.original_publisher_run_id, REPAIR_2961.runs.publisherA.id);
  assert.equal(repairIntent.branch, 'refs/heads/' + REPAIR_2961.branch);
  assert.equal(repairIntent.checkpoint_version, REPAIR_2961.checkpoints.repair.version);
  assert.equal(repairIntent.checkpoint_commit_sha, REPAIR_2961.checkpoints.repair.commit);
  assert.equal(repairIntent.checkpoint_ciphertext_sha256,
    REPAIR_2961.checkpoints.repair.ciphertext);
  assert.equal(repairIntent.publisher_run_id, REPAIR_2961.runs.publisherB.id);

  const initialReceipt = await storeJson(REPAIR_2961.checkpoints.initial.receipt);
  assert.equal(initialReceipt.kind, 'agent_checkpoint_run');
  assert.equal(initialReceipt.role, 'developer');
  assert.equal(initialReceipt.agent_id, 'dev-qwen-01');
  assert.equal(initialReceipt.issue, REPAIR_2961.issue);
  assert.equal(initialReceipt.run_id, REPAIR_2961.runs.developerA.id);
  assert.equal(initialReceipt.attempt, 1);
  assert.equal(initialReceipt.source_sha, REPAIR_2961.initSha);
  assert.equal(initialReceipt.workflow_sha, REPAIR_2961.initSha);
  assert.equal(initialReceipt.version, REPAIR_2961.checkpoints.initial.version);
  assert.equal(initialReceipt.checkpoint_path, REPAIR_2961.checkpoints.initial.path);
  assert.equal(initialReceipt.ciphertext_sha256, REPAIR_2961.checkpoints.initial.ciphertext);

  const repairReceipt = await storeJson(REPAIR_2961.checkpoints.repair.receipt);
  assert.equal(repairReceipt.kind, 'agent_checkpoint_run');
  assert.equal(repairReceipt.role, 'developer');
  assert.equal(repairReceipt.agent_id, 'dev-qwen-01');
  assert.equal(repairReceipt.issue, REPAIR_2961.issue);
  assert.equal(repairReceipt.run_id, REPAIR_2961.runs.developerB.id);
  assert.equal(repairReceipt.attempt, 1);
  assert.equal(repairReceipt.source_sha, REPAIR_2961.shaA,
    'repair checkpoint is not bound to the reviewed SHA A');
  assert.equal(repairReceipt.workflow_sha, REPAIR_2961.fixSha);
  assert.equal(repairReceipt.version, REPAIR_2961.checkpoints.repair.version);
  assert.equal(repairReceipt.checkpoint_path, REPAIR_2961.checkpoints.repair.path);
  assert.equal(repairReceipt.ciphertext_sha256, REPAIR_2961.checkpoints.repair.ciphertext);
  assert.equal(repairReceipt.harness_digest, initialReceipt.harness_digest,
    'repair did not resume the same Developer harness');

  const reviewA = await storeJson('workflows/issues/2961/results/' +
    REPAIR_2961.runs.reviewerA.id + '-1-' + REPAIR_2961.actions.reviewA + '.json');
  assert.equal(reviewA.kind, 'authenticated_agent_task_result');
  assert.equal(reviewA.issue, REPAIR_2961.issue);
  assert.equal(reviewA.action_id, REPAIR_2961.actions.reviewA);
  assert.equal(reviewA.result?.target_sha, REPAIR_2961.shaA);
  assert.equal(reviewA.result?.outcome, 'changes_requested');

  const reviewB = await storeJson('workflows/issues/2961/results/' +
    REPAIR_2961.runs.reviewerB.id + '-1-' + REPAIR_2961.actions.reviewB + '.json');
  assert.equal(reviewB.kind, 'authenticated_agent_task_result');
  assert.equal(reviewB.issue, REPAIR_2961.issue);
  assert.equal(reviewB.action_id, REPAIR_2961.actions.reviewB);
  assert.equal(reviewB.result?.target_sha, REPAIR_2961.shaB);
  assert.equal(reviewB.result?.outcome, 'approved');

  return [
    { type: 'runtime', value: 'real Qwen Developer run ' +
      REPAIR_2961.runs.developerA.id + '/1 published SHA A ' + REPAIR_2961.shaA +
      '; Reviewer run ' + REPAIR_2961.runs.reviewerA.id +
      '/1 recorded changes_requested; the SAME dev-qwen-01 resumed checkpoint v1 and run ' +
      REPAIR_2961.runs.developerB.id + '/1 produced SHA B ' + REPAIR_2961.shaB +
      '; Reviewer run ' + REPAIR_2961.runs.reviewerB.id + '/1 approved SHA B' },
    { type: 'store', value: 'agent-store state v14 commits publisher:' +
      REPAIR_2961.runs.publisherA.id + '=published@' + REPAIR_2961.shaA +
      ', reviewer:' + REPAIR_2961.runs.reviewerA.id + '=changes_requested@' + REPAIR_2961.shaA +
      ', publisher:' + REPAIR_2961.runs.publisherB.id + '=published@' + REPAIR_2961.shaB +
      ', reviewer:' + REPAIR_2961.runs.reviewerB.id + '=approved@' + REPAIR_2961.shaB +
      '; checkpoint commits ' + REPAIR_2961.checkpoints.initial.commit + ' and ' +
      REPAIR_2961.checkpoints.repair.commit + ' are committed Store objects' },
    { type: 'runtime', value: 'exact-SHA PR #' + REPAIR_2961.prNumber + ' head ' +
      REPAIR_2961.shaB + ' changed only ' + REPAIR_2961.file +
      ' from implementation pending/verification missing to implementation qwen-verified/verification complete; ' +
      'CI / Quality Gate ' + REPAIR_2961.runs.quality.id + ' and Acceptance / Orchestrator ' +
      REPAIR_2961.runs.acceptance.id + ' completed successfully at that exact head; ' +
      'the owner merged it at ' + REPAIR_2961.prMerge +
      '; init and merge SHAs are ancestors of target ' + target },
  ];
}

function pass(summary, evidence) {
  assert.ok(Array.isArray(evidence) && evidence.length > 0);
  process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
}

function fail(error) {
  const summary = String(error && error.message ? error.message : error).slice(-4400);
  process.stdout.write(JSON.stringify({
    status: 'fail', summary,
    evidence: [{ type: 'runtime', value: 'exact-SHA selftest or public GitHub/Store proof did not establish the criterion' }],
  }) + '\n');
  process.exitCode = 1;
}

module.exports = {
  assert, fs, path, root, REPO, API, HEX40, HEX64, QWEN, REPAIR_2961,
  targetSha, runNode, requireSummary, requireSource, read, api, storeJson,
  storeBytes, fileAt, assertAncestor, verifyRun, verifyQwenChain,
  verifyQwenRepairChain2961, pass, fail,
};
