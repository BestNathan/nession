#!/usr/bin/env node
// #2010 exact owner-only independent Ingest replay. Worker code, Issue
// comments, untrusted Action inputs and forked runs cannot mint receipts.
import assert from 'node:assert/strict';
import {assertQwenBotWakeSource,resolveTrustedIngestSource,NATIVE_RECOVERY_ACTION,
  NATIVE_RECOVERY_RUN,NATIVE_RECOVERY_SHA,NATIVE_RECOVERY_INGEST_COMMAND,
  QWEN_3784_INGEST_COMMENT}
  from './development-ingest.mjs';
const runId=39288961865;
const environment={
  GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_EVENT_NAME:'issue_comment',
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW:'Store / Agent Development Ingest',
  GITHUB_ACTOR:'BestNathan',GITHUB_SHA:'a'.repeat(40),
};
const event={action:'created',
  repository:{full_name:'BestNathan/nession'},
  issue:{number:1997},
  comment:{id:90909,user:{login:'BestNathan'},
    body:'/nession ingest issue=1997 worker_run=39288961865'}};
const good={environment,event};
assert.deepEqual(resolveTrustedIngestSource(good),{run_id:runId,source:null});
const resumeCommand='/nession ingest issue=1997 action=3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8 worker_run=39388961865';
const resumed={environment,event:{...event,comment:{...event.comment,body:resumeCommand}}};
assert.deepEqual(resolveTrustedIngestSource(resumed),{run_id:39388961865,source:null,continuation:true});
for(const command of [resumeCommand+' ',resumeCommand.replace('3f4abb','0f4abb'),
  resumeCommand.replace('39388961865','1'),resumeCommand.replace('issue=1997','issue=1998')])
  assert.throws(()=>resolveTrustedIngestSource({...resumed,event:{...resumed.event,
    comment:{...resumed.event.comment,body:command}}}));
const nativeEvent={...event,comment:{...event.comment,body:NATIVE_RECOVERY_INGEST_COMMAND}};
const nativeGood={environment,event:nativeEvent};
assert.equal(NATIVE_RECOVERY_RUN,39396836009);
assert.equal(NATIVE_RECOVERY_SHA,'2f75869833fb43ec54e88b560226f8913a6beac3');
assert.equal(NATIVE_RECOVERY_ACTION,'6a84244ca028a93f8c057ab23852bb21c3906d485e4c16ccab661104c31d750e');
assert.deepEqual(resolveTrustedIngestSource(nativeGood),
  {run_id:NATIVE_RECOVERY_RUN,source:null,continuation:true,native_recovery:true});
for(const bad of [
  NATIVE_RECOVERY_INGEST_COMMAND+' ',
  NATIVE_RECOVERY_INGEST_COMMAND.replace('worker_run=39396836009','worker_run=39396836010'),
  NATIVE_RECOVERY_INGEST_COMMAND.replace('action='+NATIVE_RECOVERY_ACTION,'action='+'f'.repeat(64)),
  NATIVE_RECOVERY_INGEST_COMMAND.replace('issue=1997','issue=1998'),
  NATIVE_RECOVERY_INGEST_COMMAND.replace('ingest','resume')]) {
  assert.throws(()=>resolveTrustedIngestSource({...nativeGood,event:{...nativeEvent,
    comment:{...nativeEvent.comment,body:bad}}}),/manual checkpoint recovery/);
}
for(const bad of [
  {environment:{...environment,GITHUB_ACTOR:'fork'}},
  {environment:{...environment,GITHUB_REF:'refs/heads/staging'}},
  {event:{...nativeEvent,action:'edited'}},
  {event:{...nativeEvent,comment:{...nativeEvent.comment,user:{login:'fork'}}}},
  {event:{...nativeEvent,issue:{number:1997,pull_request:{url:'https://example.org'}}}},
])assert.throws(()=>resolveTrustedIngestSource({...nativeGood,...bad}),/trusted|manual checkpoint/);
const denied=[
  {environment:{...environment,GITHUB_ACTOR:'other'}},
  {environment:{...environment,GITHUB_REF:'refs/pull/5/merge'}},
  {environment:{...environment,GITHUB_WORKFLOW:'Agent / Development'}},
  {environment:{...environment,GITHUB_SHA:'invalid'}},
  {event:{...event,action:'edited'}},
  {event:{...event,repository:{full_name:'fork/nession'}}},
  {event:{...event,issue:{number:2010}}},
  {event:{...event,issue:{number:1997,pull_request:{url:'https://example.org'}}}},
  {event:{...event,comment:{...event.comment,user:{login:'attacker'}}}},
  {event:{...event,comment:{...event.comment,body:event.comment.body+' '}}},
  {event:{...event,comment:{...event.comment,body:'/nession ingest issue=1997 worker_run=123'}}},
];
for(const bad of denied)assert.throws(
  ()=>resolveTrustedIngestSource({...good,...bad}),/trusted|manual checkpoint/);
