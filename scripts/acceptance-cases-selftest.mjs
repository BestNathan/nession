#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

console.log('acceptance Case self-test: ' + cases + ' cases passed');
