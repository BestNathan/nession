#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {buildStagingDeveloperDispatch, verifyStagingDeveloperDispatch,
  verifyStagingDeveloperDispatchArtifact, readStagingDeveloperDispatchArtifact,
  parseStagingDispatchKey} from './staging-developer-dispatch.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const key=Buffer.from('a1'.repeat(32),'hex');
const admission=Object.freeze({
  target_sha:'b'.repeat(40),source_sha:'c'.repeat(40),
  source_run_id:3001,source_run_attempt:1,artifact_id:4001,
  artifact_digest:'sha256:'+'d'.repeat(64),
  verified_proof:'synthetic_worker_canary_only',
});
const signer={key,key_id:'staging-controller-v1',issuer_run_id:5001};
const now=1_700_000_000_000;
const record=buildStagingDeveloperDispatch({admission,registry,signer,now});
const keyring={'staging-controller-v1':key};

assert.equal(record.kind,'staging_developer_dispatch');
assert.equal(record.body.issue,2319);
assert.equal(record.body.target_sha,admission.target_sha);
assert.equal(record.body.environment,'dev-claude-qwen-staging');
assert.equal(record.body.agent_id,'dev-qwen-01');
assert.equal(record.body.provider,'claude-code');
assert.match(record.signature,/^[a-f0-9]{64}$/);
assert.equal(record.body.expires_at-record.body.issued_at,10*60*1000);
const verified=verifyStagingDeveloperDispatch({record,keyring,admission,registry,now:now+1000});
assert.equal(verified.dispatch_id,record.body.dispatch_id);
assert.equal(verified.target_sha,admission.target_sha);

// Rebuilding the same identity is deterministic; changing the signer run or
// TTL changes the signed dispatch id.
assert.deepEqual(buildStagingDeveloperDispatch({admission,registry,signer,now}),record);
assert.notEqual(buildStagingDeveloperDispatch({admission,registry,
  signer:{...signer,issuer_run_id:5002},now}).body.dispatch_id,record.body.dispatch_id);
assert.notEqual(buildStagingDeveloperDispatch({admission,registry,signer,now,
  ttlMs:60_000}).body.dispatch_id,record.body.dispatch_id);

assert.equal(parseStagingDispatchKey('ab'.repeat(32)).length,32);
assert.throws(()=>parseStagingDispatchKey('ab'.repeat(31)),/64 hex/);
assert.throws(()=>parseStagingDispatchKey('zz'.repeat(32)),/64 hex/);
assert.throws(()=>parseStagingDispatchKey(42),/64 hex/);

// Envelope and signature negatives.
assert.throws(()=>verifyStagingDeveloperDispatch({record:{...record,
  signature:'0'.repeat(64)},keyring,admission,registry,now}),/signature/);
assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring:{
  'staging-controller-v1':Buffer.from('a2'.repeat(32),'hex')},admission,registry,now}),
  /signature/);
assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring:{other:key},
  admission,registry,now}),/unknown staging signing key/);
assert.throws(()=>verifyStagingDeveloperDispatch({record:{...record,extra:1},
  keyring,admission,registry,now}),/envelope/);
assert.throws(()=>verifyStagingDeveloperDispatch({record:{...record,
  body:{...record.body,extra:1}},keyring,admission,registry,now}),/body/);
assert.throws(()=>verifyStagingDeveloperDispatch({record:{...record,
  body:{...record.body,dispatch_id:'0'.repeat(64)}},keyring,admission,registry,now}),
  /identity mismatch/);
assert.throws(()=>verifyStagingDeveloperDispatch({record:{...record,
  body:{...record.body,target_sha:'e'.repeat(40)}},keyring,admission,registry,now}),
  /identity mismatch/);

// Time window.
assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring,admission,registry,
  now:record.body.expires_at+1}),/outside validity window/);
assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring,admission,registry,
  now:record.body.issued_at-31_000}),/outside validity window/);

