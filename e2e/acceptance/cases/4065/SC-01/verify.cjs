'use strict';
// #4065 SC-01: exact-SHA real Server/Agent-facing WebSocket runtime proof.
// One authenticated Agent Relay connection silently stops reading (no FIN/RST)
// and must yield a bounded, client-visible reason; the follow-on path remains usable.
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const TESTS=[
  'websocket::half_open_relay_reports_reason_and_reattaches',
  'websocket::healthy_idle_agent_leg_survives_full_watchdog',
];
run(({evidence})=>{
  const sha=targetSha();
  for(const test of TESTS){
    const result=crateTests('nession-server',['--test','integration',test],600_000);
    assertRan(result,[test]);
  }
  evidence.push({type:'runtime',value:sha+': real Server Relay over authenticated Agent-facing socket received no pong/terminal data after attach, emitted WebSocket close reason relay-agent-half-open within bounded watchdog; a separate live Agent with active pong processing remained connected and forwarded terminal input after 51s'});
  return 'Authenticated Relay silent Agent-leg partition triggers a bounded, explicit client-visible close while a responsive idle Agent survives the full 45s watchdog';
});
