'use strict';
// Exact-SHA evidence for the #2689 Claude Code Auto Memory Cases.
//
// The resolution, state vocabulary and read boundary live in
// `nession-claude-code`; the Workspace staleness guards live in the Web
// capability. Each Case names the tests that prove its SC and runs them in the
// target checkout — no fixture route invents a repository, a worktree or a
// Claude configuration.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  REPO_ROOT,
  emitPass,
  emitFailure,
  runtimeFromEnv,
} = require('./session-env-binding-cases.cjs');

const TEST_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 32 * 1024 * 1024;

function checkoutSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

function outputOf(result) {
  return String(result.stdout || '') + '\n' + String(result.stderr || '');
}

function runRustTests(names) {
  const result = spawnSync(
    'cargo',
    ['test', '-p', 'nession-claude-code', '--lib', 'memory', '--', '--nocapture'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const output = outputOf(result);
  if (result.status !== 0) {
    throw new Error(
      'cargo test -p nession-claude-code --lib memory failed (exit ' +
        result.status +
        '): ' +
        output.slice(-4000),
    );
  }
  for (const name of names) {
    if (!output.includes(name)) {
      throw new Error('Rust test did not run: ' + name + '\n' + output.slice(-4000));
    }
  }
  return names;
}

function runWebTests(files, names) {
  const web = path.join(REPO_ROOT, 'web');
  const result = spawnSync('npm', ['test', '--', ...files, '--reporter=verbose'], {
    cwd: web,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  if (result.error) throw result.error;
  const output = outputOf(result);
  if (result.status !== 0) {
    throw new Error(
      'npm test ' + files.join(' ') + ' failed (exit ' + result.status + '): ' + output.slice(-4000),
    );
  }
  for (const name of names) {
    if (!output.includes(name)) {
      throw new Error('Web test did not run: ' + name + '\n' + output.slice(-4000));
    }
  }
  return names;
}

/**
 * Run one Case's exact-SHA proofs and emit its single result line.
 *
 * `rust` names the `nession-claude-code` tests the Case claims; `web` names the
 * Workspace tests. A named test that did not run is a failure, not a skip.
 */
function verifyClaudeMemoryCase({ summary, rust = [], web = null }) {
  try {
    const runtime = runtimeFromEnv();
    assert.match(runtime.target_sha, /^[a-f0-9]{40}$/);
    assert.equal(checkoutSha(), runtime.target_sha, 'Case checkout SHA mismatch');

    const evidence = [
      { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
    ];

    if (rust.length > 0) {
      const ran = runRustTests(rust);
      evidence.push({
        type: 'test',
        value: 'cargo test -p nession-claude-code --lib memory: ' + ran.join('; '),
      });
    }
    if (web) {
      const ran = runWebTests(web.files, web.names);
      evidence.push({
        type: 'test',
        value: 'npm test ' + web.files.join(' ') + ': ' + ran.join('; '),
      });
    }

    emitPass(summary, evidence);
  } catch (error) {
    emitFailure(error);
  }
}

module.exports = { verifyClaudeMemoryCase };
