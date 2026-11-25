// Issue #4526 SC-01/SC-02 — real remote Store CAS/readback through the
// existing agent-store publisher and no-force Git CAS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifecycleState } from './contract.mjs';
import { createRemoteStorePort } from './apply.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1', ...options.env },
  }).trim();
}
function fresh(issue) {
  return createLifecycleState({
    registry, issue, base_sha: BASE, developer: 'dev-cursor-01',
    reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
    developer_sha: BASE, authority, now: 1000,
  });
}

const root = mkdtempSync(path.join(os.tmpdir(), 'agent-apply-store-'));
try {
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'remote.git');
  mkdirSync(seed);
  git(seed, ['init', '-q']);
  git(seed, ['config', 'user.name', 'fixture']);
  git(seed, ['config', 'user.email', 'fixture@example.com']);
  git(seed, ['commit', '--allow-empty', '-q', '-m', 'bootstrap']);
  execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' });
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/agent-store']);

  const remote = 'file://' + bare;
  const port = createRemoteStorePort({ remote });
  try {
    const state = fresh(4526);
    const written = await port.cas(state, 0);
    assert.equal(written.conflict, undefined);
    assert.equal(written.version, 1);
    assert.match(written.commit_sha, /^[a-f0-9]{40}$/);

    const loaded = await port.load(4526);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.state.issue, 4526);
    assert.equal(loaded.state.phase, 'authorized');

    // A stale expected version is a conflict, not an overwrite.
    const conflict = await port.cas({ ...state, version: 2 }, 5);
    assert.equal(conflict.conflict, true);
    const unchanged = await port.load(4526);
    assert.equal(unchanged.version, 1);
  } finally {
    await port.close();
  }

  // A fresh port observes the exact committed remote head.
  const second = createRemoteStorePort({ remote });
  try {
    const loaded = await second.load(4526);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.state.outbox[0].role, 'developer');
  } finally {
    await second.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('agent workflow apply store selftest: OK');
