#!/usr/bin/env node
// Generic representative PR Case Smoke selection. No hard-coded Issue or SC.
// Full SC eligibility belongs to select-acceptance-cases.mjs; these are
// independent infrastructure smoke examples, NOT Issue acceptance evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCases } from '../e2e/acceptance/contract/cases.mjs';

export function selectRepresentativeCases(cases) {
  const ordered = [...cases].sort((a, b) => {
    const ak = String(a.manifest.issue).padStart(12, '0') + '/' + a.manifest.criterion;
    const bk = String(b.manifest.issue).padStart(12, '0') + '/' + b.manifest.criterion;
    return ak.localeCompare(bk);
  });
  const protocolOnly = ordered.find(({ manifest }) =>
    manifest.verifiers.some((v) => v.type === 'protocol') &&
    !manifest.verifiers.some((v) => v.type === 'browser'));
  const browserProtocol = ordered.find(({ manifest }) =>
    manifest.verifiers.some((v) => v.type === 'protocol') &&
    manifest.verifiers.some((v) => v.type === 'browser'));
  if (!protocolOnly || !browserProtocol) {
    throw new Error('Case Smoke requires protocol-only and browser+protocol representative Cases');
  }
  return [protocolOnly, browserProtocol].map(({ manifest }) => ({
    issue: manifest.issue,
    criterion: manifest.criterion,
    stage: manifest.stage,
    runtime: manifest.runtime,
    needs_browser: manifest.verifiers.some((v) => v.type === 'browser'),
  }));
}

function selfTest() {
  const item = (issue, criterion, stage, types) => ({
    manifest: { issue, criterion, stage, runtime: 'full-stack-local',
      verifiers: types.map((type) => ({ type, entry: 'verify.js' })) },
  });
  const a = item(7, 'SC-02', 'pre-merge', ['protocol']);
  const b = item(2, 'SC-03', 'staging', ['browser', 'protocol']);
  const c = item(1, 'SC-04', 'staging', ['browser']);
  const result = selectRepresentativeCases([c, b, a]);
  assert.deepEqual(result.map((x) => x.issue + '/' + x.criterion), ['7/SC-02','2/SC-03']);
  assert.deepEqual(result.map((x) => x.needs_browser), [false, true]);
  assert.throws(() => selectRepresentativeCases([a]), /protocol-only and browser\+protocol/);
  assert.throws(() => selectRepresentativeCases([b]), /protocol-only and browser\+protocol/);
  assert.deepEqual(selectRepresentativeCases([b, a]), result);
  console.log('generic Acceptance Case Smoke: representative selection and missing-class negatives passed');
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'select' || !process.argv[3] || !process.argv[4]) {
    throw new Error('usage: acceptance-case-smoke-select.mjs <self-test|select CASE_ROOT OUTPUT_JSON>');
  }
  const selected = selectRepresentativeCases(discoverCases(process.argv[3]));
  fs.writeFileSync(process.argv[4], JSON.stringify(selected, null, 2) + '\n');
  console.log('Smoke Case classes: ' + selected.map((s) => s.issue + '/' + s.criterion).join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e); process.exitCode = 1; }
}
