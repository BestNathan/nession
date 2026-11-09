'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, checked, targetSha } = require('../../../shared/control-mode-cases.cjs');
const root = path.resolve(__dirname, '../../..');
function inspect(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function test(command, timeout = 90000) { return checked('node', command, timeout).trim(); }
function proof(fn) { run(({ evidence }) => { const sha = targetSha(); return fn({ evidence, sha }); }); }
module.exports = { assert, fs, path, root, inspect, test, proof };