const workflowRun={...environment,GITHUB_EVENT_NAME:'workflow_run'};
const source={id:runId,run_attempt:1,
  head_sha:'e6e64eb84663f2bb935b9c0628d9ab787523186b',
  conclusion:'success'};
const workflowEvent={action:'completed',workflow_run:source};
assert.deepEqual(resolveTrustedIngestSource({environment:workflowRun,event:workflowEvent}),
  {run_id:runId,source});
assert.throws(()=>resolveTrustedIngestSource({environment:workflowRun,
  event:{...workflowEvent,action:'requested'}}),/completed successful/);
assert.throws(()=>resolveTrustedIngestSource({environment:workflowRun,
  event:{...workflowEvent,workflow_run:{...source,conclusion:'failure'}}}),/completed successful/);
const qwenEnv={...environment,GITHUB_EVENT_NAME:'issue_comment'};
const qwenEvent={action:'created',repository:{full_name:'BestNathan/nession'},
  issue:{number:2817},
  comment:{id:90910,user:{login:'BestNathan'},
    body:'/nession ingest-qwen issue=2817 worker_run=42344231027'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,event:qwenEvent}),
  {run_id:42344231027,source:null,qwen_recovery:true,issue:2817,attempt:1});
const qwenRepairEvent={...qwenEvent,issue:{number:2906},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=2906 worker_run=42365960306'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenRepairEvent}),
{run_id:42365960306,source:null,qwen_recovery:true,issue:2906,attempt:1});
const qwenRepair2={...qwenEvent,issue:{number:2912},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=2912 worker_run=42368100929'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenRepair2}),
{run_id:42368100929,source:null,qwen_recovery:true,issue:2912,attempt:1});
const qwenRepair3={...qwenEvent,issue:{number:2946},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=2946 worker_run=42396535371'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenRepair3}),
{run_id:42396535371,source:null,qwen_recovery:true,issue:2946,attempt:1});
const qwenRepair4={...qwenEvent,issue:{number:2951},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=2951 worker_run=42398182736'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenRepair4}),
{run_id:42398182736,source:null,qwen_recovery:true,issue:2951,attempt:1});
const qwenRepair5={...qwenEvent,issue:{number:2961},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=2961 worker_run=42410000000'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenRepair5}),
{run_id:42410000000,source:null,qwen_recovery:true,issue:2961,attempt:1});
const qwenV2Issue={...qwenEvent,issue:{number:3001,state:'open'},
  comment:{...qwenEvent.comment,
    body:'/nession ingest-qwen issue=3001 worker_run=42488022265'}};
assert.deepEqual(resolveTrustedIngestSource({environment:qwenEnv,
  event:qwenV2Issue}),
  {run_id:42488022265,source:null,qwen_recovery:true,issue:3001,attempt:1});
assert.throws(()=>resolveTrustedIngestSource({environment:qwenEnv,
  event:{...qwenV2Issue,comment:{...qwenV2Issue.comment,
    body:'/nession ingest-qwen issue=3002 worker_run=42488022265'}}}),
  /exact owner\/main/);
const recoveredRepair={...qwenV2Issue,
  issue:{number:3433,state:'open'},
  comment:{...qwenV2Issue.comment,
    body:'/nession ingest-qwen issue=3433 worker_run=43677482758'}};
assert.deepEqual(resolveTrustedIngestSource({
  environment:qwenEnv,event:recoveredRepair}),
  {run_id:43677482758,source:null,qwen_recovery:true,
    issue:3433,attempt:1});
for(const bad of [
  {event:{...recoveredRepair,issue:{number:3434,state:'open'}}},
  {event:{...recoveredRepair,comment:{...recoveredRepair.comment,
    body:'/nession ingest-qwen issue=3433 worker_run=43677482759'}}},
  {event:{...recoveredRepair,comment:{...recoveredRepair.comment,
    body:'/nession ingest-qwen issue=3433 worker_run=43677482758 '}}},
  {event:{...recoveredRepair,comment:{...recoveredRepair.comment,
    user:{login:'other'}}}},
  {environment:{...qwenEnv,GITHUB_ACTOR:'other'}},
])assert.throws(()=>resolveTrustedIngestSource({
  environment:qwenEnv,event:recoveredRepair,...bad}),/owner|exact|trusted|Ingest/);
