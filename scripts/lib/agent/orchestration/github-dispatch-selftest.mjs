import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {startDevelopment,recordDispatch,acceptTaskResult,reconcileOutbox} from './outbox.mjs';
import {issueDispatchTicket,verifyDispatchTicket,planGitHubDispatch,
  createGitHubRunReader,createGitHubDispatchClient,attestAgentOutcome,
  reviewerPublishedPrBinding,planControlledReviewerRecovery} from './github-dispatch.mjs';

const registry=JSON.parse(readFileSync('automation/agents/registry.json','utf8'));
const a='a'.repeat(40), b='b'.repeat(40), main='f'.repeat(40);
const now=Date.parse('2026-10-13T08:00:00.000Z'),issue=1706;
const key=Buffer.alloc(32,0x62), keyring={'control-v1':key};
const request={issue,sha:a,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const authority={repository:'BestNathan/nession',event:'workflow_dispatch',
  permission:'write',ref:'refs/heads/main',run_id:222};
let state=startDevelopment(registry,request,authority);
const item=reconcileOutbox(state).pending[0];
const signer={key,key_id:'control-v1',issuer_run_id:222,now,ttl_ms:600000};
const {ticket,body}=issueDispatchTicket(state,item.id,registry,signer);

const unsignedRepairState={...state,phase:'repair',target_sha:b,repair_attempts:1,
  outbox:[{id:'e'.repeat(64),task:{type:'dispatch',role:'developer',
    agent_id:'dev-cursor-01',task:'repair',sha:b,resume:true},
    status:'pending',attempts:0,receipt:null}]};
assert.throws(()=>issueDispatchTicket(unsignedRepairState,
  'e'.repeat(64),registry,signer),/Store-bound native checkpoint/);
assert.throws(()=>planGitHubDispatch(unsignedRepairState,
  'e'.repeat(64),registry,signer),/Store-bound native checkpoint/);
// The exact immutable #1997 v22 Repair action must not become a signed
// workflow_dispatch from a mere boolean flag.
const historicalRepairAction=
  'd899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const historicalRepairState={...unsignedRepairState,issue:1997,version:22,
  target_sha:'3d8e3807cc01f6082734b8d0ba458217c28f60a4',
  outbox:[{...unsignedRepairState.outbox[0],id:historicalRepairAction,
    task:{...unsignedRepairState.outbox[0].task,
      sha:'3d8e3807cc01f6082734b8d0ba458217c28f60a4'}}]};
assert.throws(()=>planGitHubDispatch(historicalRepairState,
  historicalRepairAction,registry,signer),/Store-bound native checkpoint/);
for(const wrong of [false,undefined]){
  const invalid={...unsignedRepairState,outbox:[
    {...unsignedRepairState.outbox[0],task:{
      ...unsignedRepairState.outbox[0].task,resume:wrong}}]};
  assert.throws(()=>issueDispatchTicket(invalid,'e'.repeat(64),registry,signer),
    /Store-bound native checkpoint/);
}

const plan=planGitHubDispatch(state,item.id,registry,signer);
assert.equal(plan.workflow_id,'agent-develop.yml');
assert.deepEqual(verifyDispatchTicket(ticket,keyring,{now}),body);
assert.equal(plan.inputs.dispatch_ticket,ticket);
assert.equal(plan.ticket,ticket);
assert.throws(()=>verifyDispatchTicket(ticket,keyring,{now:now+700000}),/validity window/);
assert.throws(()=>verifyDispatchTicket(ticket,{'control-v1':Buffer.alloc(32,0x63)},{now}),/HMAC/);
assert.throws(()=>verifyDispatchTicket(ticket,{'control-v2':key},{now}),/unknown signing key/);
assert.throws(()=>verifyDispatchTicket(ticket.slice(0,-3)+'aaa',keyring,{now}),/HMAC|signature|malformed/);
assert.throws(()=>issueDispatchTicket(state,item.id,registry,{...signer,ttl_ms:9999999}),/TTL/);
assert.throws(()=>planGitHubDispatch(state,'0'.repeat(64),registry,signer),/not pending/);
state=recordDispatch(state,state.version,item.id,
  {status:'verified',dispatch_id:item.id,source_run_id:333});
