'use strict';
// #4066 SC-02: the Server's WebSocket upgrade boundary applies a browser
// Origin policy on `/ws` and the compatibility fallback. An unapproved Origin
// is refused before the upgrade; an approved one connects and still has to
// authenticate; an approved Origin is never a credential; origin-less
// CLI/Agent clients stay compatible.
//
// The assertions are real Server sockets from the exact target checkout, so
// the Case binds the Origin decision to the deployed upgrade path rather than
// to a mock.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'websocket::an_unapproved_browser_origin_is_rejected_on_ws',
  'websocket::an_unapproved_browser_origin_is_rejected_on_the_fallback_path',
  'websocket::an_approved_browser_origin_connects_and_authenticates',
  'websocket::an_approved_origin_is_not_a_credential',
  'websocket::an_origin_less_client_stays_compatible',
];

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'websocket::an_'],
    90_000,
  );
  assertRan(server, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': real Server sockets refused an unapproved browser Origin on /ws (403) and ' +
      'on the compatibility fallback (403), accepted the approved Origin, still ' +
      'refused it without the Server Token, and kept origin-less CLI/Agent clients ' +
      'compatible',
  });
  return (
    'The WS upgrade boundary refuses untrusted browser Origins on /ws and the ' +
    'fallback while approved Origins and origin-less clients still connect; the ' +
    'Origin is not a credential'
  );
});
