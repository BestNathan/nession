#!/usr/bin/env node
// Trusted main Case-discovery policy; source Cases remain read-only data at an exact SHA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCases, parseCaseYaml } from '../acceptance/cases.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-trusted-case-discovery-'));
const caseDir = path.join(root, '1474', 'SC-03');
const valid = [
  'schema_version: 1', 'issue: 1474', 'criterion: SC-03',
  'stage: pre-merge', 'runtime: full-stack-local',
  'verifiers:', '  - type: protocol', '    entry: verify.js',
  'result_policy: all-pass', '',
].join('\n');
const expectRejected = (fn, pattern) => assert.throws(fn, pattern);
try {
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'case.yaml'), valid);
  fs.writeFileSync(path.join(caseDir, 'verify.js'), 'process.stdout.write("{}");\n');
  assert.equal(discoverCases(root).length, 1);
  assert.equal(discoverCases(root)[0].manifest.stage, 'pre-merge');
  expectRejected(() => parseCaseYaml('verifiers:\n  - bad\tkey: value'), /tabs/);
  const manifest = path.join(caseDir, 'case.yaml');
  fs.writeFileSync(manifest, valid.replace('pre-merge','production'));
  expectRejected(() => discoverCases(root), /unsupported case stage/);
  fs.writeFileSync(manifest, valid.replace('protocol', 'shell'));
  expectRejected(() => discoverCases(root), /unsupported verifier type/);
  fs.writeFileSync(manifest, valid.replace('verify.js', '../outside.js'));
  expectRejected(() => discoverCases(root), /stay inside/);
  fs.writeFileSync(manifest, valid);
  fs.rmSync(path.join(caseDir, 'verify.js'));
  fs.symlinkSync(manifest, path.join(caseDir, 'verify.js'));
  expectRejected(() => discoverCases(root), /missing verifier entry/);
  fs.rmSync(path.join(caseDir, 'verify.js'));
  fs.writeFileSync(path.join(caseDir, 'verify.js'), '');
  fs.symlinkSync(manifest, path.join(caseDir, 'copy.yaml'));
  fs.rmSync(manifest);
  fs.symlinkSync(path.join(caseDir, 'copy.yaml'), manifest);
  expectRejected(() => discoverCases(root), /manifest must be a real file/);
  fs.rmSync(manifest);
  fs.rmSync(path.join(caseDir, 'copy.yaml'));
  fs.writeFileSync(manifest, valid);
  fs.symlinkSync(caseDir, path.join(root, '1474', 'SC-04'));
  expectRejected(() => discoverCases(root), /non-directory or symlink/);
  fs.rmSync(path.join(root, '1474', 'SC-04'));
  fs.symlinkSync(path.join(root, '1474'), path.join(root, '7777'));
  expectRejected(() => discoverCases(root), /non-directory or symlink/);
  fs.rmSync(path.join(root, '7777'));
  assert.equal(discoverCases(root).length, 1);
  console.log('trusted Case discovery: valid fixture + schema, stage, verifier, traversal and symlink negative tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
