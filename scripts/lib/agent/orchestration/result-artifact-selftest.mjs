import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDevelopment,recordDispatch,recordReboundDispatch,acceptTaskResult,
  reconcileOutbox} from './outbox.mjs';
import {issueDispatchTicket,attestSkippedDispatchRebinding} from './github-dispatch.mjs';
import {decodeResultZip,parseAgentResult,createGitHubResultArtifactReader,
  ingestAgentResult,appendAuthenticatedResult,validateAuthenticatedAgentReceipt,
  assertMetricsAgreement} from './result-artifact.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
function crc32(data){
  let c=0xffffffff;
  for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return(c^0xffffffff)>>>0;
}
// Construct a small ordinary single-file ZIP without trusting zip/unzip binaries.
function zipFixture(input,{name='agent-result.json',method=8,mode=0o100644,
  dataDescriptor=false}={}) {
  const raw=Buffer.isBuffer(input)?input:Buffer.from(JSON.stringify(input));
  const payload=method===8?deflateRawSync(raw):raw;
  const fname=Buffer.from(name), flags=dataDescriptor?8:0,crc=crc32(raw);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);
  if(!dataDescriptor){local.writeUInt32LE(crc,14);
    local.writeUInt32LE(payload.length,18);local.writeUInt32LE(raw.length,22);}
  local.writeUInt16LE(fname.length,26);
  const descriptor=dataDescriptor?Buffer.alloc(16):Buffer.alloc(0);
  if(dataDescriptor){descriptor.writeUInt32LE(0x08074b50,0);
    descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(payload.length,8);
    descriptor.writeUInt32LE(raw.length,12);}
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE((3<<8)|20,4);central.writeUInt16LE(20,6);
  central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);
  central.writeUInt32LE(raw.length,24);central.writeUInt16LE(fname.length,28);
  central.writeUInt32LE((mode<<16)>>>0,38);
  const index=Buffer.concat([central,fname]);
  const start=Buffer.concat([local,fname,payload,descriptor]);
  const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(1,8);eocd.writeUInt16LE(1,10);
  eocd.writeUInt32LE(index.length,12);eocd.writeUInt32LE(start.length,16);
  return Buffer.concat([start,index,eocd]);
}
const repo='BestNathan/nession', issue=1709,now=Date.parse('2026-10-13T08:00:00Z');
const main='a'.repeat(40),inputSha='b'.repeat(40),outputSha='c'.repeat(40);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const request={issue,sha:inputSha,developer:'dev-cursor-01',
  reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const authority={repository:repo,event:'workflow_dispatch',permission:'write',
  ref:'refs/heads/main',run_id:222};
let state=startDevelopment(registry,request,authority);
const action=reconcileOutbox(state).pending[0];
const key=Buffer.alloc(32,0x76),keyring={'key-v1':key};
const {ticket}=issueDispatchTicket(state,action.id,registry,{
  key,key_id:'key-v1',issuer_run_id:222,now,ttl_ms:600000});
state=recordDispatch(state,state.version,action.id,{
  status:'verified',dispatch_id:action.id,source_run_id:333});
const result={kind:'developer',issue,run_id:333,run_attempt:1,
  target_sha:outputSha,outcome:'implementation_ready',task_id:action.id};
const zip=zipFixture(result,{dataDescriptor:true});
assert.deepEqual(parseAgentResult(decodeResultZip(zip)),result);
assert.deepEqual(parseAgentResult(decodeResultZip(zipFixture(result,{method:0}))),result);
assert.throws(()=>parseAgentResult(Buffer.from(JSON.stringify({...result,next_role:'merge'}))),/privilege-bearing/);
assert.throws(()=>parseAgentResult(Buffer.from(JSON.stringify({...result,acceptance_result:'Pass'}))),/privilege-bearing/);
assert.throws(()=>parseAgentResult(Buffer.from(JSON.stringify({...result,session_id:'secret'}))),/privilege-bearing/);
assert.throws(()=>decodeResultZip(zipFixture(result,{name:'../agent-result.json'})),/member path/);
assert.throws(()=>decodeResultZip(zipFixture(result,{name:'secrets.txt'})),/member path/);
assert.throws(()=>decodeResultZip(zipFixture(result,{mode:0o120777})),/symlink/);
assert.throws(()=>decodeResultZip(zipFixture(result,{method:12})),/unsupported/);
assert.throws(()=>decodeResultZip(Buffer.concat([zip,Buffer.from('junk')])),/end-of-central/);
assert.throws(()=>decodeResultZip(Buffer.concat([zip,zip])),/end-of-central|central directory bounds/);
const malformed=Buffer.from(zip); malformed[35]^=1;
assert.throws(()=>decodeResultZip(malformed),/mismatch|CRC|invalid|length/);
const corruptIndex=Buffer.from(zip);corruptIndex.writeUInt32LE(0xffffffff,corruptIndex.length-22+16);
assert.throws(()=>decodeResultZip(corruptIndex),/central directory bounds|out of range/);
const incorrectCRC=Buffer.from(zip);
const cd=incorrectCRC.readUInt32LE(incorrectCRC.length-6);
incorrectCRC.writeUInt32LE(0,cd+16);
assert.throws(()=>decodeResultZip(incorrectCRC),/descriptor mismatch|CRC/);
assert.throws(()=>decodeResultZip(Buffer.alloc(256*1024+1)),/archive size/);
const issuer={id:222,path:'.github/workflows/acceptance-agent-controller.yml',
  name:'Acceptance / Agent Controller',event:'workflow_dispatch',head_branch:'main',
  actor:{login:'BestNathan'},run_attempt:1,head_repository:{full_name:repo},
  head_sha:main,repository:{full_name:repo}};
const worker={id:333,run_attempt:1,
  path:'.github/workflows/agent-develop.yml',name:'Agent / Development',
  event:'workflow_dispatch',head_branch:'main',head_sha:main,
  repository:{full_name:repo},status:'completed',conclusion:'success',
  created_at:new Date(now+5000).toISOString(),
  run_started_at:new Date(now+1000).toISOString(),
  updated_at:new Date(now+10000).toISOString()};
const pr={number:43,state:'open',base:{repo:{full_name:repo}},
  head:{repo:{full_name:repo},sha:outputSha,ref:'agent/issue-1709-dev-cursor-01'}};
const runs=new Map([[222,issuer],[333,worker]]);
let prRecord=pr;
const reader={getRun:async id=>structuredClone(runs.get(id)),
  getPullRequest:async id=>id===43?structuredClone(prRecord):null};
const item={id:999,name:'agent-result-333-1-'+action.id,digest:'sha256:'+sha(zip),
  expired:false,size_in_bytes:zip.length,
  created_at:new Date(now+5000).toISOString(),
  workflow_run:{id:333,head_sha:main}};
let artifact=structuredClone(item), archive=zip, extra=[];
const artifactReader={
  listRunArtifacts:async()=>({total_count:1+extra.length,
    artifacts:[artifact,...extra]}),
  downloadZip:async()=>archive,
};
// The canonical Metrics record is an independent witness of the same Run.
const metrics={schema_version:1,kind:'agent_workflow_run',
  identity:{workflow_id:'agent-develop',github_workflow:'Agent / Development',
    github_run_id:333,github_run_attempt:1,repository:repo},
  task:{type:'development',issue,action_id:action.id,target_ref:outputSha},
  agent:{provider:'cursor',id:'dev-cursor-01',role:'developer',
    model:{id:'composer-2.5'},status:'finished'},
  result:{status:'native-checkpoint-proposed'}};
const options={state,action_id:action.id,reader,artifactReader,registry,keyring,
  dispatch_ticket:ticket,pr_number:43,verified_main_sha:main,metrics,
  now:now+30000};
const evidence=await ingestAgentResult(options);
assert.equal(evidence.kind,'authenticated_agent_task_result');
assert.equal(evidence.schema_version,2);
assert.deepEqual(evidence.implementing_pr,{
  repository:repo,number:43,head_sha_at_attestation:outputSha,
  relation:'trusted_pr_head_at_result_attestation'
});
// The model output never contains (or may choose) a trusted PR number.
assert.equal(Object.hasOwn(result,'implementing_pr'),false);
assert.equal(validateAuthenticatedAgentReceipt(evidence),evidence);
const legacy={...evidence,schema_version:1};
delete legacy.implementing_pr;
assert.equal(validateAuthenticatedAgentReceipt(legacy),legacy);
// Reviewer agreement: the artifact outcome, reviewed PR and Metrics record
// must describe one exact Run.
const reviewAction='e'.repeat(64);
const reviewArgs={metrics:{schema_version:1,kind:'agent_workflow_run',
    identity:{workflow_id:'agent-review',github_workflow:'Agent / Review',
      github_run_id:444,github_run_attempt:1,repository:repo},
    task:{type:'review',issue,action_id:reviewAction,target_ref:outputSha,pr:43},
    agent:{provider:'cursor',id:'review-cursor-01',role:'reviewer',
      model:{id:'composer-2.5'},status:'finished'},
    result:{status:'review-approved'}},
  run:{id:444,run_attempt:1},
  pending:{task:{role:'reviewer',agent_id:'review-cursor-01'}},
  result:{kind:'reviewer',outcome:'approved',target_sha:outputSha},
  pr_number:43,registry,action_id:reviewAction,state};
assert.equal(assertMetricsAgreement(reviewArgs).result.status,'review-approved');
const requested={...reviewArgs,
  result:{...reviewArgs.result,outcome:'changes_requested'},
  metrics:{...reviewArgs.metrics,result:{status:'review-changes-requested'}}};
assert.equal(assertMetricsAgreement(requested).result.status,
  'review-changes-requested');
for(const bogus of ['review-changes_requested','review-approved','review-failed']){
  assert.throws(()=>assertMetricsAgreement({...requested,metrics:{
    ...requested.metrics,result:{status:bogus}}}),/reviewed PR\/outcome/);
}

for(const [change,regex] of [
  [{metrics:null},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,identity:{...reviewArgs.metrics.identity,
    github_run_id:445}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,
    action_id:'f'.repeat(64)}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,
    target_ref:'d'.repeat(40)}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,agent:{...reviewArgs.metrics.agent,
    id:'review-qwen-01'}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,agent:{...reviewArgs.metrics.agent,
    status:'error'}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,result:{status:'review-changes_requested'}}},
    /reviewed PR\/outcome/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,pr:44}}},
    /reviewed PR\/outcome/],
]) assert.throws(()=>assertMetricsAgreement({...reviewArgs,...change}),regex);