// Admission drift: every signed source field must match.
for(const change of [
  {target_sha:'e'.repeat(40)},
  {source_run_id:3002},
  {source_run_attempt:2},
  {artifact_id:4002},
  {artifact_digest:'sha256:'+'e'.repeat(64)},
]) {
  assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring,
    admission:{...admission,...change},registry,now}),/authenticated admission/);
}
assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring,
  admission:null,registry,now}),/authenticated admission/);

// Registry binding.
for(const mutate of [
  (r)=>{delete r.instances['dev-qwen-01'];},
  (r)=>{r.instances['dev-qwen-01'].role='reviewer';},
  (r)=>{r.instances['dev-qwen-01'].provider='cursor';},
]) {
  const altered=structuredClone(registry);
  mutate(altered);
  assert.throws(()=>verifyStagingDeveloperDispatch({record,keyring,
    admission,registry:altered,now}),/registered Claude Code Developer/);
  assert.throws(()=>buildStagingDeveloperDispatch({admission,registry:altered,
    signer,now}),/registered Claude Code Developer/);
}

// Invalid admission shape or signer/TTL.
assert.throws(()=>buildStagingDeveloperDispatch({admission:{...admission,
  verified_proof:'signed'},registry,signer,now}),/authenticated staging source/);
assert.throws(()=>buildStagingDeveloperDispatch({admission:{...admission,extra:1},
  registry,signer,now}),/authenticated staging source/);
assert.throws(()=>buildStagingDeveloperDispatch({admission,registry,
  signer:{...signer,key:Buffer.alloc(16)},now}),/at least 32 bytes/);
assert.throws(()=>buildStagingDeveloperDispatch({admission,registry,
  signer:{...signer,key_id:'BAD'},now}),/invalid staging dispatch signer/);
assert.throws(()=>buildStagingDeveloperDispatch({admission,registry,signer,now,
  ttlMs:16*60*1000}),/TTL/);

// Full trusted artifact chain: signed dispatch ZIP + independently authenticated
// admission ZIP, as the staging Worker's pre-model job consumes them.
function crc32(bytes){
  let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}
  return(n^0xffffffff)>>>0;
}
function zipOne(name,text){
  const key=Buffer.from(name),bytes=Buffer.from(text),crc=crc32(bytes);
  const local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);
  local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(key.length,26);
  central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
  central.writeUInt32LE(crc,16);
  central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);
  central.writeUInt16LE(key.length,28);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);
  end.writeUInt16LE(1,10);
  end.writeUInt32LE(central.length+key.length,12);
  end.writeUInt32LE(local.length+key.length+bytes.length,16);
  return Buffer.concat([local,key,bytes,central,key,end]);
}
const dispatchSha='f'.repeat(40);
const dispatchRun={id:6001,run_attempt:1,head_sha:dispatchSha,
  path:'.github/workflows/acceptance-staging-developer-admission.yml',
  name:'Acceptance / Staging Developer Admission',
  event:'workflow_dispatch',head_branch:'main',
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  actor:{login:'BestNathan'},status:'completed',conclusion:'success'};
const admissionEntry={schema_version:1,kind:'staging_developer_readonly_admission',
  issue:2319,repository:'BestNathan/nession',
  workflow_path:dispatchRun.path,workflow_name:dispatchRun.name,
  source_branch:'main',source_sha:dispatchSha,
  target_branch:'staging',target_sha:admission.target_sha,
  source_run_id:dispatchRun.id,source_run_attempt:1,
  provider_identity:'dev-qwen-01',
  selected_environment:'dev-claude-qwen-staging',
  status:'provenance_validated_only',can_execute_staging_source:false,
  signed_store_dispatch_verified:false,acceptance_result:'Pending'};
const admissionZip=zipOne('staging-developer-admission.json',
  JSON.stringify(admissionEntry));
const admissionRun=dispatchRun;
const admissionArtifacts={total_count:1,artifacts:[{
  name:'staging-development-admission-'+dispatchRun.id+'-1',id:7001,
  expired:false,workflow_run:{id:dispatchRun.id,head_sha:dispatchSha},
  digest:'sha256:'+createHash('sha256').update(admissionZip).digest('hex')}]};
