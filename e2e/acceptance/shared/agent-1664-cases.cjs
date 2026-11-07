'use strict';
// Shared read-only proof helpers for the #1664 post-merge Cases. Every helper
// re-reads public GitHub/Store bytes or runs the canonical exact-SHA selftest;
// nothing here writes a Store, Issue, PR or workflow.
const assert = require('node:assert/strict');
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

function assertAncestor(sha, target) {
  assert.match(sha, HEX40);
  execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', sha, target], {
    stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function verifyRun(id, { attempt, name, path: workflowPath, event, headSha, actor }) {
  const run = await api('/actions/runs/' + id);
  assert.equal(run.id, id);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.name, name);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, event);
  assert.equal(run.head_sha, headSha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.actor?.login, actor);
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  return run;
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
  assertAncestor(QWEN.developerSha, target);
  assertAncestor(QWEN.storeIngestSha, target);
  assertAncestor(QWEN.prMerge, target);
  return [
    { type: 'runtime', value: 'real Qwen Developer Run ' + developer.id + '/1 completed/success at ' + QWEN.developerSha + '; Store Ingest ' + QWEN.storeIngestRun + '; Publisher ' + QWEN.publisherRun },
    { type: 'runtime', value: 'real PR #' + QWEN.prNumber + ' head ' + QWEN.prHead + ' merged by the owner at ' + QWEN.prMerge + '; Reviewer Run ' + review.id + '/' + QWEN.reviewAttempt + ' approved that exact head' },
    { type: 'store', value: 'agent-store state v16 has publisher:' + QWEN.publisherRun + '=published and reviewer:' + QWEN.reviewRun + '/' + QWEN.reviewAttempt + '=approved at ' + QWEN.prHead + '; all chain SHAs are ancestors of target ' + target },
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
  assert, fs, path, root, REPO, API, HEX40, HEX64, QWEN,
  targetSha, runNode, requireSummary, requireSource, read, api, storeJson,
  assertAncestor, verifyRun, verifyQwenChain, pass, fail,
};