const negativeReceipts=[
  {...legacy,implementing_pr:evidence.implementing_pr},
  {...evidence,schema_version:1},
  {...evidence,implementing_pr:{...evidence.implementing_pr,number:0}},
  {...evidence,implementing_pr:{...evidence.implementing_pr,repository:'other/repo'}},
  {...evidence,implementing_pr:{...evidence.implementing_pr,head_sha_at_attestation:'d'.repeat(40)}},
  {...evidence,implementing_pr:{...evidence.implementing_pr,relation:'github_cross_reference'}},
  {...evidence,implementing_pr:{...evidence.implementing_pr,slice_id:'forged'}},
  {...evidence,source:{...evidence.source,agent_id:'other-agent'} ,artifact:{...evidence.artifact,source_run_id:0}},
  {...evidence,source:{...evidence.source,output_sha:'d'.repeat(40)}},
  {...evidence,source:{...evidence.source,run_id:999}},
  {...evidence,source:{...evidence.source,verified:false}},
  {...evidence,result:{...evidence.result,run_attempt:2}},
  {...evidence,artifact:{...evidence.artifact,json_sha256:'fake'}},
  {...evidence,checkpoint_bytes:'secret'},
];
for(const bad of negativeReceipts)
  assert.throws(()=>validateAuthenticatedAgentReceipt(bad),/untrusted|invalid authenticated/);
