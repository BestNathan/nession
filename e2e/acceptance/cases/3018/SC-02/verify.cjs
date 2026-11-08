'use strict';
// #3018 SC-02: a real isolated tmux Session with a child carrying a
// leading-hyphen secret produces a Session process snapshot whose serialized
// command field contains only sanitized material; ordinary discovery remains
// usable. The projection/serialization fixture runs alongside the live test.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  runProcessDiscoveryTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const names = [
    'a_leading_hyphen_secret_does_not_reach_the_serialized_snapshot',
    'a_real_isolated_session_redacts_a_leading_hyphen_secret_in_its_snapshot',
    'a_real_isolated_session_reports_its_pane_and_descendants',
  ];
  runProcessDiscoveryTests(names);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a real isolated tmux Session with a child argv ' +
      '`--token -e2e-3018-secret-<pid>` produced a snapshot containing ' +
      '`--token [REDACTED]` with no raw value in the serialized JSON; the Pane ' +
      'root and descendants remained discoverable',
  });
  return 'A Session process snapshot built by the real Agent/tmux discovery path never serializes a leading-hyphen secret flag value, and ordinary discovery stays usable';
});