for(const bad of [
  {environment:{...qwenEnv,GITHUB_ACTOR:'fork'}},
  {environment:{...qwenEnv,GITHUB_REF:'refs/heads/staging'}},
  {event:{...qwenEvent,action:'edited'}},
  {event:{...qwenEvent,issue:{number:2817,pull_request:{url:'https://example.org'}}}},
  {event:{...qwenEvent,comment:{...qwenEvent.comment,user:{login:'fork'}}}},
  {event:{...qwenEvent,comment:{...qwenEvent.comment,body:
    qwenEvent.comment.body+' '}}},
  {event:{...qwenEvent,comment:{...qwenEvent.comment,body:
    '/nession ingest-qwen issue=2817 worker_run=x'}}},
  {event:{...qwenEvent,comment:{...qwenEvent.comment,body:
    '/nession ingest-qwen issue=2906 worker_run=42365960306'}}},
  {event:{...qwenRepairEvent,comment:{...qwenRepairEvent.comment,body:
    '/nession ingest-qwen issue=2817 worker_run=42365960306'}}},
  {event:{...qwenRepairEvent,issue:{number:3000}}},
  {event:{...qwenRepair2,issue:{number:2906}}},
  {event:{...qwenRepair3,issue:{number:2912}}},
  {event:{...qwenRepair4,issue:{number:2946}}},
  {event:{...qwenRepair5,issue:{number:2951}}},
])assert.throws(()=>resolveTrustedIngestSource({...{
  environment:qwenEnv,event:qwenEvent},...bad}));
// #3885: the bot-main wake only locates the authenticated Worker. The
// signed Implement source may be any genuine ancestor of the Worker main SHA;
// a superficially valid but unrelated commit must still be rejected. Repair
// consumes the published PR SHA and remains Store/Publisher-bound.
const workflowSha='a'.repeat(40);
const olderTrustedMain='c'.repeat(40);
const reviewHead='b'.repeat(40);
const unrelatedBranch='d'.repeat(40);
const wakeRun={head_sha:workflowSha};
const isMainAncestor=(source,worker)=>
  worker===workflowSha&&[workflowSha,olderTrustedMain].includes(source);
const qwenImplement={inputs:{agent_id:'dev-qwen-01',task:'implement',
  input_sha:workflowSha}};
const olderImplement={inputs:{...qwenImplement.inputs,input_sha:olderTrustedMain}};
const qwenRepair={inputs:{agent_id:'dev-qwen-01',task:'repair',
  input_sha:reviewHead}};
const wake=claim=>assertQwenBotWakeSource({run:wakeRun,claim,isMainAncestor});
assert.deepEqual(wake(qwenImplement),
  {task:'implement',source_sha:workflowSha});
assert.deepEqual(wake(olderImplement),
  {task:'implement',source_sha:olderTrustedMain});
assert.deepEqual(wake(qwenRepair),
  {task:'repair',source_sha:reviewHead});
for(const claim of [
  {...qwenImplement,inputs:{...qwenImplement.inputs,input_sha:reviewHead}},
  {...qwenImplement,inputs:{...qwenImplement.inputs,input_sha:unrelatedBranch}},
  {...qwenRepair,inputs:{...qwenRepair.inputs,input_sha:workflowSha}},
  {...qwenRepair,inputs:{...qwenRepair.inputs,agent_id:'dev-cursor-01'}},
  {...qwenRepair,inputs:{...qwenRepair.inputs,task:'review'}},
  {...qwenRepair,inputs:{...qwenRepair.inputs,input_sha:'invalid'}},
  {...qwenRepair,inputs:{...qwenRepair.inputs,input_sha:null}},
])assert.throws(()=>wake(claim),/signed trusted-main Qwen/);
assert.throws(()=>assertQwenBotWakeSource({
  run:wakeRun,claim:olderImplement,isMainAncestor:()=>false}),
  /signed trusted-main Qwen/);
assert.throws(()=>assertQwenBotWakeSource({
  run:{head_sha:'invalid'},claim:qwenRepair}),/signed trusted-main Qwen/);
// #3784: a repeated Model Run is forbidden; the Owner comment locates only
// the existing successful Worker, exact Run ID + Issue, independently
// checked against signed claim, Store and immutable result Artifact.
const recovered3784={...qwenV2Issue,issue:{number:3784,state:'open'},
  comment:{...qwenV2Issue.comment,body:QWEN_3784_INGEST_COMMENT}};
assert.deepEqual(resolveTrustedIngestSource({
  environment:qwenEnv,event:recovered3784}),
  {run_id:44259490499,source:null,qwen_recovery:true,
    issue:3784,attempt:1});
for(const bad of [
  {event:{...recovered3784,issue:{number:3785,state:'open'}}},
  {event:{...recovered3784,comment:{...recovered3784.comment,
    body:QWEN_3784_INGEST_COMMENT+' '}}},
  {event:{...recovered3784,comment:{...recovered3784.comment,
    body:QWEN_3784_INGEST_COMMENT.replace('44259490499','44259490500')}}},
  {event:{...recovered3784,comment:{...recovered3784.comment,
    user:{login:'external'}}}},
  {environment:{...qwenEnv,GITHUB_ACTOR:'attacker'}},
  {environment:{...qwenEnv,GITHUB_REF:'refs/heads/staging'}},
])assert.throws(()=>resolveTrustedIngestSource({
  environment:qwenEnv,event:recovered3784,...bad}),
  /owner|exact|trusted|Ingest/);

console.log('Trusted Ingest replay: exact owner/main/source, fork, Issue, edited comment, manual Qwen Worker Run and event denial passed');
