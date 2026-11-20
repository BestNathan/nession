'use strict';
// #4088 SC-02 (SCN-03): the writable loopback Registry accepts the standard
// chunked blob upload and manifest push, publishes a tag only after the complete
// verified closure is present, preserves byte/digest identity on readback, and
// rejects an incomplete closure, a tampered digest claim and an unauthorized
// push without leaving a visible tag.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc02_loopback_push_publishes_only_verified_closure';
const MEASURED = /^#4088 SC-02 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-erofs',
    ['--lib', '--features', 'cache,registry', TEST],
    600000,
  );
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-02 loopback push measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-02: the writable loopback Registry publishes only a complete verified closure with preserved identity and rejects incomplete/tampered/unauthorized pushes without a visible tag';
});