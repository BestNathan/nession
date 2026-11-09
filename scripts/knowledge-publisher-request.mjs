#!/usr/bin/env node
// Issue #2358. Trusted-main request admission for a *data-only* Knowledge commit.
// An owner repository_dispatch requests one SHA-pinned, normal fast-forward;
// only the separately approved GitHub App publisher may perform the mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'BestNathan/nession';
const EVENT = 'knowledge-publish-v1';
const SHA = /^[0-9a-f]{40}$/;
const PROPOSAL_REF = /^refs\/heads\/knowledge-proposals\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-ledger-contract.mjs');

function fail(message) { throw Error('knowledge-publisher-request: ' + message); }
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0)
    fail('git ' + args[0] + ' failed: ' + (result.stderr || result.error?.message || 'unknown').trim());
  return result.stdout.trim();
}
function parseRequest(event, context) {
  if (!context || context.repository !== REPO || context.eventName !== 'repository_dispatch' ||
      context.ref !== 'refs/heads/main' || context.actor !== 'BestNathan' ||
      context.runAttempt !== '1' || !SHA.test(context.sha || ''))
    fail('only exact first-attempt owner dispatch on trusted main is admitted');
  if (!event || event.action !== EVENT || event.sender?.login !== 'BestNathan')
    fail('wrong event type or authenticated sender');
  const payload = event.client_payload;
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
      Object.keys(payload).sort().join(',') !== 'expected_head,proposal_ref,proposal_sha')
    fail('expected exactly proposal_ref, proposal_sha and expected_head');
  const { proposal_ref, proposal_sha, expected_head } = payload;
  if (typeof proposal_ref !== 'string' || !PROPOSAL_REF.test(proposal_ref))
    fail('proposal_ref must be a bounded knowledge-proposals branch');
  if (typeof proposal_sha !== 'string' || !SHA.test(proposal_sha) ||
      typeof expected_head !== 'string' || !SHA.test(expected_head) ||
      proposal_sha === expected_head)
    fail('two distinct exact 40-character SHA values are required');
  return { proposal_ref, proposal_sha, expected_head };
}
function remoteSha(root, ref) {
  const lines = git(root, 'ls-remote', '--heads', 'origin', ref).split('\n').filter(Boolean);
  if (lines.length !== 1) fail('ref missing or ambiguous: ' + ref);
  const [sha, observed] = lines[0].split(/\s+/);
  if (!SHA.test(sha) || observed !== ref) fail('unexpected remote ref readback');
  return sha;
}
function prepare(eventPath, destination) {
  if (typeof eventPath !== 'string' || !eventPath ||
      !fs.statSync(eventPath).isFile() || fs.statSync(eventPath).size > 8192)
    fail('missing or oversized GitHub event');
  const { proposal_ref, proposal_sha, expected_head } = parseRequest(
    JSON.parse(fs.readFileSync(eventPath, 'utf8')),
    { repository: process.env.GITHUB_REPOSITORY, eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF, actor: process.env.GITHUB_ACTOR,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA },
  );
  const root = process.cwd();
  if (git(root, 'rev-parse', 'HEAD') !== process.env.GITHUB_SHA ||
      !/^https:\/\/github\.com\/BestNathan\/nession(?:\.git)?$/.test(git(root, 'remote', 'get-url', 'origin')))
    fail('checkout is not the exact trusted main-owned source');
  if (!destination.startsWith(process.env.RUNNER_TEMP + path.sep) ||
      fs.existsSync(destination)) fail('destination must be fresh under RUNNER_TEMP');
  if (remoteSha(root, 'refs/heads/knowledge') !== expected_head)
    fail('STALE_HEAD: live Knowledge head differs from expected');
  if (remoteSha(root, proposal_ref) !== proposal_sha)
    fail('proposal ref moved or does not match requested SHA');
  git(root, 'fetch', '--no-tags', 'origin', 'refs/heads/knowledge');
  git(root, 'fetch', '--no-tags', 'origin', proposal_ref);
  if (git(root, 'rev-parse', 'FETCH_HEAD') !== proposal_sha)
    fail('fetched proposal is not the pinned commit');
  git(root, 'merge-base', '--is-ancestor', expected_head, proposal_sha);
  const localBranch = 'knowledge-publisher-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT;
  git(root, 'worktree', 'add', '-b', localBranch, destination, proposal_sha);
  if (git(destination, 'status', '--porcelain')) fail('candidate must be clean');
  const result = spawnSync(process.execPath, [CHECKER, 'check', destination, expected_head], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0)
    fail('canonical Knowledge contract denied candidate: ' + (result.stderr || result.error?.message || '').trim());
  const receipt = {
    schema_version: 1, event: EVENT, source_ref: proposal_ref,
    source_sha: proposal_sha, expected_head,
    trusted_main_sha: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    candidate_path: destination, status: 'validated_no_write',
  };
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'knowledge-publisher-admission.json'),
    JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
function selfTest() {
  const context = { repository: REPO, eventName: 'repository_dispatch', ref: 'refs/heads/main',
    actor: 'BestNathan', runAttempt: '1', sha: 'a'.repeat(40) };
  const payload = { proposal_ref: 'refs/heads/knowledge-proposals/issue-2358',
    proposal_sha: 'b'.repeat(40), expected_head: 'c'.repeat(40) };
  const event = { action: EVENT, sender: { login: 'BestNathan' }, client_payload: payload };
  assert.deepEqual(parseRequest(event, context), payload);
  for (const [key, value] of [
    ['actor', 'other-user'], ['eventName', 'workflow_dispatch'], ['ref', 'refs/heads/dev'],
    ['runAttempt', '2'], ['repository', 'other/nession'], ['sha', 'main'],
  ]) assert.throws(() => parseRequest(event, { ...context, [key]: value }));
  for (const changed of [
    { action: 'other' }, { sender: { login: 'attacker' } },
    { client_payload: { ...payload, command: 'sh bad.sh' } },
    { client_payload: { ...payload, proposal_ref: 'refs/heads/main' } },
    { client_payload: { ...payload, proposal_ref: 'refs/heads/knowledge-proposals/../../main' } },
    { client_payload: { ...payload, proposal_sha: payload.expected_head } },
    { client_payload: { ...payload, expected_head: 'not-a-sha' } },
  ]) assert.throws(() => parseRequest({ ...event, ...changed }, context));
  console.log('knowledge-publisher-request: exact owner/main dispatch and payload negative fixtures passed');
}
try {
  const [command, eventPath, destination] = process.argv.slice(2);
  if (command === 'self-test') selfTest();
  else if (command === 'prepare' && eventPath && destination) prepare(eventPath, destination);
  else fail('usage: self-test | prepare <github-event-json> <fresh-runner-temp-worktree>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
