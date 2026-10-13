#!/usr/bin/env node
// #1684: one Case/Contract owner, no executable root acceptance/ aliases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['scripts', 'e2e', 'gates', '.github/workflows', '.claude/skills'];
const executable = /\.(?:mjs|cjs|js|jsx|ts|tsx|sh|yml|yaml)$/;
const excluded = new Set(['node_modules', 'dist', 'target', 'test-results', 'playwright-report', '.git']);
const legacyReference = /(?<!e2e\/)acceptance\/(?:cases\.mjs|shared\/)/g;

function scan(root) {
  const violations = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // target escapes are handled by the Case validator
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || !executable.test(entry.name)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const matches = [...content.matchAll(legacyReference)];
      if (matches.length) {
        const relative = path.relative(root, file);
        const locations = matches.map(match =>
          content.slice(0, match.index).split('\n').length);
        violations.push(relative + ':' + locations.join(','));
      }
    }
  }
  for (const source of sources) visit(path.join(root, source));
  return violations;
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acceptance-layout-'));
  try {
    fs.mkdirSync(path.join(temp, 'scripts'), { recursive: true });
    const fixture = path.join(temp, 'scripts', 'example.mjs');
    fs.writeFileSync(fixture, 'import "' + '../../' + ['acceptance', 'cases.mjs'].join('/') + '";\n');
    assert.deepEqual(scan(temp), ['scripts/example.mjs:1']);
    fs.writeFileSync(fixture, 'require("' + '../../../' + ['acceptance', 'shared', 'helper.js'].join('/') + '");\n');
    assert.deepEqual(scan(temp), ['scripts/example.mjs:1']);
    fs.writeFileSync(fixture, 'import "../e2e/acceptance/contract/cases.mjs";\n');
    assert.deepEqual(scan(temp), []);
    fs.writeFileSync(fixture, "const historical = 'acceptance/cases/1474/SC-03';\n");
    assert.deepEqual(scan(temp), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('acceptance layout negative fixtures passed');
}

function check() {
  assert.equal(fs.lstatSync(path.join(repo, 'acceptance'), { throwIfNoEntry: false }), undefined,
    'root acceptance/ is forbidden; move code to e2e/acceptance/');
  for (const name of ['contract/cases.mjs', 'evaluator/run-case.mjs',
    'shared/infrastructure-contract.js', 'shared/protocol-online-agent.js',
    'shared/terminal-clearance-browser.js']) {
    assert.ok(fs.statSync(path.join(repo, 'e2e', 'acceptance', name), { throwIfNoEntry: false })?.isFile(),
      'missing canonical acceptance source: ' + name);
  }
  const violations = scan(repo);
  assert.deepEqual(violations, [], 'active references to root acceptance code are forbidden');
  console.log('acceptance layout contract: canonical only');
}

const action = process.argv[2];
if (action === 'self-test') selfTest();
else if (action === 'check') check();
else throw new Error('usage: acceptance-layout-contract.mjs self-test|check');
