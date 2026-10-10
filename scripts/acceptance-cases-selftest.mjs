#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  aggregateVerifierResults,
  discoverCases,
  parseCaseYaml,
  validateCaseAgainstAcceptanceContext,
  validateCaseManifest,
} from '../acceptance/cases.mjs';

let cases = 0;
function ok(fn) {
  fn();
  cases += 1;
}
function rejects(fn, pattern) {
  assert.throws(fn, pattern);
  cases += 1;
}
function writeCase(root, issue, criterion, manifest, files = ['verify.js']) {
  const dir = path.join(root, String(issue), criterion);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'case.yaml'), manifest);
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'process.stdout.write("{}\\n");\n');
  return dir;
}

const validYaml = [
  'schema_version: 1',
  'issue: 1474',
  'criterion: SC-03',
  'stage: pre-merge',
  'runtime: full-stack-local',
  'verifiers:',
  '  - type: protocol',
  '    entry: verify.js',
  'result_policy: all-pass',
  '',
].join('\n');

ok(() => {
  const parsed = parseCaseYaml(validYaml);
  assert.equal(parsed.issue, 1474);
  assert.deepEqual(parsed.verifiers, [{ type: 'protocol', entry: 'verify.js' }]);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acceptance-cases-'));
try {
  const dir = writeCase(root, 1474, 'SC-03', validYaml);
  ok(() => {
    const found = discoverCases(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].manifest.criterion, 'SC-03');
  });

  rejects(
    () => validateCaseManifest({ ...parseCaseYaml(validYaml), stage: 'production' }, dir),
    /unsupported case stage/,
  );
  rejects(
    () => validateCaseManifest({
      ...parseCaseYaml(validYaml),
      verifiers: [{ type: 'shell', entry: 'verify.js' }],
    }, dir),
    /unsupported verifier type/,
  );
  rejects(
    () => validateCaseManifest({
      ...parseCaseYaml(validYaml),
      verifiers: [{ type: 'protocol', entry: '../escape.js' }],
    }, dir),
    /stay inside/,
  );
  rejects(
    () => validateCaseManifest({
      ...parseCaseYaml(validYaml),
      verifiers: [{ type: 'protocol', entry: 'missing.js' }],
    }, dir),
    /missing verifier entry/,
  );
  rejects(
    () => validateCaseManifest({ ...parseCaseYaml(validYaml), criterion: 'SC-04' }, dir),
    /does not match manifest criterion/,
  );

  ok(() => assert.equal(
    aggregateVerifierResults([{ result: 'Pass' }, { result: 'Pass' }]),
    'Pass',
  ));
  ok(() => assert.equal(
    aggregateVerifierResults([{ result: 'Pass' }, { result: 'Pending' }]),
    'Pending',
  ));
  ok(() => assert.equal(
    aggregateVerifierResults([{ result: 'Pass' }, { result: 'Fail' }]),
    'Fail',
  ));
  ok(() => assert.equal(
    aggregateVerifierResults([{ result: 'Pass' }, { result: 'Error' }]),
    'Error',
  ));
  ok(() => assert.equal(aggregateVerifierResults([]), 'Pending'));

  const manifest = validateCaseManifest(parseCaseYaml(validYaml), dir);
  const context = {
    issue: { number: 1474 },
    stage: 'pre-merge',
    criteria: [{ criterion: 'SC-03', text: 'SC-03 protocol-only verifier works' }],
  };
  ok(() => {
    const criterion = validateCaseAgainstAcceptanceContext(manifest, context);
    assert.equal(criterion.criterion, 'SC-03');
  });
  rejects(
    () => validateCaseAgainstAcceptanceContext(manifest, { ...context, stage: 'staging' }),
    /does not match trusted stage/,
  );
  rejects(
    () => validateCaseAgainstAcceptanceContext(manifest, { ...context, issue: { number: 1 } }),
    /does not match trusted Acceptance context/,
  );
  rejects(
    () => validateCaseAgainstAcceptanceContext(manifest, { ...context, criteria: [] }),
    /absent from trusted/,
  );

  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acceptance-cases-bad-'));
  try {
    writeCase(
      badRoot,
      1474,
      'SC-03',
      validYaml.replace('issue: 1474', 'issue: 9999'),
    );
    rejects(() => discoverCases(badRoot), /does not match manifest issue/);
  } finally {
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// Canonical Driver self-tests must keep their actual relocation in the gate.
ok(() => {
  assert.equal(fs.existsSync(path.join(process.cwd(), 'acceptance', 'verifiers')), false,
    'old verifier driver directory must not survive canonical migration');
  const moved = path.join(process.cwd(), 'e2e', 'runner', 'drivers', 'browser-report.mjs');
  const run = spawnSync(process.execPath, [moved, 'self-test'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0, 'relocated Driver contract failed: ' + run.stderr);
  assert.match(run.stdout, /11 positive\/negative fixtures passed/);
});

// Real source Case discovery is part of the mandatory canonical contract.
const repoRoot = path.resolve(process.cwd());
const canonicalRoot = path.join(repoRoot, 'e2e', 'acceptance', 'cases');
ok(() => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'acceptance', 'cases')), false,
    'legacy Case tree must not survive canonical source migration');
  const discovered = discoverCases(canonicalRoot);
  assert.ok(discovered.length >= 12, 'canonical Case discovery must never silently be empty');
  const sharedScenario = path.join(repoRoot,'e2e','acceptance','shared','terminal-scenario-evidence.cjs');
  const sharedResult = spawnSync(process.execPath,['--check',sharedScenario],{
    cwd:repoRoot,encoding:'utf8',timeout:5000,
  });
  assert.equal(sharedResult.status,0,
    'shared Terminal Scenario Case helper syntax invalid: '+sharedResult.stderr);
  // Guard syntax of every in-tree JavaScript verifier before stage execution.
  // A malformed new Case must fail the PR gate rather than fail only on push.
  for (const item of discovered) {
    for (const verifier of item.manifest.verifiers) {
      if (!/\.(?:cjs|mjs|js)$/.test(verifier.entry)) continue;
      const file = path.join(item.dir, verifier.entry);
      const result = spawnSync(process.execPath, ['--check', file], {
        cwd: repoRoot, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0,
        'Case verifier syntax invalid: ' + item.manifest.issue + '/' +
        item.manifest.criterion + '/' + verifier.entry + ': ' + result.stderr);
    }
  }
});
ok(() => {
  const verifier = path.join(canonicalRoot, '1520', 'SC-04', 'verify.js');
  const result = spawnSync(process.execPath, [verifier, '--self-test'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, 'staging merge parent parser self-test failed: ' + result.stderr);
  assert.match(result.stdout, /raw-object proof self-test passed/);
});
// Canonical manifest type=browser is the trusted dependency declaration.
// A runtime Case invoking the Terminal Scenario transitively must list a real
// Browser verifier, so the main-owned Case selector provisions Playwright.
ok(() => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows',
    'acceptance-cases.yml'), 'utf8');
  assert.match(workflow,
    /- name: Install browser verifier runtime\s+if: steps\.select\.outputs\.needs_browser == 'true'/);
  assert.match(workflow,
    /- name: Install browser verifier runtime[\s\S]*?cd workspace\/e2e\s+npm ci\s+npx playwright install chromium --with-deps/);
  assert.match(workflow, /needs_browser: verifiers\.some\(\(item\) => item\.type === 'browser'\)/);
  for (const n of ['01','02','03','04']) {
    const caseDir = path.join(canonicalRoot, '1498', 'SC-' + n);
    const item = discoverCases(canonicalRoot).find(x =>
      x.manifest.issue === 1498 && x.manifest.criterion === 'SC-' + n);
    assert.ok(item, 'missing staged Scenario Case SC-' + n);
    assert.ok(item.manifest.verifiers.some(v => v.type === 'browser'),
      'SC-' + n + ' must declare real Playwright dependency');
    assert.ok(fs.existsSync(path.join(caseDir, 'verify.spec.js')));
  }
});

// Exact PR-head checks must not execute GitHub's synthetic merge checkout.
ok(() => {
  const expected='ref: ${{ github.event.pull_request.head.sha || github.sha }}';
  for(const [workflow,count] of [['quality.yml',2],['e2e.yml',1],['e2e-scenario-smoke.yml',1]]){
    const source=fs.readFileSync(path.join(repoRoot,'.github','workflows',workflow),'utf8');
    assert.equal(source.split(expected).length-1,count,workflow+' must checkout exact PR head');
    assert.ok(source.split('persist-credentials: false').length-1>=count,workflow+' cannot retain write credentials');
  }
  const e2e=fs.readFileSync(path.join(repoRoot,'.github','workflows','e2e.yml'),'utf8');
  assert.ok(e2e.includes('NESSION_TARGET_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'));
});

console.log('acceptance Case self-test: ' + cases + ' cases passed');