assert.equal(evidence.artifact.digest,'sha256:'+sha(zip));
assert.equal(evidence.artifact.json_sha256,sha(Buffer.from(JSON.stringify(result))));
assert.equal(evidence.acceptance_result,null);
assert.equal(acceptTaskResult(state,state.version,evidence.result,evidence.source,registry).phase,'review');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-artifact-'));
try{
  assert.equal(appendAuthenticatedResult(root,evidence).changed,true);
  // Historical v1 result records remain valid and lack any inferred PR edge.
  assert.equal(validateAuthenticatedAgentReceipt(legacy),legacy);
// Reviewer agreement: the artifact outcome, reviewed PR and Metrics record
// must describe one exact Run.
const reviewAction='e'.repeat(64);
const reviewArgs={metrics:{schema_version:1,kind:'agent_workflow_run',
    identity:{workflow_id:'agent-review',github_workflow:'Agent / Review',
      github_run_id:444,github_run_attempt:1,repository:repo},
    task:{type:'review',issue,action_id:reviewAction,target_ref:outputSha,pr:43},
    agent:{provider:'cursor',id:'review-cursor-01',role:'reviewer',
      model:{id:'composer-2.5'},status:'finished'},
    result:{status:'review-approved'}},
  run:{id:444,run_attempt:1},
  pending:{task:{role:'reviewer',agent_id:'review-cursor-01'}},
  result:{kind:'reviewer',outcome:'approved',target_sha:outputSha},
  pr_number:43,registry,action_id:reviewAction,state};
assert.equal(assertMetricsAgreement(reviewArgs).result.status,'review-approved');
for(const [change,regex] of [
  [{metrics:null},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,identity:{...reviewArgs.metrics.identity,
    github_run_id:445}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,
    action_id:'f'.repeat(64)}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,
    target_ref:'d'.repeat(40)}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,agent:{...reviewArgs.metrics.agent,
    id:'review-qwen-01'}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,agent:{...reviewArgs.metrics.agent,
    status:'error'}}},/Metrics record/],
  [{metrics:{...reviewArgs.metrics,result:{status:'review-changes_requested'}}},
    /reviewed PR\/outcome/],
  [{metrics:{...reviewArgs.metrics,task:{...reviewArgs.metrics.task,pr:44}}},
    /reviewed PR\/outcome/],
]) assert.throws(()=>assertMetricsAgreement({...reviewArgs,...change}),regex);

  assert.equal(appendAuthenticatedResult(root,evidence).changed,false);
  assert.throws(()=>appendAuthenticatedResult(root,{...evidence,artifact:{
    ...evidence.artifact,digest:'sha256:'+'f'.repeat(64)}}),/collision/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
async function denied(change,regex){
  const old={artifact,archive,extra,prRecord};
  change();
  await assert.rejects(()=>ingestAgentResult(options),regex);
  ({artifact,archive,extra,prRecord}=old);
}
await denied(()=>{artifact={...artifact,expired:true}},/metadata/);
await denied(()=>{artifact={...artifact,digest:'sha256:'+'f'.repeat(64)}},/digest mismatch/);
await denied(()=>{archive=zipFixture({...result,target_sha:'d'.repeat(40)})},/digest mismatch/);
await denied(()=>{artifact={...artifact,workflow_run:{...artifact.workflow_run,id:999}}},/metadata/);
await denied(()=>{artifact={...artifact,created_at:new Date(now-90000).toISOString()}},/metadata/);
await denied(()=>{extra=[structuredClone(artifact)]},/duplicate/);
await denied(()=>{artifact={...artifact,name:'another'}},/missing or duplicate/);
await denied(()=>{artifact={...artifact,size_in_bytes:1}},/metadata|digest mismatch/);
await denied(()=>{prRecord={...pr,head:{...pr.head,sha:'d'.repeat(40)}}},/PR head/);
async function denyDocument(doc,regex){
  await denied(()=>{
    archive=zipFixture(doc);
    artifact={...item,size_in_bytes:archive.length,digest:'sha256:'+sha(archive)};
  },regex);
}
await denyDocument({...result,issue:1710},/Artifact not bound/);
await denyDocument({...result,run_attempt:2},/Artifact not bound/);
await denyDocument({...result,task_id:'e'.repeat(64)},/Artifact not bound/);
await denyDocument({...result,kind:'reviewer',outcome:'approved'},/Artifact not bound/);
await denyDocument({...result,target_sha:'d'.repeat(40)},/PR head/);
await denyDocument({...result,raw_prompt:'private'},/privilege-bearing/);
await denyDocument({...result,implementing_pr:43},/privilege-bearing/);
await denied(()=>{prRecord={...pr,base:{repo:{full_name:'other/repo'}}}},/PR head/);
await denied(()=>{prRecord={...pr,head:{...pr.head,repo:{full_name:'other/repo'}}}},/PR head/);
await denied(()=>{prRecord={...pr,head:{...pr.head,ref:'unauthorized/topic'}}},/PR head/);
await denied(()=>{prRecord={...pr,number:44}},/PR head/);
const fetched=[];
const client=createGitHubResultArtifactReader('ghReadOnlyToken1234',{
  fetchFn:async(url,opts)=>{
    fetched.push({url,opts});
    return {ok:true,json:async()=>({total_count:1,artifacts:[item]}),
      arrayBuffer:async()=>zip};
  },
});
assert.equal((await client.listRunArtifacts(333)).artifacts[0].id,999);
assert.deepEqual(await client.downloadZip(999),zip);
const streamed=createGitHubResultArtifactReader('ghReadOnlyToken1234',{
  fetchFn:async()=>({ok:true,body:{
    getReader:()=>({
      index:0,
      async read(){if(this.index++)return{done:true};return{done:false,value:zip};},
      async cancel(){}
    }),
  }}),
});
assert.deepEqual(await streamed.downloadZip(999),zip);
const tooLarge=createGitHubResultArtifactReader('ghReadOnlyToken1234',{
  fetchFn:async()=>({ok:true,headers:{get:()=>String(256*1024+1)}}),
});
await assert.rejects(()=>tooLarge.downloadZip(999),/bounded archive/);
assert.ok(fetched.every(x=>x.opts.method==='GET'));
assert.throws(()=>createGitHubResultArtifactReader(''),/read-only token/);
// The producer workflow must publish exactly the artifact name the trusted
// ingest consumes, bound to the Outbox action ID.
const reviewWorkflow=fs.readFileSync('.github/workflows/agent-review.yml','utf8');
assert.match(reviewWorkflow,
  /name: agent-result-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ inputs\.action_id \}\}/);
