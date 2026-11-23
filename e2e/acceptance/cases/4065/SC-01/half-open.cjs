'use strict';
// #4065 SC-01 (verifier 1 of 2): exact-SHA real Server/Agent-facing WebSocket
// proof that a silently half-open Agent Relay leg (no FIN/RST, no pong/terminal
// data) is retired within the documented idle watchdog with an explicit
// client-visible close reason, and the persisted Session remains reattachable.
//
// Split from the idle-survival verifier: the driver SIGKILLs every verifier
// process at 120s, so each heavy cargo integration test gets its own verifier
// (and its own 120s) while the Cargo target cache is reused (#3735 pattern).
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const TEST='websocket::half_open_relay_reports_reason_and_reattaches';
run(({evidence})=>{
  const sha=targetSha();
  const result=crateTests('nession-server',['--test','integration',TEST],110_000);
  assertRan(result,[TEST]);
  evidence.push({type:'runtime',value:sha+': real Server Relay over authenticated Agent-facing socket received no pong/terminal data after attach and emitted WebSocket close reason relay-agent-half-open within the bounded idle watchdog (elapsed >=35s); the persisted Session survived and a replacement browser reattached and forwarded exactly one terminal-input frame'});
  return 'Authenticated Relay silent Agent-leg partition triggers a bounded, explicit client-visible close and leaves the Session reattachable';
});
