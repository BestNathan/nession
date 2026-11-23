#!/usr/bin/env node
// #4140: bounded model correction after a *trusted* strict Source Repair replay
// mismatch. No GitHub credentials, protected writes, model shell or gate bypass.
// The independent Publisher still rebuilds the candidate and replay from bytes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const FIXED_REPLAY_FAILURE='source repair did not reproduce the resolved merge tree';
function check(v,msg){if(!v)throw Error('Source Repair runner: '+msg)}
export function eligibleRetry({mode,status,stderr}){
  // Retry only the exact known deterministic replay invariant. Never retry a
  // stale source, foreign path, whitespace, wrong parent or tool/model error.
  return mode==='source-repair'&&status===1&&
    typeof stderr==='string'&&stderr.includes(FIXED_REPLAY_FAILURE);
}
function run(file,args,env){
  const proc=spawnSync(process.execPath,[file,...args],{
    cwd:process.cwd(),env:{...process.env,...env},
    encoding:'utf8',maxBuffer:1024*1024,timeout:20*60*1000});
  if(proc.error)throw Error('Source Repair runner subprocess error');
  return proc;
}
function failIfAgentError(proc,attempt){
  if(proc.status!==0)throw Error('Source Repair runner: restricted Agent attempt '+attempt+' did not complete');
}
function validate(mode,context,candidate){
  return run(path.join(process.cwd(),'scripts/merge-conflict-resolution-probe.mjs'),
    ['finalize',process.cwd(),context,mode,candidate],{});
}
function main(){
  const [context,mode,agentDir,candidateDir]=process.argv.slice(2);
  check(process.env.CONVERGENCE_PRODUCTION==='true','production-only runner');
  check(['source-repair','direct-integration'].includes(mode),'invalid resolution mode');
  check(context&&agentDir&&candidateDir&&fs.existsSync(context),'missing input');
  check(!fs.existsSync(candidateDir),'refuse preexisting candidate directory');
  const realAgent=path.join(process.cwd(),'scripts/merge-conflict-probe-agent.mjs');
  const originalAgent=run(realAgent,[context,mode,agentDir],
    {CONVERGENCE_REPLAY_FEEDBACK:''});
  failIfAgentError(originalAgent,1);
  const first=validate(mode,context,candidateDir);
  if(first.status===0){
    console.log(JSON.stringify({status:'candidate_verified',attempts:1,mode}));
    return;
  }
  if(!eligibleRetry({mode,status:first.status,stderr:first.stderr})){
    throw Error('Source Repair runner: independent Git validation refused candidate');
  }
  // Git index stages are preserved by the alternate-index validator. Keep the
  // full first attempt's canonical telemetry+trace before the second call.
  const firstDir=path.join(agentDir,'attempt1');
  fs.mkdirSync(firstDir,{recursive:false});
  for(const f of ['agent-telemetry.json','agent-execution-trace.json']){
    const src=path.join(agentDir,f);
    check(fs.existsSync(src)&&fs.statSync(src).size>0,'first-attempt provenance absent');
    fs.copyFileSync(src,path.join(firstDir,f),fs.constants.COPYFILE_EXCL);
  }
  console.log('Independent Git Source Repair replay mismatch; one bounded correction attempt permitted');
  const second=run(realAgent,[context,mode,agentDir],
    {CONVERGENCE_REPLAY_FEEDBACK:'source-replay-mismatch',
     CONVERGENCE_AGENT_MAX_TURNS:'12'});
  failIfAgentError(second,2);
  const replay=validate(mode,context,candidateDir);
  if(replay.status!==0)
    throw Error('Source Repair runner: final independent Git replay still rejected');
  console.log(JSON.stringify({status:'candidate_verified',attempts:2,mode,
    first_attempt_recorded:true}));
}
function selfTest(){
  assert.equal(eligibleRetry({mode:'source-repair',status:1,
    stderr:'Error: '+FIXED_REPLAY_FAILURE}),true);
  for(const x of [
    {mode:'direct-integration',status:1,stderr:FIXED_REPLAY_FAILURE},
    {mode:'source-repair',status:0,stderr:FIXED_REPLAY_FAILURE},
    {mode:'source-repair',status:1,stderr:'error: stale or forged merge-tree identity'},
    {mode:'source-repair',status:1,stderr:'error: Agent modified non-conflicting paths'},
    {mode:'source-repair',status:1,stderr:'error: unresolved conflict marker'},
    {mode:'source-repair',status:1,stderr:'Error: cannot read model output'},
  ])assert.equal(eligibleRetry(x),false,JSON.stringify(x));
  console.log('Source Repair: only strict replay mismatch gets one bounded correction: PASS');
}
if(process.argv[2]==='self-test')selfTest();
else{try{main()}catch(e){console.error(e.message);process.exitCode=1}}
