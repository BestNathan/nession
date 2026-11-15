'use strict';
// #3547 SC-03: an attached client WebSocket ending through a malformed frame or
// a failed Relay retires only that physical attachment — a sibling connection to
// the same Session keeps being served and a fresh connection can attach/resume.
//
// Both tests register real relay-mode attachments over real sockets and end one
// through the read loop's error paths, then use the Session and a reconnect to
// prove the Session itself was untouched.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

// One filter for both: they are the only `an_attached_client` tests, so a single
// compilation and run covers the malformed-frame and Relay-error exits.
const FILTER = 'websocket::an_attached_client';
const TESTS = [
  'websocket::an_attached_client_that_sends_a_malformed_frame_retires_only_its_attachment',
  'websocket::an_attached_client_whose_relay_cannot_dial_is_torn_down',
];

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', FILTER],
    600_000,
  );
  assertRan(server, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': one of two relay-mode client attachments ended through a malformed frame within the bounded ' +
      'grace while its sibling kept being served and a reconnect reattached; a client whose Relay dial ' +
      'failed also ended within the bound while the Session remained listed for a fresh connection',
  });
  return (
    'An attached client\'s abnormal exit (malformed frame or failed Relay) tears down only that physical ' +
    'connection; the Session remains served and a reconnect can reattach'
  );
});
