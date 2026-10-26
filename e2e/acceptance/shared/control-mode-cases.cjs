'use strict';
// Shared machinery for the #2307 source-aligned Cases.
//
// Each Case names the exact tests that prove its criterion; this module only
// runs them against the exact target checkout and emits the concrete
// evidence the Acceptance runner requires (a single JSON line, one-line
// evidence strings). It is deliberately not a registry of what any criterion
// means — that stays in each Case's verifier.
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

function checked(command, args, timeout, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '', ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-4500));
  }
  return String(result.stdout) + '\n' + String(result.stderr);
}

/**
 * Run one or more filters in the nession-agent cargo test target.
 *
 * `extraEnv` lets a Case own its isolation: a tmux-backed test must not inherit
 * whatever socket the Case runtime happens to use.
 */
function cargoTests(args, timeout, extraEnv = {}) {
  return checked('cargo', ['test', '-p', 'nession-agent', ...args, '--', '--nocapture'], timeout, extraEnv);
}

/** Assert every named test actually ran and passed. */
function assertRan(output, names) {
  for (const name of names) {
    if (!output.includes(name + ' ... ok')) {
      throw new Error('Missing concrete assertion: ' + name);
    }
  }
}

function tmuxVersion() {
  const version = checked('tmux', ['-V'], 10000).trim();
  if (!/^tmux \d/.test(version)) throw new Error('unrecognised tmux executable: ' + version);
  return version;
}

/**
 * Run a Case body: `fn({evidence})` returns the pass summary and pushes
 * concrete single-line evidence. Any thrown error is a Fail with its message
 * as the summary. The process exits non-zero so the driver never reads a
 * claimed pass from a failing run.
 */
function run(fn) {
  try {
    const evidence = [];
    const summary = fn({ evidence });
    process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{ type: 'runtime', value: 'the named exact-SHA source tests did not establish the criterion' }],
    }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { run, targetSha, checked, cargoTests, assertRan, tmuxVersion };
