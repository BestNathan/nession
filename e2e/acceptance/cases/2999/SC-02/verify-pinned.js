'use strict';
// #2999 SC-02 (pinned half): the deterministic broker-barrier test proves both
// response orders around two coordinated same-name creates against the real
// handler, broker and temporary binding store.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const name = 'concurrent_same_name_creates_keep_the_accepted_binding';
  const output = crateTests('nession-server', ['--lib', name], 300_000);
  assertRan(output, [name]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + name + ' Passed for the refused-first and accepted-first response orders',
  });
  return 'Two same-name creates share the real handler, broker and durable store; the refused attempt never dislodges the accepted binding in either response order';
});