assert.throws(()=>planGitHubDispatch(state,item.id,registry,signer),/not pending/);
const uncertain=recordDispatch(startDevelopment(registry,request,authority),1,item.id,
  {status:'accepted',dispatch_id:item.id});
await assert.rejects(()=>attestAgentOutcome({
  state:uncertain,result:{kind:'developer',issue,run_id:333,run_attempt:1,
    target_sha:b,outcome:'implementation_ready',task_id:item.id},
  dispatch_ticket:ticket,pr_number:42,registry,
  reader:{getRun:async()=>({}),getPullRequest:async()=>({})},
  keyring,now:now+700000,verified_main_sha:main,
}),/no trusted run-bound/);

const posted=[];
const api200=createGitHubDispatchClient('trustedActionWriter',{keyring,now,
  fetchFn:async (url,params)=>{
    posted.push({url,params});
    return {status:200,json:async()=>({workflow_run_id:333,
      run_url:'https://api.github.com/repos/BestNathan/nession/actions/runs/333'})};
  },
});
const receipt=await api200(plan);
assert.deepEqual(receipt,{status:'verified',dispatch_id:item.id,source_run_id:333});
assert.equal(posted[0].params.method,'POST');
assert.equal(JSON.parse(posted[0].params.body).return_run_details,true);
assert.equal(posted[0].params.headers['X-GitHub-Api-Version'],'2026-03-10');
const api204=createGitHubDispatchClient('trustedActionWriter',{keyring,now,
  fetchFn:async()=>({status:204}),
});
assert.deepEqual(await api204(plan),{status:'accepted',dispatch_id:item.id});
await assert.rejects(()=>createGitHubDispatchClient('trustedActionWriter',{keyring,now,
  fetchFn:async()=>({status:200,json:async()=>({workflow_run_id:null})})
})(plan),/verifiable downstream/);
await assert.rejects(()=>api200({...plan,workflow_id:'evil.yml'}),/unapproved/);
await assert.rejects(()=>api200({...plan,ref:'feature'}),/unapproved/);
await assert.rejects(()=>api200({...plan,inputs:{...plan.inputs,input_sha:b}}),
  /signed Outbox ticket/);
await assert.rejects(()=>api200({...plan,inputs:{...plan.inputs,dispatch_ticket:'tampered'}}),
  /signed Outbox ticket/);

const issuer={id:222,path:'.github/workflows/acceptance-agent-controller.yml',
  name:'Acceptance / Agent Controller',event:'workflow_dispatch',head_branch:'main',
  actor:{login:'BestNathan'},run_attempt:1,
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},head_sha:main};
const devRun={id:333,run_attempt:1,path:'.github/workflows/agent-develop.yml',
  name:'Agent / Development',event:'workflow_dispatch',head_branch:'main',
  head_sha:main,repository:{full_name:'BestNathan/nession'},status:'completed',
  conclusion:'success',created_at:new Date(now+5000).toISOString(),inputs:plan.inputs};
const pr={number:42,state:'open',base:{repo:{full_name:'BestNathan/nession'}},
  head:{repo:{full_name:'BestNathan/nession'},sha:b,ref:'agent/issue-1706-dev-cursor-01'}};
const runs=new Map([[222,issuer],[333,devRun]]);
let prRecord=pr;
const requests=[];
const reader=createGitHubRunReader('fixtureBearer012345',{
  fetchFn:async(url,opts)=>{
    requests.push({url,method:opts.method,authorization:opts.headers.Authorization});
    const m=/\/actions\/runs\/(\d+)$/.exec(url);
    const p=/\/pulls\/(\d+)$/.exec(url);
    const value=m?runs.get(Number(m[1])):p&&Number(p[1])===42?prRecord:null;
    return {ok:Boolean(value),status:value?200:404,json:async()=>structuredClone(value)};
  },
});
const result={kind:'developer',issue,run_id:333,run_attempt:1,target_sha:b,
  outcome:'implementation_ready',task_id:item.id};
const options={state,result,dispatch_ticket:ticket,pr_number:42,
  registry,reader,keyring,now:now+700000,verified_main_sha:main};
