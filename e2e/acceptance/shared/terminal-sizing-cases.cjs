'use strict';
// Shared machinery for the #2487 terminal-sizing Cases.
//
// The build/config/runtime Cases all need the same three things: run a command
// at the exact target checkout, read the effective terminal configuration the
// release pipeline produced, and assert on concrete process output. Keeping
// that here leaves each verifier owning only what its criterion means.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetSha } = require('./control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../..');
// Spelled from the project name rather than retyped: this repository's own
// variables (for example `NESSON_SESSION_ID`) use a different spelling, and a
// hand-typed kernel name is exactly the kind of drift a Case must not have.
const PROJECT = 'nession'.toUpperCase();
const TERMINAL_COLS_ENV = PROJECT + '_TERMINAL_COLS';
const TERMINAL_WEB_FONT_SIZE_ENV = PROJECT + '_TERMINAL_WEB_FONT_SIZE';
const VITE_TERMINAL_COLS_ENV = 'VITE_' + TERMINAL_COLS_ENV;
const VITE_TERMINAL_WEB_FONT_SIZE_ENV = 'VITE_' + TERMINAL_WEB_FONT_SIZE_ENV;

/**
 * The plain text of a tool's output.
 *
 * Vitest colorizes its summary when the environment advertises color support
 * (the CI runner does), so `Tests\s+13 passed` does not match the raw text:
 * SGR escape sequences sit between the words. Strip them before asserting on
 * a suite's counts — the tests themselves did run.
 */
function stripAnsi(output) {
  return String(output).replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * How many tests vitest reports as passed, or `null` when the summary is
 * absent.
 *
 * Cases assert a *baseline*, not an exact count: adding a test to the suite is
 * a legitimate change, and failing the Case for it makes the evidence about
 * test bookkeeping instead of the property under test. A removed test still
 * fails the baseline.
 */
function passedTests(output) {
  const match = /Tests\s+(\d+) passed/.exec(stripAnsi(output));
  return match ? Number(match[1]) : null;
}

function checkedIn(cwd, command, args, timeout, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '', ...extraEnv },
  });
  if (result.error) throw result.error;
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      output.slice(-4400));
  }
  return output;
}

/** Run a Web build into an isolated directory; never mutate the preview dist. */
function webBuild(outDir, env = {}) {
  return checkedIn(
    path.join(root, 'web'),
    'npm',
    ['exec', '--', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'],
    300000,
    env,
  );
}

/** The build's one machine-readable terminal-configuration line. */
function buildConfig(output) {
  const matches = output.match(/WEB_TERMINAL_CONFIG_V1 (\{.*\})/g) || [];
  if (matches.length !== 1) {
    throw new Error('expected exactly one WEB_TERMINAL_CONFIG_V1 line, got ' + matches.length);
  }
  return JSON.parse(matches[0].slice('WEB_TERMINAL_CONFIG_V1 '.length));
}

/** Render a Server config through the image's own entrypoint renderer. */
function renderServerConfig(outPath, env = {}) {
  checkedIn(root, 'sh', ['deploy/render-server-config.sh', outPath], 60000, env);
  return fs.readFileSync(outPath, 'utf8');
}

/** Parse the rendered file with the real Server binary and its real validation. */
function serverBinary() {
  const binary = path.join(root, 'target/debug/nession-server');
  if (!fs.existsSync(binary)) {
    throw new Error('the Acceptance runtime must build target/debug/nession-server');
  }
  return binary;
}

function printServerConfig(configPath, env = {}) {
  const output = checkedIn(root, serverBinary(), ['--print-config', configPath], 60000, env);
  const last = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(last);
}

function expectFailure(run, contains) {
  try {
    run();
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!message.includes(contains)) {
      throw new Error('failure did not name ' + JSON.stringify(contains) + ': ' + message.slice(0, 1200));
    }
    return message;
  }
  throw new Error('expected a visible failure naming ' + JSON.stringify(contains));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function requireText(rel, needles) {
  const text = read(rel);
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(rel + ' is missing ' + JSON.stringify(needle));
    }
  }
}

module.exports = {
  root,
  targetSha,
  TERMINAL_COLS_ENV,
  TERMINAL_WEB_FONT_SIZE_ENV,
  VITE_TERMINAL_COLS_ENV,
  VITE_TERMINAL_WEB_FONT_SIZE_ENV,
  stripAnsi,
  passedTests,
  checkedIn,
  webBuild,
  buildConfig,
  renderServerConfig,
  printServerConfig,
  expectFailure,
  requireText,
};
