'use strict';
// Shared machinery for source-aligned Cases whose proof is a deterministic
// React/Vitest contract at the exact target checkout (#2787).
//
// The Case names the exact file and assertions; this module only runs them and
// emits the concrete single-line evidence the Acceptance runner requires.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');

function targetSha() {
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('exact target SHA is required');
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('target checkout is not a git tree');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) throw new Error('cannot read the target checkout HEAD');
  if (String(head.stdout).trim() !== sha) {
    throw new Error('checkout HEAD is not the Acceptance target SHA');
  }
  return sha;
}

/**
 * Run one integration-project Vitest file and require every named assertion to
 * have executed and passed. Exit 0 alone is not enough: a renamed or skipped
 * test must fail the Case rather than silently shrink its proof.
 */
function webVitest(entry, names, timeout = 100000) {
  const web = path.join(root, 'web');
  const bin = path.join(web, 'node_modules', '.bin', 'vitest');
  if (!fs.existsSync(bin)) {
    throw new Error('vitest is not installed in the target checkout; run npm ci in web');
  }
  const result = spawnSync(
    bin,
    ['run', '--project=integration', '--reporter=verbose', '--no-color', entry],
    {
      cwd: web,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', CI: '1' },
    },
  );
  if (result.error) throw result.error;
  const output = String(result.stdout) + '\n' + String(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      'web contract failed (exit ' + result.status + '): ' + output.slice(-4500),
    );
  }
  for (const name of names) {
    if (!output.includes(name)) throw new Error('missing executed assertion: ' + name);
  }
  return output;
}

function run(fn) {
  try {
    const evidence = [];
    const summary = fn({ evidence });
    process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{
        type: 'runtime',
        value: 'the exact-SHA React hook contract did not establish the criterion',
      }],
    }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { run, targetSha, webVitest };
