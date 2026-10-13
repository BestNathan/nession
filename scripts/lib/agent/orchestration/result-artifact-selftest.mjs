import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDevelopment,recordDispatch,acceptTaskResult,reconcileOutbox} from './outbox.mjs';
import {issueDispatchTicket} from './github-dispatch.mjs';
import {decodeResultZip,parseAgentResult,createGitHubResultArtifactReader,
  ingestAgentResult,appendAuthenticatedResult} from './result-artifact.mjs';

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
const options={state,action_id:action.id,reader,artifactReader,registry,keyring,
  dispatch_ticket:ticket,pr_number:43,verified_main_sha:main,now:now+30000};
const evidence=await ingestAgentResult(options);
assert.equal(evidence.kind,'authenticated_agent_task_result');
assert.equal(evidence.artifact.digest,'sha256:'+sha(zip));
assert.equal(evidence.artifact.json_sha256,sha(Buffer.from(JSON.stringify(result))));
assert.equal(evidence.acceptance_result,null);
assert.equal(acceptTaskResult(state,state.version,evidence.result,evidence.source,registry).phase,'review');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-artifact-'));
try{
  assert.equal(appendAuthenticatedResult(root,evidence).changed,true);
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
console.log('Agent Artifact Ingest verified single-file ZIP, GitHub digest, run/Issue binding and replay fixtures passed');
