'use strict';
// #3547 SC-01: a real registered Agent connection that sends a frame the Server
// cannot decode ends within the bounded teardown interval and leaves no reader,
// writer or lane task, and no stale broker registration behind.
//
// The test drives the exact Server over a real loopback WebSocket: the peer
// observing its own connection end is the proof that the reader *and* the writer
// settled, and the brokered command answered "Agent disconnected" is the proof
// that the registration was released rather than retained.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TEST = 'websocket::an_agent_that_sends_a_malformed_frame_is_torn_down_and_released';

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
      ': a registered Agent WebSocket that sent undecodable JSON closed within the bounded grace, ' +
      'and a brokered capture-preview was answered "Agent disconnected" instead of being retained',
  });
  return (
    'A registered Agent connection ending through a malformed frame runs the unconditional ' +
    'generation-fenced teardown: the socket closes within the bound and the broker releases the agent'
  );
});