assert.match(reviewWorkflow,
  /path: \$\{\{ runner\.temp \}\}\/review-output\/agent-result\.json/);
// A skipped owner-guard Run may be re-bound exactly once to the successful
// replacement, retaining the skipped Run for audit.
// A skipped Reviewer dispatch can be replaced only by a Run that carries
// the same authenticated action claim Artifact, not merely the same main SHA.
const reviewReady=acceptTaskResult(state,state.version,result,evidence.source,registry);
const realReviewAction=reconcileOutbox(reviewReady).pending[0];
assert.equal(realReviewAction.task.role,'reviewer');
const {ticket:reviewTicket}=issueDispatchTicket(reviewReady,realReviewAction.id,registry,{
  key,key_id:'key-v1',issuer_run_id:222,now,ttl_ms:600000});
const skippedState=recordDispatch(reviewReady,reviewReady.version,realReviewAction.id,{
  status:'verified',dispatch_id:realReviewAction.id,source_run_id:334});
const replacementRun={...worker,id:335,
  path:'.github/workflows/agent-review.yml',name:'Agent / Review',
  head_repository:{full_name:repo},actor:{login:'BestNathan'}};
const skippedRun={...replacementRun,id:334,conclusion:'skipped',
  head_sha:'d'.repeat(40),actor:{login:'github-actions[bot]'}};
