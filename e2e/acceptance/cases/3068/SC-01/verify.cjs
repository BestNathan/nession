'use strict';
const { assert, inspect, test, proof } = require('../../../shared/acceptance-source-cases.cjs');
proof(({ evidence, sha }) => {
  const output = test(['scripts/acceptance-sources.mjs', 'self-test']);
  assert.match(output, /parser, source materialization, drift and citation fixtures passed/);
  assert.match(inspect('scripts/acceptance-sources.mjs'), /function parseAcceptanceSources/);
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha +
    ': structured source parser passes allowed/invalid branch, SHA, traversal, duplicate path and citation negative fixtures' });
  return 'The immutable per-SC source declaration rejects malformed, unsafe and unsupported inputs';
});
