'use strict';
// #4066 SC-03: a nonempty Server Token is verified by the canonical
// constant-time verifier. Valid credentials pass; invalid, empty and
// malformed ones fail on a real socket, for both the browser `server.auth`
// handshake and `server.agent.register`. The refusal answers carry no token
// bytes.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
} = require('../../../shared/control-mode-cases.cjs');

const TOKEN_TESTS = [
  'websocket::test_invalid_auth_token',
  'websocket::test_agent_registration',
];

const BOUNDARY_TESTS = [
  'websocket::an_approved_browser_origin_connects_and_authenticates',
  'websocket::an_approved_origin_is_not_a_credential',
  'websocket::an_empty_presented_token_is_refused_when_one_is_configured',
  'websocket::an_unreadable_auth_frame_is_refused_when_one_is_configured',
  'websocket::an_agent_registration_with_a_wrong_token_is_rejected',
];

run(({ evidence }) => {
  const sha = targetSha();
  const auth = crateTests(
    'nession-server',
    ['--test', 'integration', 'websocket::test_'],
    60_000,
  );
  assertRan(auth, TOKEN_TESTS);

  const boundary = crateTests(
    'nession-server',
    ['--test', 'integration', 'websocket::an_'],
    90_000,
  );
  assertRan(boundary, BOUNDARY_TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': real Server sockets accepted the configured Server Token, refused a ' +
      'wrong token, an empty presented token and a malformed auth frame, and ' +
      'refused an Agent registration with a wrong token while accepting a valid ' +
      'one; refusal replies named no credential value',
  });
  return (
    'The configured Server Token is verified by the canonical constant-time ' +
    'verifier: valid credentials pass and invalid, empty or malformed ones fail ' +
    'for both client and Agent handshakes'
  );
});