const source=await attestAgentOutcome(options);
assert.equal(source.verified,true);
assert.equal(source.input_sha,a);
assert.equal(source.output_sha,b);
assert.equal(requests.length,3);
assert.ok(requests.every(x=>x.method==='GET'&&x.authorization==='Bearer fixtureBearer012345'));
const advanced=acceptTaskResult(state,state.version,result,source,registry);
assert.equal(advanced.phase,'review');
assert.equal(reconcileOutbox(advanced).pending[0].task.role,'reviewer');
assert.throws(()=>acceptTaskResult(advanced,advanced.version,result,source,registry),/not been dispatched/);
async function denyRun(mutate,pattern) {
  const cloned=structuredClone(devRun); mutate(cloned);runs.set(333,cloned);
  await assert.rejects(()=>attestAgentOutcome(options),pattern);
  runs.set(333,devRun);
}
await denyRun(r=>{r.path='malicious.yml'},/provenance/);
await denyRun(r=>{r.event='pull_request_target'},/provenance/);
await denyRun(r=>{r.head_branch='feature'},/provenance/);
await denyRun(r=>{r.head_sha='0'.repeat(40)},/trusted main SHA/);
await denyRun(r=>{r.run_attempt=2},/provenance/);
await denyRun(r=>{r.repository.full_name='other/repo'},/provenance/);
// REST Get Workflow Run does not reliably expose dispatch inputs. The
// authoritative 200 dispatch response binds the Run ID to the Outbox instead.
await denyRun(r=>{r.created_at=new Date(now+900000).toISOString()},/dispatch window/);
await denyRun(r=>{r.created_at='invalid-date'},/dispatch window/);
await denyRun(r=>{r.conclusion='failure'},/provenance/);
runs.set(222,{...issuer,path:'evil.yml'});
await assert.rejects(()=>attestAgentOutcome(options),/issuer/);
runs.set(222,issuer);
prRecord={...pr,head:{...pr.head,sha:'0'.repeat(40)}};
await assert.rejects(()=>attestAgentOutcome(options),/PR head/);
prRecord={...pr,head:{...pr.head,ref:'unapproved/branch'}};
await assert.rejects(()=>attestAgentOutcome(options),/PR head/);
prRecord=pr;
await assert.rejects(()=>attestAgentOutcome({...options,
  result:{...result,next_role:'merge'}}),/completion attestation/);
await assert.rejects(()=>attestAgentOutcome({...options,
  result:{...result,issue:1707}}),/provenance/);
await assert.rejects(()=>attestAgentOutcome({...options,
  verified_main_sha:'0'.repeat(40)}),/issuer/);
await assert.rejects(()=>reader.getRun(999),/GitHub API read failed/);
assert.throws(()=>createGitHubRunReader(''),/missing trusted/);

const reviewAction=reconcileOutbox(advanced).pending[0];
const reviewPlan=planGitHubDispatch(advanced,reviewAction.id,registry,signer);
assert.equal(reviewPlan.workflow_id,'agent-review.yml');
// #2262 SC-02: the reviewer workflow declares only reviewer/action_id, so the
// plan must never send the Developer-only inputs; the ticket stays on the plan.
assert.deepEqual(reviewPlan.inputs,{action_id:reviewAction.id,
  reviewer:'review-cursor-01',dispatch_ticket:reviewPlan.ticket});
