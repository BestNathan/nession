'use strict';
const { assert, inspect, test, proof } = require('../case-shared.cjs');
proof(({ evidence, sha }) => {
  const output = test(['scripts/acceptance-sources.mjs', 'self-test']);
  assert.match(output, /source materialization, drift and citation fixtures passed/);
  const script = inspect('scripts/acceptance-sources.mjs');
  for (const invariant of ['merge-base', 'ls-tree', 'cat-file', 'manifest.json',
    'reserved staging root already exists', 'read-only', 'sha256']) {
    assert.ok(script.includes(invariant), 'missing source staging invariant ' + invariant);
  }
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha +
    ': real temporary Git fixture materializes pinned content; moving tip preserves original bytes, unreachable force-push and collision are rejected' });
  return 'Exact source commit and manifest are authoritative, independent of a later branch tip';
});
