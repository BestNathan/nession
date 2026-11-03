'use strict';
// #2652 SC-02: a valid Agent-associated manual Relay route and the automatic
// candidate fallback still establish an authenticated Relay with the correct
// Agent/Session scope, and no unauthorized endpoint is tried during failure.
const {
  assertRan,
  readSource,
  serverLibTests,
} = require('../../../shared/relay-binding-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const manual = serverLibTests('relay_begin_accepts');
  assertRan(manual, [
    'relay_begin_accepts_a_manual_endpoint_registered_to_the_agent',
  ]);

  const automatic = serverLibTests('attach_relay_mode');
  assertRan(automatic, ['attach_relay_mode']);

  const handler = readSource(
    'crates/nession-server/src/server/handler/server_session_relay_begin_v1.rs',
  );
  // The automatic path still derives its candidates from the Agent's
  // registered addresses, in probe-status order, with the Server-owned legacy
  // address as the empty-list fallback.
  for (const marker of [
    'agent.addresses',
    'AddressStatus::Reachable',
    'AddressStatus::Unknown',
    'AddressStatus::Unreachable',
    'legacy_agent_address',
  ]) {
    if (!handler.includes(marker)) {
      throw new Error('the automatic Relay candidate set lost ' + marker);
    }
  }
  // A manual choice selects exactly the registered endpoint; it cannot widen
  // the candidate set.
  if (!handler.includes('vec![bound]')) {
    throw new Error('a bound manual Relay choice must select exactly its registered endpoint');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a registered manual endpoint still grants the scoped relay ' +
      'credential and dials the registered spelling; the automatic candidate fallback and ' +
      'the legacy address path are unchanged',
  });
  return (
    'A valid Agent-associated manual Relay route and the automatic candidate fallback ' +
    'both attach with the existing Agent/Session scope'
  );
});
