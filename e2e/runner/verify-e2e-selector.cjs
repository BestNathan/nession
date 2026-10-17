#!/usr/bin/env node
'use strict';
// Bounded, stack-free proof of the `--id` selector's positive and negative
// behavior (#1866 SC-03).
//
// The Full E2E Gate used to prove selection by running a two-ID canary on a
// real full stack and then running `--all` on a SECOND real stack. Selection is
// a pure mapping — ID -> exact checked-in spec file — so its contract needs no
// runtime at all, and each canary ID's real outcome is still proven per ID from
// the single full run's JSON report (verify-playwright-selected.cjs). The
// subset *runtime* path keeps its coverage on every selected PR run, which
// invokes `./e2e/run test --id ...` for real.
const path = require('node:path');
const assert = require('node:assert/strict');
const { discover, select } = require('./test-catalog.cjs');

const ids = process.argv.slice(2);
if (!ids.length) throw Error('Usage: verify-e2e-selector.cjs ID...');

const registry = discover(path.resolve(__dirname, '..', 'tests'));

// Positive: each requested ID resolves to exactly its own spec file, in the
// requested order — no substitution, no broadening, no silent widening to --all.
const selected = select(registry, ids);
assert.deepEqual(selected.map((test) => test.id), ids,
  'selector must preserve the requested ID order and return exactly those IDs');
for (const test of selected) {
  assert.ok(test.file.endsWith('/' + test.id + '.spec.ts'),
    test.id + ' resolved to an unexpected file: ' + test.file);
  assert.ok(registry.some((entry) => entry.id === test.id && entry.file === test.file),
    test.id + ' resolved to a file that is not its catalog entry');
}

// Negative: the selector must REJECT rather than quietly run something else.
const negatives = [
  ['unknown ID', () => select(registry, ['definitely-not-a-real-e2e-id'])],
  ['duplicate ID', () => select(registry, [ids[0], ids[0]])],
  ['invalid ID', () => select(registry, ['../etc/passwd'])],
  ['empty selection', () => select(registry, [])],
];
for (const [label, probe] of negatives) {
  assert.throws(probe, undefined, label + ' must be rejected by the selector');
}

console.log('E2E selector contract: ' + ids.join(',') +
  ' resolve exactly; unknown/duplicate/invalid/empty rejected');
