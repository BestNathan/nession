'use strict';
// #4065 SC-01 (verifier 2 of 2): a responsive but idle Agent leg must survive
// more than the production 45s watchdog — real tungstenite peers answer
// ping/pong while both connections are idle — and still forward terminal input
// afterwards. The exact test waits a 51s deadline before sending input.
//
// Split from the half-open verifier: the driver SIGKILLs every verifier process
// at 120s, so each heavy cargo integration test gets its own verifier (and its
// own 120s) while the Cargo target cache is reused (#3735 pattern).
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const TEST='websocket::healthy_idle_agent_leg_survives_full_watchdog';
run(({evidence})=>{
  const sha=targetSha();
  const result=crateTests('nession-server',['--test','integration',TEST],110_000);
  assertRan(result,[TEST]);
  evidence.push({type:'runtime',value:sha+': a separate live Agent with active pong processing remained connected through a 51s idle window beyond the 45s watchdog and forwarded terminal input afterwards'});
  return 'A responsive idle Agent leg survives the full 45s watchdog and resumes terminal input';
});
