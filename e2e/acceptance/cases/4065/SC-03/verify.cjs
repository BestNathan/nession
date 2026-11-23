'use strict';
// #4065 SC-03: a replacement authenticated browser/client can reattach to the
// same persisted Session and transfer a single terminal-input frame. Slow or
// idle but responding Agents stay alive under source-owned probe/timeout tests.
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const INTEGRATION=[
  'websocket::half_open_relay_reports_reason_and_reattaches',
  'websocket::relay_publishes_only_server_authored_agent_subscription_proof',
  'websocket::relay_output_applied_reaches_current_attached_agent_without_rewriting_identity',
];
const UNIT=[
  'slow_but_responsive_agent_not_declared_half_open',
  'idle_client_triggers_probe_ping_within_interval',
];
run(({evidence})=>{
  const sha=targetSha();
  for(const test of INTEGRATION){
    const result=crateTests('nession-server',['--test','integration',test],600_000);
    assertRan(result,[test]);
  }
  for(const name of UNIT){
    const output=crateTests('nession-server',['--lib',name],600_000);
    assertRan(output,[name]);
  }
  evidence.push({type:'runtime',value:sha+': credentialed browser reattached same Session to a new Agent-side socket and sent one terminal-input frame without duplication; slow-but-responsive frames stay below the watchdog; idle probes are actually sent; subscriber route proof cannot be forged, and output ACK reaches the current Agent owner'});
  return 'Reattach/reconcile preserves one terminal input with generation-bound route/ACK proof, while responsive Agents are not spuriously declared half-open';
});
