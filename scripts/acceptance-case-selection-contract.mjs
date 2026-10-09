#!/usr/bin/env node

import assert from 'node:assert/strict';

/**
 * Case selection must distinguish "no criteria in this stage" (no-op)
 * from "eligible criteria exist but no Case covers them" (a failure).
 * The trusted Acceptance executor is the owner of stage/SC eligibility;
 * callers pass its already-resolved expected keys to this pure validator.
 */
export function validateCaseSelection({ stage, issueNumbers, expected, selected, requested = '' }) {
  if (!['pre-merge', 'staging', 'post-merge'].includes(stage)) {
    throw new Error('unsupported Acceptance Case stage: ' + stage);
  }
  if (!Array.isArray(issueNumbers) || !Array.isArray(expected) || !Array.isArray(selected)) {
    throw new Error('Acceptance Case selection inputs must be arrays');
  }
  const selectedKeys = selected.map((entry) => entry.issue + '/' + entry.criterion);
  const unexpected = selectedKeys.filter((key) => !expected.includes(key));
  const duplicates = selectedKeys.filter((key, index) => selectedKeys.indexOf(key) !== index);
  if (unexpected.length || duplicates.length) {
    throw new Error(
      'Case selection includes wrong-stage/unknown or duplicate entries: ' +
      [...unexpected, ...duplicates].join(', '),
    );
  }
  const selectionScope = requested
    ? expected.filter((key) => key === issueNumbers[0] + '/' + requested)
    : expected;
  const missing = selectionScope.filter((key) => !selectedKeys.includes(key));
  if (requested && (selected.length !== 1 ||
    selected[0].criterion !== requested ||
    issueNumbers.length !== 1 ||
    missing.includes(issueNumbers[0] + '/' + requested))) {
    throw new Error('manual Case selection missing or wrong stage/profile: ' + issueNumbers[0] + '/' + requested);
  }
  if (expected.length > 0 && selected.length === 0) {
    throw new Error('no source-aligned Cases selected for eligible Issues/SCs and stage ' + stage);
  }
  return {
    stage,
    expected,
    selected: selectedKeys,
    missing,
    status: expected.length === 0 ? 'not-applicable' : 'selected',
  };
}

function selfTest() {
  const base = { stage: 'post-merge', issueNumbers: [1556], expected: [], selected: [] };
  assert.deepEqual(validateCaseSelection(base), {
    stage: 'post-merge', expected: [], selected: [], missing: [], status: 'not-applicable',
  });
  assert.throws(() => validateCaseSelection({
    ...base, expected: ['1556/SC-07'],
  }), /no source-aligned Cases selected/);
  const covered = { issue: 1556, criterion: 'SC-07', runtime: 'full-stack-local' };
  assert.deepEqual(validateCaseSelection({
    ...base, expected: ['1556/SC-07'], selected: [covered],
  }).missing, []);
  assert.deepEqual(validateCaseSelection({
    ...base, expected: ['1556/SC-07', '1556/SC-08'], selected: [covered],
  }).missing, ['1556/SC-08']);
  assert.throws(() => validateCaseSelection({
    ...base, selected: [covered],
  }), /wrong-stage\/unknown/);
  assert.throws(() => validateCaseSelection({
    ...base, expected: ['1556/SC-07'], selected: [covered, covered],
  }), /duplicate/);
  assert.throws(() => validateCaseSelection({
    ...base, requested: 'SC-08',
  }), /manual Case selection missing/);
  assert.equal(validateCaseSelection({
    ...base, expected: ['1556/SC-07'], selected: [covered], requested: 'SC-07',
  }).status, 'selected');
  assert.throws(() => validateCaseSelection({
    ...base, stage: 'unknown',
  }), /unsupported Acceptance Case stage/);
  console.log('acceptance-case-selection self-test: 9 cases passed');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (process.argv[2] !== 'self-test') throw new Error('usage: acceptance-case-selection-contract.mjs self-test');
  selfTest();
}
