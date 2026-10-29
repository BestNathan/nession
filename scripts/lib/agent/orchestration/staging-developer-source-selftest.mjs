#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyStagingDeveloperSource} from './staging-developer-source.mjs';
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
const sha='b'.repeat(40),target='a'.repeat(40),id=401;
const run={id,run_attempt:1,actor:{login:'BestNathan'},
  path:'.github/workflows/acceptance-staging-developer-admission.yml',
  name:'Acceptance / Staging Developer Admission',
  event:'workflow_dispatch',head_branch:'main',head_sha:sha,
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  status:'completed',conclusion:'success'};
const entry={schema_version:1,kind:'staging_developer_readonly_admission',
  issue:2319,repository:'BestNathan/nession',
  workflow_path:run.path,workflow_name:run.name,
  source_branch:'main',source_sha:sha,
  target_branch:'staging',target_sha:target,
  source_run_id:id,source_run_attempt:1,
  provider_identity:'dev-qwen-01',
  selected_environment:'dev-claude-qwen',
  status:'provenance_validated_only',can_execute_staging_source:false,
  signed_store_dispatch_verified:false,acceptance_result:'Pending'};
const name='staging-development-admission-'+id+'-1';
function input(record=entry){
  const zip=zipOne('staging-developer-admission.json',JSON.stringify(record));
  const artifact={name,id:1001,expired:false,
    workflow_run:{id,head_sha:sha},
    digest:'sha256:'+createHash('sha256').update(zip).digest('hex')};
  return {run,zip,artifacts:{total_count:1,artifacts:[artifact]}};
}
const good=input();
const proof=verifyStagingDeveloperSource(good);
assert.equal(proof.target_sha,target);
assert.equal(proof.verified_proof,'synthetic_worker_canary_only');
assert.equal(proof.source_run_id,id);
for(const patch of [
  {actor:{login:'attacker'}},{event:'pull_request_target'},
  {head_branch:'staging'},{run_attempt:2},{conclusion:'failure'},
  {path:'.github/workflows/agent-develop.yml'},
  {head_repository:{full_name:'fork/repo'}},
]){
  assert.throws(()=>verifyStagingDeveloperSource({...good,run:{...run,...patch}}),
    /untrusted or incomplete/);
}
for(const patch of [
  {target_sha:'c'.repeat(40)},
  {provider_identity:'dev-cursor-01'},
  {signed_store_dispatch_verified:true},
  {can_execute_staging_source:true},
  {acceptance_result:'Pass'},
  {selected_environment:'dev-claude-qwen-staging'},
]){
  const bad=input({...entry,...patch});
  if(patch.target_sha&&patch.target_sha.length===40){
    // A distinct valid SHA is allowed, because it was independently
    // authenticated at upstream Admission. Stale-run confusion is denied
    // by the upstream exact-ref check, not by assuming a current tip here.
    assert.equal(verifyStagingDeveloperSource(bad).target_sha,patch.target_sha);
  }else assert.throws(()=>verifyStagingDeveloperSource(bad),/incompatible/);
}
assert.throws(()=>verifyStagingDeveloperSource({...good,
  zip:Buffer.from(good.zip).fill(0,45,46)}),/digest/);
assert.throws(()=>verifyStagingDeveloperSource({...good,
  artifacts:{total_count:2,artifacts:[good.artifacts.artifacts[0],good.artifacts.artifacts[0]]}}),
  /ambiguous/);
assert.throws(()=>verifyStagingDeveloperSource({...good,
  artifacts:{total_count:1,artifacts:[{...good.artifacts.artifacts[0],expired:true}]}}),
  /ambiguous/);
console.log('Staging Developer source: exact Run/ZIP digest, model env and false-Pass denials pass');
