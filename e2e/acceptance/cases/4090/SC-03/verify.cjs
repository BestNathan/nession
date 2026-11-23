'use strict';
// #4090 SC-03 (SCN-03): an opted-in Agent-hosted read-only Registry advertises and
// serves only complete verified authorized objects (nothing until an authorized
// tag is registered against the verified cache), denies every mutation verb, and
// disabling it removes external Registry visibility without destroying the
// durable cache, its pins or active local Session mounts.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'registry::tests::sc03_agent_readonly_serves_only_registered_verified_closure',
  'registry::tests::sc03_agent_readonly_denies_every_mutation_verb',
  'registry::tests::sc03_disabling_removes_visibility_without_destroying_cache',
];
const MEASURED = /^#4090 SC-03 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-agent', ['--lib', 'registry::tests'], 600000);
  assertRan(output, TESTS);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-03 Agent read-only Registry measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-03: an opted-in Agent read-only Registry serves only registered verified authorized objects, denies mutation, and disabling removes visibility without destroying cache or Session mounts';
});