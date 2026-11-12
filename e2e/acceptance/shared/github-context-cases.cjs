'use strict';
// Shared machinery for the #1290 source-aligned GitHub Cases. Each Case names
// the exact tests or source boundary that proves its criterion; this module
// only runs them at the exact target SHA and emits concrete evidence.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha, checked, crateTests, assertRan } = require('./control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../..');
const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');

/** Run one Web Vitest file/project and require its selected tests to pass. */
function webTests(project, file, titlePattern, expected = 1) {
  const output = strip(
    checked(
      'npm',
      ['--prefix', 'web', 'test', '--', '--project', project, file,
        '-t', titlePattern, '--reporter=verbose'],
      600000,
    ),
  );
  const passed = Number((output.match(/\bTests\s+(\d+) passed\b/) || [])[1] || 0);
  if (passed < expected) {
    throw new Error(file + ' ran ' + passed + ' selected tests, expected ' + expected + ': ' +
      output.slice(-3000));
  }
  return { output, passed };
}

function githubTests(filter, names) {
  const output = crateTests('nession-github', ['--lib', filter], 600000);
  if (names) {
    assertRan(output, names);
  }
  return output;
}

function rustTests(pkg, args, names, timeout = 600000) {
  const output = crateTests(pkg, args, timeout);
  assertRan(output, names);
  return output;
}

function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function requires(relative, markers) {
  const text = source(relative);
  for (const marker of markers) {
    if (!text.includes(marker)) {
      throw new Error(relative + ' no longer contains `' + marker + '`');
    }
  }
  return text;
}

function evidence(type, value) {
  return { type, value: 'exact SHA ' + targetSha() + ': ' + value };
}

module.exports = { run, targetSha, webTests, githubTests, rustTests, source, requires, evidence };
