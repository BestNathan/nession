'use strict';
// #4065 SC-01: exact-SHA real Server/Agent-facing WebSocket runtime proof.
// One authenticated Agent Relay connection silently stops reading (no FIN/RST)
// and must yield a bounded, client-visible reason; the follow-on path remains usable.
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const TEST='websocket::half_open_relay_reports_reason_and_reattaches';
run(({evidence})=>{
  const sha=targetSha();
  const result=crateTests('nession-server',['--test','integration',TEST],600_000);
  assertRan(result,[TEST]);
  evidence.push({type:'runtime',value:sha+': real Server Relay over authenticated Agent-facing socket received no pong/terminal data after attach, emitted WebSocket close reason relay-agent-half-open within bounded watchdog and allowed new browser/Agent-side relay'});
  return 'Authenticated Relay silent Agent-leg partition triggers a bounded, explicit client-visible close without prematurely retiring the Session';
});
