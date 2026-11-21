'use strict';
// #4072 SC-01: a real Agent `ServerClient` against a mock Server that completes
// the WS upgrade but never answers registration — and against a TCP peer that
// accepts but never completes the upgrade — settles inside the finite total
// attempt deadline. `connect_and_run` also receives its first-start outcome
// instead of hanging, and the failure takes the existing backoff path.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const REGISTRATION_STALL =
  'connection::server_client::tests::connect_attempt_registration_stall_settles_within_deadline';
const UPGRADE_STALL =
  'connection::server_client::tests::connect_attempt_upgrade_stall_settles_within_deadline';

run(({ evidence }) => {
  const sha = targetSha();
  const registration = crateTests(
    'nession-agent',
    ['--lib', 'connection::server_client::tests::connect_attempt_registration_stall'],
    300000,
    isolatedTmuxEnv('nession-4072-sc01-registration'),
  );
  assertRan(registration, [REGISTRATION_STALL]);

  const upgrade = crateTests(
    'nession-agent',
    ['--lib', 'connection::server_client::tests::connect_attempt_upgrade_stall'],
    300000,
    isolatedTmuxEnv('nession-4072-sc01-upgrade'),
  );
  assertRan(upgrade, [UPGRADE_STALL]);

  evidence.push({
    type: 'runtime',
    value:
      'exact staging ' + sha + ': a real Agent ServerClient dialled a mock Server whose ' +
      'WS upgrade completed but registration was never acknowledged, and a peer that never ' +
      'answered the HTTP Upgrade; both attempts and the first-start outcome settled within ' +
      'the explicit attempt deadline, and the supervisor then entered bounded backoff',
  });
  return 'WS Upgrade and registration stalls settle within the total attempt deadline';
});
