'use strict';
// Shared machinery for the #2581 Xterm Engine Cases.
//
// Every Case names the exact source-aligned tests that prove its criterion and
// runs them at the Acceptance target checkout. The helper only spawns, counts
// and reads; what each criterion means stays in its verifier.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const webDir = path.join(root, 'web');

/** Vitest colourises its summary; strip SGR escapes before matching. */
function plain(output) {
  return String(output).replace(/\u001b\[[0-9;]*m/g, '');
}

function spawn(command, args, cwd, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '' },
  });
  if (result.error) throw result.error;
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      plain(output).slice(-4400));
  }
  return output;
}

/**
 * Run one or more Vitest files and return how many tests passed.
 *
 * A `filter` is the Vitest `-t` substring; it narrows the file to the named
 * behaviour so a Case cannot pass on unrelated green tests.
 */
function webTests(files, { filter, timeout = 600000 } = {}) {
  const args = ['exec', '--', 'vitest', 'run'];
  if (filter) { args.push('-t', filter); }
  args.push(...files);
  const output = spawn('npm', args, webDir, timeout);
  const match = /Tests\s+(\d+) passed/.exec(plain(output));
  if (!match) {
    throw new Error('vitest reported no passing tests for ' + files.join(', ') + ': ' +
      plain(output).slice(-4400));
  }
  const passed = Number(match[1]);
  if (passed < 1) {
    throw new Error('vitest reported zero passing tests for ' + files.join(', '));
  }
  return { passed, output };
}

/** Run one `node --test` file and return its pass count. */
function nodeTests(relPath, timeout = 180000) {
  const output = spawn('node', ['--test', relPath], root, timeout);
  const match = /(?:#|ℹ)\s*pass (\d+)/.exec(plain(output));
  if (!match || Number(match[1]) < 1) {
    throw new Error('node --test reported no passing tests for ' + relPath + ': ' +
      plain(output).slice(-4400));
  }
  return { passed: Number(match[1]), output };
}

/** Run the repository lint over a set of paths at the target checkout. */
function webLint(paths, timeout = 300000) {
  return spawn('npx', ['eslint', ...paths], webDir, timeout);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Assert `rel` contains every needle and none of the forbidden strings. */
function requireText(rel, needles, forbidden = []) {
  const text = read(rel);
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(rel + ' is missing ' + JSON.stringify(needle));
    }
  }
  for (const needle of forbidden) {
    if (text.includes(needle)) {
      throw new Error(rel + ' must not contain ' + JSON.stringify(needle));
    }
  }
  return text;
}

module.exports = { root, webDir, plain, webTests, nodeTests, webLint, read, requireText };
