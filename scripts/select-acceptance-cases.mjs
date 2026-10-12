#!/usr/bin/env node
// Canonical trusted workflow selector for source-aligned Acceptance Cases.
// Source checkout supplies *data* (Case manifests), not trust or SC eligibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCases } from '../acceptance/cases.mjs';
import { buildAcceptanceContext } from './acceptance-executor.mjs';
import { acceptancePlanSection } from './acceptance-plan.mjs';
import { validateCaseSelection } from './acceptance-case-selection-contract.mjs';

const SELF = fileURLToPath(import.meta.url);

export function selectTrustedCases({
  issueNumbers, issues, stage, targetSha, runId, requested = '',
  runtime = '', sourceCaseRoot,
}) {
  if (!Array.isArray(issueNumbers) || !Array.isArray(issues)) throw new Error('Issue inputs must be arrays');
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) throw new Error('target must be an exact 40-byte hexadecimal SHA');
  const selected = discoverCases(sourceCaseRoot)
    .map(({ manifest }) => manifest)
    .filter((item) => issueNumbers.includes(Number(item.issue)))
    .filter((item) => item.stage === stage)
    .filter((item) => !requested || item.criterion === requested)
    .filter((item) => !runtime || item.runtime === runtime)
    .map(({ issue, criterion, runtime: runtimeName, verifiers }) => ({
      issue, criterion, runtime: runtimeName,
      needs_browser: verifiers.some((item) => item.type === 'browser'),
    }));
  const selectedKeys = new Set(selected.map((item) => item.issue + '/' + item.criterion));
  const expected = [];
  for (const issueNumber of issueNumbers) {
    const issue = issues.find((item) => Number(item.number) === issueNumber);
    if (!issue) throw new Error('missing trusted Issue contract #' + issueNumber);
    const context = buildAcceptanceContext(issue, stage, {
      targetRef: targetSha, runId, method: 'case',
    });
    const explicit = acceptancePlanSection(issue.body) !== null;
    for (const criterion of context.criteria) {
      const key = issueNumber + '/' + criterion.criterion;
      // Explicit Case-method obligations must be present. Historical issues
      // without a declared Method retain only their existing source Cases:
      // forcing a Case for all legacy Agent-validated SCs would break them.
      if (explicit || selectedKeys.has(key)) expected.push(key);
    }
  }
  const coverage = validateCaseSelection({ stage, issueNumbers, expected, selected, requested });
  if (coverage.missing.length) {
    throw new Error('mandatory Case-method coverage missing: ' + coverage.missing.join(', '));
  }
  return { selected, coverage };
}

function issueBody(stage, withPlan = false) {
  const codeFence = String.fromCharCode(96).repeat(3);
  return [
    '## Success Criteria', '- [ ] SC-01 case obligation', '- [ ] SC-02 agent observation', '',
    '## Acceptance Report', '| Criterion | Stage | Result | Evidence |',
    '|---|---|---|---|',
    '| SC-01 | ' + stage + ' | Pending | awaiting run |',
    '| SC-02 | ' + stage + ' | Pending | awaiting run |', '',
    ...(withPlan ? [
      '## Acceptance Plan', codeFence + 'yaml', 'acceptance:',
      '  SC-01:', '    when: merged', '    branch: staging', '    method: case',
      '  SC-02:', '    when: merged', '    branch: staging', '    method: agent',
      codeFence, '',
    ] : []),
    '## Product alignment', '- [x] aligned', '**Status:** Approved',
  ].join('\n');
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'acceptance-selector-'));
  try {
    const dir = path.join(root, '42', 'SC-01'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'case.yaml'),
      'schema_version: 1\nissue: 42\ncriterion: SC-01\nstage: staging\nruntime: full-stack-local\nverifiers:\n  - type: runtime\n    entry: verify.js\nresult_policy: all-pass\n');
    fs.writeFileSync(path.join(dir, 'verify.js'), '// fixture verifier');
    const base = { issueNumbers: [42], stage: 'staging', targetSha: 'a'.repeat(40),
      runId: 10, sourceCaseRoot: root };
    const issue = { number: 42, title: 'Fixture', body: issueBody('staging', true) };
    const selected = selectTrustedCases({ ...base, issues: [issue] });
    assert.deepEqual(selected.coverage.expected, ['42/SC-01']);
    assert.equal(selected.selected.length, 1);
    assert.equal(selected.selected[0].needs_browser, false);
    assert.throws(() => selectTrustedCases({ ...base, issues: [issue], runtime: 'wrong' }),
      /no source-aligned Cases selected|mandatory Case-method coverage missing/);
    assert.throws(() => selectTrustedCases({ ...base, issues: [issue], requested: 'SC-02' }),
      /manual Case selection missing/);
    fs.rmSync(dir, { recursive: true });
    assert.throws(() => selectTrustedCases({ ...base, issues: [issue] }), /no source-aligned Cases selected/);
    const legacy = { ...issue, body: issueBody('staging') };
    assert.equal(selectTrustedCases({ ...base, issues: [legacy] }).coverage.status, 'not-applicable');
    assert.throws(() => selectTrustedCases({ ...base, issues: [issue], targetSha: 'main' }), /exact/);
    console.log('trusted Acceptance Case selection: method separation and missing coverage negatives passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === 'self-test') return selfTest();
  if (mode !== 'select') throw new Error('usage: select-acceptance-cases.mjs <self-test|select ROOT ISSUE_JSON_DIR SELECTED_JSON COVERAGE_JSON>');
  const [caseRoot, issueDir, selectedPath, coveragePath] = process.argv.slice(3);
  if (!caseRoot || !issueDir || !selectedPath || !coveragePath) throw new Error('missing selector paths');
  const issueNumbers = JSON.parse(process.env.ISSUE_NUMBERS ?? '[]').map(Number);
  const issues = issueNumbers.map(number =>
    JSON.parse(fs.readFileSync(path.join(issueDir, number + '.json'), 'utf8')));
  const { selected, coverage } = selectTrustedCases({
    issueNumbers, issues,
    stage: process.env.ACCEPTANCE_STAGE,
    targetSha: process.env.TARGET_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    requested: process.env.MANUAL_CRITERION ?? '',
    runtime: process.env.RUNTIME_PROFILE ?? '',
    sourceCaseRoot: caseRoot,
  });
  fs.writeFileSync(selectedPath, JSON.stringify(selected, null, 2) + '\n');
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\n');
  console.log('Source-aligned Cases: ' + selected.length + ', coverage: ' + coverage.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
