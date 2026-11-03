'use strict';
// #2653 SC-03: after saturation/timeout/refusal, a valid credential-bearing P2P
// attach succeeds; scoped authorization remains enforced and invalid/missing
// credentials still cannot upgrade.
const {
  run,
  cargoTests,
  assertRan,
  targetSha,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  // Recovery: the plain and TLS listeners serve a real credential after their
  // incomplete handshakes expire, and a refused upgrade does not consume the
  // budget a valid client needs.
  const recovered = cargoTests(['--lib', 'handshake'], 900000);
  assertRan(recovered, [
    'plain_incomplete_handshakes_time_out_and_capacity_recovers',
    'tls_incomplete_handshakes_time_out_and_capacity_recovers',
    'a_refused_upgrade_releases_its_handshake_slot',
  ]);

  // #1013 is unchanged: nothing presented, an invented credential, another
  // agent's credential, and a frame outside the credential's scope are all
  // still refused.
  const refused = cargoTests(['--lib', '_is_refused'], 900000);
  assertRan(refused, [
    'a_connection_with_no_credential_is_refused',
    'a_credential_nobody_issued_is_refused',
    'one_agents_credential_is_refused_by_another',
    'a_frame_outside_the_scope_is_refused_and_the_connection_survives',
  ]);

  const accepted = cargoTests(['--lib', 'the_minted_credential_is_accepted'], 900000);
  assertRan(accepted, ['the_minted_credential_is_accepted']);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a valid credential attaches and receives a pong after plain and ' +
      'TLS incomplete handshakes expire and after a refused upgrade; no-credential, invented, ' +
      'foreign-agent and out-of-scope peers remain refused',
  });
  return (
    'A valid credential-bearing P2P attach succeeds after saturation/timeout/refusal while ' +
    'scoped authorization and fail-closed upgrades remain enforced'
  );
});
