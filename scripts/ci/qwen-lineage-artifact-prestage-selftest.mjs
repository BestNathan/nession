#!/usr/bin/env node
// The main-only transport is untrusted to the Case; it proves ZIP provenance
// separately, with no Store writer credentials or Acceptance authority.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {preStagedOriginalZip}=require('../../e2e/acceptance/shared/qwen-live-source.cjs');
import {selectQwenSource,selectOriginalArtifact,stageQwenArtifactBytes}
  from './qwen-lineage-artifact-prestage.mjs';
const h=(b,alg='sha256')=>createHash(alg).update(b).digest('hex');
const blobHash=b=>h(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b]),'sha1');
const REPO='BestNathan/nession',action='a'.repeat(64),issue=3001;
const run=42488022265,publisher=42489149837,store='b'.repeat(40);
const file='workflows/issues/'+issue+'/producer-results-v2/'+run+'-1-'+action+'.json';
const intentFile='workflows/issues/'+issue+'/results/'+run+'-1-'+action+'.json';
const record=Buffer.from(JSON.stringify({schema_version:2,kind:'authenticated_agent_task_result',
  issue,action_id:action,result:{run_id:run,run_attempt:1,kind:'developer'},
  source:{agent_id:'dev-qwen-01'},implementing_pr:{number:3017}})+'\n');
const intent=Buffer.from(JSON.stringify({schema_version:1,
  kind:'trusted_qwen_publisher_write_ahead_intent',issue,action_id:action,
  worker_run_id:run,worker_run_attempt:1,publisher_run_id:publisher})+'\n');
const entry=(p,b)=>({path:p,sha:blobHash(b),size:b.length,type:'blob',mode:'100644'});
const producer=entry(file,record),intended=entry(intentFile,intent);
const tree={truncated:false,tree:[producer,intended]};
const zipA=Buffer.alloc(60,1),zipB=Buffer.alloc(60,2);
const worker={id:run,run_attempt:1,status:'completed',conclusion:'success',
  name:'Agent / Development',path:'.github/workflows/agent-develop.yml',
  event:'workflow_dispatch',head_sha:'c'.repeat(40),
  repository:{full_name:REPO}};
const writer={...worker,id:publisher,name:'Store / Qwen Publisher',
  path:'.github/workflows/store-qwen-publisher.yml',event:'workflow_run',
  head_sha:'d'.repeat(40)};
const artifact=(run,id,name,bytes)=>({id,name,expired:false,
  digest:'sha256:'+h(bytes),workflow_run:{id:run.id,head_sha:run.head_sha}});
const a=artifact(worker,1,'development-worker-'+run+'-1',zipA);
const b=artifact(writer,2,'qwen-developer-v2-'+publisher+'-1',zipB);
const list=art=>({total_count:1,artifacts:[art]});
const byId=new Map([[1,zipA],[2,zipB]]);
const blobs=new Map([[producer.sha,record],[intended.sha,intent]]);
function fixture({blobMap=blobs,artifactWorker=list(a),artifactWriter=list(b),
  zipMap=byId,sourceTree=tree}={}){
  const getJson=async route=>{
    if(route==='/git/ref/heads/agent-store')return {object:{sha:store}};
    if(route==='/git/trees/'+store+'?recursive=1')return sourceTree;
    const key=route.replace('/git/blobs/','');
    if(route.startsWith('/git/blobs/')){
      const bytes=blobMap.get(key);
      if(!bytes)throw Error('missing original Git blob');
      return {sha:key,size:bytes.length,encoding:'base64',
        content:bytes.toString('base64')};
    }
    if(route==='/actions/runs/'+run)return worker;
    if(route==='/actions/runs/'+publisher)return writer;
    if(route==='/actions/runs/'+run+'/artifacts?per_page=100')return artifactWorker;
    if(route==='/actions/runs/'+publisher+'/artifacts?per_page=100')return artifactWriter;
    throw Error('unexpected source read '+route);
  };
  const fetcher=async url=>{
    const id=Number(url.match(/\/([0-9]+)\/zip$/)?.[1]);
    const bytes=zipMap.get(id);
    if(!bytes)return {ok:false};
    return {ok:true,body:Readable.from([bytes]),headers:{get:()=>String(bytes.length)}};
  };
  return {getJson,fetcher};
}
assert.equal(selectQwenSource(tree).issue,3001);
assert.throws(()=>selectQwenSource({...tree,truncated:true}),/truncated/);

assert.throws(()=>selectOriginalArtifact(list({...a,expired:true}),worker,a.name),/ambiguous/);
assert.throws(()=>selectOriginalArtifact({total_count:2,artifacts:[a,a]},worker,a.name),/ambiguous/);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-source-prestage-test-'));
try{
  const result=await stageQwenArtifactBytes({...fixture(),token:'fixture-token',
    outputDir:path.join(root,'pass')});
  assert.deepEqual(result,{status:'staged',artifact_count:2,
    producer_issue:3001,producer_run:run});
  assert.deepEqual(fs.readFileSync(path.join(root,'pass','1.zip')),zipA);
  assert.deepEqual(fs.readFileSync(path.join(root,'pass','2.zip')),zipB);
  const runnerCache=path.join(root,'qwen-lineage-source');
  fs.mkdirSync(runnerCache);
  fs.copyFileSync(path.join(root,'pass','1.zip'),path.join(runnerCache,'1.zip'));
  assert.deepEqual(preStagedOriginalZip(1,runnerCache,root),zipA);
  assert.throws(()=>preStagedOriginalZip(2,runnerCache,root),/missing or unsafe/);
  assert.throws(()=>preStagedOriginalZip(1,runnerCache,root+'-foreign'),/missing trusted/);
  fs.symlinkSync(path.join(root,'pass','2.zip'),path.join(runnerCache,'2.zip'));
  assert.throws(()=>preStagedOriginalZip(2,runnerCache,root),/missing or unsafe/);
  await assert.rejects(()=>stageQwenArtifactBytes({...fixture(),
    token:'fixture-token',outputDir:path.join(root,'pass')}),/fresh and empty/);
  const badMap=new Map(blobs);badMap.set(producer.sha,Buffer.from('forged'));
  await assert.rejects(()=>stageQwenArtifactBytes({
    ...fixture({blobMap:badMap}),token:'fixture-token',
    outputDir:path.join(root,'bad-blob')}),/checksum mismatch/);
  const wrongZip=new Map(byId);wrongZip.set(2,Buffer.alloc(60,3));
  await assert.rejects(()=>stageQwenArtifactBytes({
    ...fixture({zipMap:wrongZip}),token:'fixture-token',
    outputDir:path.join(root,'bad-artifact')}),/ZIP digest mismatch/);
  const dup=list(a);dup.artifacts.push(a);dup.total_count=2;
  await assert.rejects(()=>stageQwenArtifactBytes({
    ...fixture({artifactWorker:dup}),token:'fixture-token',
    outputDir:path.join(root,'bad-cardinality')}),/ambiguous/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Trusted Qwen pre-stage: original bytes, Git blob checksum, duplicate and tampered Artifact reject fixtures passed');
