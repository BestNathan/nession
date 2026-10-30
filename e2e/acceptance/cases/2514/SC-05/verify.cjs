'use strict';
// #2514 SC-05: typed, authorized, bounded Agent→Server→Web snapshot contract.
//
// This Case proves the unit at both boundaries: the Protocol Kernel round-trips
// the snapshot (including unavailable metrics) and its untagged refusal; the
// Agent advertises `agent.session.processes` in its manifest; the Server
// refuses an unauthenticated browser, forwards only the Session name to a
// verified online Agent, relays a valid snapshot, and turns an Agent failure or
// an unreadable payload into a refusal rather than a partial answer. The read
// path mutates no Session state, so terminal continuity is unaffected.
const os = require('node:os');
const {
  run, targetSha, checked, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const platform = checked('uname', ['-sm'], 10000).trim();

  const contract = checked(
    'cargo',
    ['test', '-p', 'nession-protocol', '--lib', 'contracts::session', '--', '--nocapture'],
    300000,
  );
  assertRan(contract, [
    'a_process_snapshot_round_trips_with_its_honest_unknowns',
    'a_process_refusal_is_not_a_snapshot',
  ]);

  const server = checked(
    'cargo',
    ['test', '-p', 'nession-server', '--lib', 'server_session_processes', '--', '--nocapture'],
    600000,
  );
  assertRan(server, [
    'an_unauthenticated_client_is_refused',
    'a_malformed_session_id_is_refused',
    'an_unknown_agent_is_refused_without_asking_anyone',
    'a_snapshot_from_the_agent_is_relayed_to_the_browser',
    'an_agent_refusal_keeps_the_agents_own_reason',
    'an_unreadable_snapshot_is_a_refusal_not_a_partial_answer',
  ]);

  const manifest = checked(
    'cargo',
    [
      'test',
      '-p',
      'nession-agent',
      '--lib',
      'extension::tests::the_agent_composes_the_units_it_actually_serves',
      '--',
      '--nocapture',
    ],
    300000,
  );
  assertRan(manifest, ['the_agent_composes_the_units_it_actually_serves']);

  const protocol = checked('./gates/run', ['protocol-integrity'], 300000);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + platform +
        ': the typed snapshot round-tripped, with sampled zero preserved and unavailable metrics carrying a state and reason instead of a value',
    },
    {
      type: 'runtime',
      value:
        'the Server refused an unauthenticated browser, forwarded only the Session name to a verified online Agent, relayed a valid snapshot, and refused Agent failure or an unreadable payload',
    },
    {
      type: 'runtime',
      value:
        'the Agent manifest advertises agent.session.processes and the protocol-integrity gate accepted every wire: ' +
        protocol.split('\n').filter((line) => line.includes('protocol-integrity')).slice(-1).join(' '),
    },
  );
  return 'The process snapshot is a typed, authorized, bounded read-only contract at both boundaries, with refusals that never masquerade as partial data';
});