const dispatchForAdmission=buildStagingDeveloperDispatch({admission:{
  target_sha:admissionEntry.target_sha,source_sha:admissionEntry.source_sha,
  source_run_id:admissionEntry.source_run_id,
  source_run_attempt:admissionEntry.source_run_attempt,
  artifact_id:7001,artifact_digest:admissionArtifacts.artifacts[0].digest,
  verified_proof:'synthetic_worker_canary_only'},registry,signer,now});
const dispatchZip=zipOne('staging-developer-dispatch.json',
  JSON.stringify(dispatchForAdmission));
const dispatchRun2={id:8001,run_attempt:1,head_sha:dispatchSha,
  path:'.github/workflows/acceptance-staging-developer-dispatch.yml',
  name:'Acceptance / Staging Developer Dispatch',
  event:'workflow_run',head_branch:'main',
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  status:'completed',conclusion:'success'};
const dispatchArtifacts={total_count:1,artifacts:[{
  name:'staging-developer-dispatch-8001-1',id:9001,expired:false,
  workflow_run:{id:8001,head_sha:dispatchSha},
  digest:'sha256:'+createHash('sha256').update(dispatchZip).digest('hex')}]};
const chain={dispatchRun:dispatchRun2,dispatchArtifacts,dispatchZip,
  admissionRun,admissionArtifacts,admissionZip,keyring,registry,now};
const read=readStagingDeveloperDispatchArtifact({dispatchRun:dispatchRun2,
  dispatchArtifacts,dispatchZip});
assert.equal(read.record.body.dispatch_id,dispatchForAdmission.body.dispatch_id);
const proved=verifyStagingDeveloperDispatchArtifact(chain);
assert.equal(proved.target_sha,admissionEntry.target_sha);
assert.equal(proved.source_main_sha,admissionEntry.source_sha);
assert.equal(proved.dispatch_id,dispatchForAdmission.body.dispatch_id);
assert.equal(proved.agent_id,'dev-qwen-01');
assert.equal(proved.environment,'dev-claude-qwen-staging');
assert.equal(proved.admission_artifact_id,7001);

for(const patch of [
  {name:'Acceptance / Staging Developer Admission'},
  {path:'.github/workflows/agent-develop.yml'},
  {event:'workflow_dispatch'},{head_branch:'staging'},{run_attempt:2},
  {conclusion:'failure'},{head_repository:{full_name:'fork/repo'}},
]) {
  assert.throws(()=>readStagingDeveloperDispatchArtifact({dispatchRun:
    {...dispatchRun2,...patch},dispatchArtifacts,dispatchZip}),
    /untrusted or incomplete/);
}
assert.throws(()=>readStagingDeveloperDispatchArtifact({dispatchRun:dispatchRun2,
  dispatchArtifacts:{total_count:2,artifacts:[...dispatchArtifacts.artifacts,
    dispatchArtifacts.artifacts[0]]},dispatchZip}),/ambiguous/);
assert.throws(()=>readStagingDeveloperDispatchArtifact({dispatchRun:dispatchRun2,
  dispatchArtifacts,dispatchZip:Buffer.from(dispatchZip).fill(0,45,46)}),/digest/);
assert.throws(()=>verifyStagingDeveloperDispatchArtifact({...chain,
  admissionZip:Buffer.from(admissionZip).fill(0,45,46)}),/digest/);
assert.throws(()=>verifyStagingDeveloperDispatchArtifact({...chain,
  admissionRun:{...admissionRun,id:9999}}),/different admission Run/);
assert.throws(()=>verifyStagingDeveloperDispatchArtifact({...chain,
  keyring:{'staging-controller-v1':Buffer.from('a3'.repeat(32),'hex')}}),
  /signature/);
console.log('Staging Developer dispatch: signed exact admission binding, registry role/provider, time window, artifact chain and tamper/drift negatives passed');
