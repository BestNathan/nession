'use strict';
// #3547 SC-02: in `c1 register -> c2 replace -> c1 abnormal exit`, c2 remains
// the authoritative Agent generation, and c1's cleanup neither releases c2's
// control channel nor clears the Agent Token c2's registration vouched for.
//
// The test holds two real Server connections for one agent id, ends the older
// one through the decode-error path, then proves the replacement is still the
// connection commands reach and that attach still hands out its cached token.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'websocket::a_superseded_agents_abnormal_exit_leaves_the_new_generation_authoritative';

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', TEST],
    600_000,
  );
  assertRan(server, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': after c1 register -> c2 replace -> c1 malformed-frame exit, a brokered command was answered ' +
      'on c2 and server.session.attach still returned c2\'s cached Agent Token as success',
  });
  return (
    'A superseded connection ending through the error path leaves the newer generation authoritative: ' +
    'release is generation-fenced and the current generation\'s cached token survives'
  );
});
