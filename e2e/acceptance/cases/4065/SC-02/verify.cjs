'use strict';
// #4065 SC-02: the half-open connection leaves a fresh Relay usable; the
// existing generation-safe teardown regression independently rejects stale
// control owner cleanup and orphaned sibling attachments.
const {run,targetSha,assertRan,crateTests}=require('../../../shared/control-mode-cases.cjs');
const TESTS=[
  'websocket::half_open_relay_reports_reason_and_reattaches',
  'websocket::a_superseded_agents_abnormal_exit_leaves_the_new_generation_authoritative',
  'websocket::an_attached_client_that_sends_a_malformed_frame_retires_only_its_attachment',
];
run(({evidence})=>{
  const sha=targetSha();
  for(const test of TESTS){
    const result=crateTests('nession-server',['--test','integration',test],600_000);
    assertRan(result,[test]);
  }
  evidence.push({type:'runtime',value:sha+': silent Agent-leg retirement closed its browser, replacement Relay accepted input once, superseded generation could not unregister its new owner, and abnormal attached-client cleanup left sibling and Session intact'});
  return 'Real sockets establish bounded Relay retirement, preserved Session and generation-fenced teardown with replacement ownership';
});
