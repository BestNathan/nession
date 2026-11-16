'use strict';
// #3548 SC-02: through real plain and TLS WebSocket connections, Text, Binary,
// Ping, Pong and Close keep their existing external protocol semantics after
// the frame vocabulary moved behind the transport adapters.
//
// The tests dial the real Agent P2P listener (plain and wss), assert a Ping is
// answered with the same payload, Binary/Pong are ignored without ending the
// connection, a later text frame still authenticates, a protocol ping is
// answered, and Close ends the socket.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'server::websocket::tests::plain_transport_frames_keep_their_semantics',
  'server::websocket::tests::tls_transport_frames_keep_their_semantics',
];

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--lib', 'transport_frames'], 600_000);
  assertRan(agent, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': over real plain and TLS Agent sockets, Ping was answered with the same payload, Binary and ' +
      'Pong were ignored without ending the connection, a following text frame authenticated and got ' +
      'its protocol ping answered, and Close ended the socket',
  });
  return (
    'Plain and TLS WebSockets keep text/binary/ping/pong/close semantics through the shared frame ' +
    'vocabulary: control frames are handled as before and a text envelope still authenticates'
  );
});
