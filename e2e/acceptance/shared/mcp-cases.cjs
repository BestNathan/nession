'use strict';
// Shared machinery for the #565 MCP source-aligned Cases.
//
// Each Case names the exact tests that prove its criterion. This module only
// runs them against the exact target checkout and emits the one-line JSON the
// Acceptance runner requires; what a criterion means stays in its verifier.
//
// The tests are the same ones `rust-test-*` runs in Quality. A Case is the
// merged-staging, source-aligned proof that the named evidence belongs to the
// acceptance target SHA, not a second implementation of the behavior.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');

/// Isolate a Case that starts its own tmux-backed Agent.
///
/// The full-stack batch keeps a runtime Agent on its own socket. These Cases
/// spawn an additional Agent inside a cargo test process; giving that process
/// a private socket and state home keeps the two runtimes from sharing one
/// tmux server and one identity directory (the documented Case isolation in
/// `e2e/README.md`).
function isolatedTmuxEnv(prefix = 'nession-565-case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    NESSION_HOME: home,
  };
}

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
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '', ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-4500));
  }
  return String(result.stdout) + '\n' + String(result.stderr);
}

/** Run one or more filters in one cargo package's test target. */
function crateTests(pkg, args, timeout, extraEnv = {}) {
  return checked('cargo', ['test', '-p', pkg, ...args, '--', '--nocapture'], timeout, extraEnv);
}

/** Assert every named test actually ran and passed. */
function assertRan(output, names) {
  for (const name of names) {
    if (!output.includes(name + ' ... ok')) {
      throw new Error('Missing concrete assertion: ' + name);
    }
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * A private tmux server and state home for a Case's crate tests.
 *
 * The Acceptance batch keeps a full-stack runtime on one tmux socket. A test
 * that starts another Agent must not borrow it, or the Agent's instance
 * identity and the runtime's Sessions collide.
 */
function isolatedTmuxEnv(prefix = 'nession-3264-case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'), NESSION_HOME: home };
}

/**
 * Run a Case body: `fn({evidence})` returns the pass summary and pushes the
 * concrete lines a reader can check. Any throw is a Fail.
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

module.exports = { run, targetSha, checked, crateTests, assertRan, read, isolatedTmuxEnv };