const rebindRuns=new Map([[222,issuer],[334,skippedRun],[335,replacementRun]]);
const rebindReader={
  getRun:async id=>structuredClone(rebindRuns.get(id)),
  getPullRequest:async id=>id===43?structuredClone(prRecord):null,
};
const realReviewResult={kind:'reviewer',issue,run_id:335,run_attempt:1,
  target_sha:outputSha,outcome:'approved',task_id:realReviewAction.id};
const reviewZip=zipFixture(realReviewResult);
const claim={schema_version:1,kind:'reviewer_dispatch_claim',
  action_id:realReviewAction.id,dispatch_ticket:reviewTicket};
function reviewerArtifacts({claimDoc=claim,runId=335,omitClaim=false,
  duplicateClaim=false,corruptDigest=false}={}) {
  const claimZip=zipFixture(claimDoc,{name:'review-claim.json'});
  const meta=(id,name,bytes)=>({
    id,name,digest:'sha256:'+sha(bytes),expired:false,
    size_in_bytes:bytes.length,created_at:new Date(now+5000).toISOString(),
    workflow_run:{id:runId,head_sha:main},
  });
  const resultArtifact=meta(1001,'agent-result-'+runId+'-1-'+realReviewAction.id,reviewZip);
  const claimArtifact=meta(1002,'review-claim-'+runId+'-1',claimZip);
  if(corruptDigest)claimArtifact.digest='sha256:'+'0'.repeat(64);
  const artifacts=[resultArtifact,
    ...(!omitClaim?[claimArtifact]:[]),
    ...(duplicateClaim?[{...claimArtifact,id:1003}]:[])];
  return {
    listRunArtifacts:async()=>({total_count:artifacts.length,artifacts}),
    downloadZip:async id=>id===1001?reviewZip:claimZip,
  };
}
const claimReader=reviewerArtifacts();
const rebindRequest={state:skippedState,action_id:realReviewAction.id,
  skipped_run_id:334,replacement_run_id:335,reader:rebindReader,
  artifactReader:claimReader,keyring,verified_main_sha:main,now:now+30000};