assert.doesNotThrow(()=>verifyDispatchTicket(reviewPlan.ticket,keyring,{now}));
assert.match(reviewPlan.ticket,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const reviewPosted=[];
const reviewDispatch=createGitHubDispatchClient('credentialedControllerToken',{
  keyring,now,fetchFn:async(url,params)=>{reviewPosted.push({url,params});return{status:204};},
});
assert.deepEqual(await reviewDispatch(reviewPlan),{status:'accepted',dispatch_id:reviewAction.id});
assert.deepEqual(JSON.parse(reviewPosted[0].params.body).inputs,{action_id:reviewAction.id,
  reviewer:'review-cursor-01',dispatch_ticket:reviewPlan.ticket});
await assert.rejects(()=>reviewDispatch({...reviewPlan,
  inputs:{...reviewPlan.inputs,reviewer:'review-qwen-01'}}),/signed Outbox ticket/);
await assert.rejects(()=>reviewDispatch({...reviewPlan,
  inputs:{...reviewPlan.inputs,issue_number:'1997'}}),/signed Outbox ticket/);
await assert.rejects(()=>reviewDispatch({...reviewPlan,inputs:{
  ...reviewPlan.inputs,dispatch_ticket:'tampered'}}),/signed Outbox ticket/);
const reviewState=recordDispatch(advanced,advanced.version,reviewAction.id,
  {status:'verified',dispatch_id:reviewAction.id,source_run_id:334});
runs.set(334,{...devRun,id:334,path:'.github/workflows/agent-review.yml',
  name:'Agent / Review',inputs:reviewPlan.inputs});
const reviewResult={kind:'reviewer',issue,run_id:334,run_attempt:1,target_sha:b,
  outcome:'approved',task_id:reviewAction.id};
const reviewSource=await attestAgentOutcome({...options,state:reviewState,result:reviewResult,
  dispatch_ticket:reviewPlan.ticket});
assert.equal(acceptTaskResult(reviewState,reviewState.version,reviewResult,reviewSource,registry).phase,'quality');
await assert.rejects(()=>attestAgentOutcome({...options,state:reviewState,
  result:{...reviewResult,target_sha:'c'.repeat(40)},
  dispatch_ticket:reviewPlan.ticket}),/PR head/);
// The real #1997 Publisher PR uses the original branch naming, not the
// newer agent/issue-1997 convention. A precise committed publication is the
// ONLY exception to the normal branch-origin rule.
const originalSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const controlledState={issue:1997,target_sha:originalSha,transitions:[{
  kind:'publisher',run_id:39609600546,target_sha:originalSha,outcome:'published'}]};
const controlledPr={number:2176,head:{ref:'agent/1997/developer-checkpoint-v3',
  sha:originalSha}};
assert.equal(reviewerPublishedPrBinding(controlledState,controlledPr),true);
for(const [otherState,otherPr] of [
  [{...controlledState,issue:1998},controlledPr],
  [controlledState,{...controlledPr,number:2177}],
  [controlledState,{...controlledPr,head:{...controlledPr.head,sha:'f'.repeat(40)}}],
  [controlledState,{...controlledPr,head:{...controlledPr.head,ref:'agent/1997/other'}}],
  [{...controlledState,transitions:[]},controlledPr],
  [{...controlledState,transitions:[{...controlledState.transitions[0],outcome:'other'}]},controlledPr],
])assert.equal(reviewerPublishedPrBinding(otherState,otherPr),false);
const originalReviewAction='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
const historicalReview={schema_version:1,issue:1997,version:19,phase:'review',
  target_sha:originalSha,repair_attempts:0,transitions:[{
    kind:'publisher',run_id:39609600546,attempt:1,
    target_sha:originalSha,outcome:'published'}],
  assignments:{developer:'dev-cursor-01',reviewer:'review-qwen-01',
    acceptor:'accept-cursor-01'},
  outbox:[{id:originalReviewAction,
    task:{type:'dispatch',role:'reviewer',task:'review',sha:originalSha,
      agent_id:'review-qwen-01'},status:'dispatched',attempts:1,
    receipt:{status:'verified',dispatch_id:originalReviewAction,
      source_run_id:39943178597}}],
};
const recoverySigner={key,key_id:'control-v1',issuer_run_id:222,
  now,ttl_ms:600000};
const recoveredPlan=planControlledReviewerRecovery(historicalReview,
  originalReviewAction,registry,recoverySigner);
assert.equal(recoveredPlan.workflow_id,'agent-review.yml');
assert.equal(recoveredPlan.inputs.action_id,originalReviewAction);
assert.equal(recoveredPlan.inputs.reviewer,'review-qwen-01');
const recoveredBody=verifyDispatchTicket(recoveredPlan.ticket,keyring,{now});
assert.equal(recoveredBody.issue,1997);
assert.equal(recoveredBody.state_version,19);
assert.equal(recoveredBody.input_sha,originalSha);
for(const wrong of [
  {...historicalReview,version:20},
  {...historicalReview,target_sha:'e'.repeat(40)},
  {...historicalReview,outbox:historicalReview.outbox.map(x=>({
    ...x,receipt:{...x.receipt,source_run_id:39951010624}}))},
])assert.throws(()=>planControlledReviewerRecovery(wrong,
  originalReviewAction,registry,recoverySigner),
  /controlled Reviewer recovery|no longer recoverable/);
console.log('Agent signed dispatch, GitHub REST attestation and spoof/replay fixtures passed');
