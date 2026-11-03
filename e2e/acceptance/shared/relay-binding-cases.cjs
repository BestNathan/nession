'use strict';
// Shared machinery for the #2652 relay-target Cases: exact-SHA source reads,
// the nession-server lib tests each criterion names, and an order assertion
// for the "check before mint" boundary. Each Case owns what it proves; this
// module only runs and reads.
const fs = require('node:fs');
const path = require('node:path');
const { checked, assertRan } = require('./control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../..');

function readSource(relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(root + path.sep)) {
    throw new Error('source path escapes the repository');
  }
  return fs.readFileSync(absolute, 'utf8');
}

function serverLibTests(filter, timeout = 300000) {
  return checked(
    'cargo',
    ['test', '-p', 'nession-server', '--lib', filter, '--', '--nocapture'],
    timeout,
  );
}

function assertBefore(source, first, second, label) {
  const atFirst = source.indexOf(first);
  const atSecond = source.indexOf(second);
  if (atFirst < 0) throw new Error(label + ': missing ' + first);
  if (atSecond < 0) throw new Error(label + ': missing ' + second);
  if (atFirst >= atSecond) {
    throw new Error(label + ': ' + first + ' must precede ' + second);
  }
}

module.exports = { assertBefore, assertRan, readSource, serverLibTests };