const attestation=await attestSkippedDispatchRebinding(rebindRequest);
const rebound=recordReboundDispatch(skippedState,skippedState.version,
  realReviewAction.id,attestation);
assert.equal(rebound.version,skippedState.version+1);
assert.deepEqual(rebound.outbox.find(x=>x.id===realReviewAction.id).receipt,{
  status:'verified',dispatch_id:realReviewAction.id,source_run_id:335,
  rebound_from_run_id:334});
assert.equal(recordReboundDispatch(rebound,rebound.version,realReviewAction.id,attestation),
  rebound);
const realReviewMetrics={...reviewArgs.metrics,
  identity:{...reviewArgs.metrics.identity,github_run_id:335},
  task:{...reviewArgs.metrics.task,action_id:realReviewAction.id}};
const ingestedReview=await ingestAgentResult({...options,state:rebound,
  action_id:realReviewAction.id,reader:rebindReader,
  artifactReader:claimReader,dispatch_ticket:reviewTicket,
  metrics:realReviewMetrics});
assert.equal(ingestedReview.result.run_id,335);
assert.equal(acceptTaskResult(rebound,rebound.version,
  ingestedReview.result,ingestedReview.source,registry).phase,'quality');
for(const [overrides,regex] of [
  [{skipped_run_id:335,replacement_run_id:334},/no verified receipt/],
  [{replacement_run_id:334},/invalid skipped dispatch rebinding request/],
  [{replacement_run_id:999},/replacement Run/],
  [{artifactReader:reviewerArtifacts({omitClaim:true})},/missing or duplicate/],
  [{artifactReader:reviewerArtifacts({duplicateClaim:true})},/missing or duplicate/],
  [{artifactReader:reviewerArtifacts({corruptDigest:true})},/claim ZIP digest/],
  [{artifactReader:reviewerArtifacts({claimDoc:{...claim,
      action_id:'f'.repeat(64)}})},/claim is not bound/],
  [{artifactReader:reviewerArtifacts({claimDoc:{...claim,
      dispatch_ticket:ticket}})},/replacement signed claim/],
  [{artifactReader:reviewerArtifacts({claimDoc:{...claim,
      dispatch_ticket:reviewTicket.slice(0,-3)+'aaa'}})},/HMAC|signature|malformed/],
]) await assert.rejects(()=>attestSkippedDispatchRebinding({
  ...rebindRequest,...overrides}),regex);
const notSkipped=new Map(rebindRuns);
notSkipped.set(334,{...skippedRun,conclusion:'success'});
await assert.rejects(()=>attestSkippedDispatchRebinding({...rebindRequest,
  reader:{...rebindReader,getRun:async id=>structuredClone(notSkipped.get(id))}}),
  /skipped Run is not an authenticated skipped dispatch/);
const hostileSkip=new Map(rebindRuns);
hostileSkip.set(334,{...skippedRun,actor:{login:'untrusted'}});
await assert.rejects(()=>attestSkippedDispatchRebinding({...rebindRequest,
  reader:{...rebindReader,getRun:async id=>structuredClone(hostileSkip.get(id))}}),
  /skipped Run is not an authenticated skipped dispatch/);
const wrongMain=new Map(rebindRuns);
wrongMain.set(335,{...replacementRun,head_sha:'d'.repeat(40)});
await assert.rejects(()=>attestSkippedDispatchRebinding({...rebindRequest,
  reader:{...rebindReader,getRun:async id=>structuredClone(wrongMain.get(id))}}),
  /replacement Run/);
const unauthorized=new Map(rebindRuns);
unauthorized.set(335,{...replacementRun,actor:{login:'untrusted'}});
await assert.rejects(()=>attestSkippedDispatchRebinding({...rebindRequest,
  reader:{...rebindReader,getRun:async id=>structuredClone(unauthorized.get(id))}}),
  /authorized Reviewer actor/);
// The formerly accepted unrelated same-workflow/main-SHA Run for another
// signed action must fail before recordReboundDispatch could poison the Store.
const otherRequest={...request,issue:issue+1};
const otherStart=startDevelopment(registry,otherRequest,authority);
const otherDev=reconcileOutbox(otherStart).pending[0];
const otherDispatched=recordDispatch(otherStart,otherStart.version,otherDev.id,{
  status:'verified',dispatch_id:otherDev.id,source_run_id:333});
const otherResult={...result,issue:issue+1,task_id:otherDev.id};
const otherSource={...evidence.source,issue:issue+1,task_id:otherDev.id};
const otherReady=acceptTaskResult(otherDispatched,otherDispatched.version,
  otherResult,otherSource,registry);
const otherAction=reconcileOutbox(otherReady).pending[0];
const {ticket:otherTicket}=issueDispatchTicket(otherReady,otherAction.id,
  registry,{key,key_id:'key-v1',issuer_run_id:222,now,ttl_ms:600000});
const unrelatedRun={...replacementRun,id:336};
const unrelatedRuns=new Map([...rebindRuns,[336,unrelatedRun]]);
await assert.rejects(()=>attestSkippedDispatchRebinding({
  ...rebindRequest,replacement_run_id:336,
  reader:{...rebindReader,getRun:async id=>structuredClone(unrelatedRuns.get(id))},
  artifactReader:reviewerArtifacts({runId:336,claimDoc:{
    ...claim,action_id:otherAction.id,dispatch_ticket:otherTicket}}),
}),/claim is not bound/);
assert.throws(()=>recordReboundDispatch(skippedState,skippedState.version,
  realReviewAction.id,{...attestation,kind:'other'}),/invalid skipped dispatch rebinding/);
assert.throws(()=>recordReboundDispatch(rebound,rebound.version,
  realReviewAction.id,{...attestation,replacement_run_id:337,build:true}),
  /invalid skipped dispatch rebinding/);
assert.throws(()=>recordReboundDispatch(rebound,rebound.version,
  realReviewAction.id,{...attestation,replacement_run_id:337}),
  /does not point at the skipped Run/);
assert.throws(()=>recordReboundDispatch(skippedState,skippedState.version,
  realReviewAction.id,{...attestation,role:'developer'}),/rebinding action/);
console.log('Agent Artifact Ingest verified single-file ZIP, GitHub digest, run/Issue binding and replay fixtures passed');
