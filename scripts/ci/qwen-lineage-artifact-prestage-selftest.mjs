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
const {preStagedOriginalZip,readPinnedQwenApi}=require('../../e2e/acceptance/shared/qwen-live-source.cjs');
import {selectQwenSource,selectOriginalArtifact,stageQwenArtifactBytes}
  from './qwen-lineage-artifact-prestage.mjs';
const h=(b,alg='sha256')=>createHash(alg).update(b).digest('hex');
const blobHash=b=>h(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b]),'sha1');
const REPO='BestNathan/nession',action='a'.repeat(64),issue=3001;
const run=42488022265,publisher=42489149837,store='b'.repeat(40),
  writerSha='d'.repeat(40),target='f'.repeat(40);
const file='workflows/issues/'+issue+'/producer-results-v2/'+run+'-1-'+action+'.json';
const intentFile='workflows/issues/'+issue+'/results/'+run+'-1-'+action+'.json';
const record=Buffer.from(JSON.stringify({schema_version:2,kind:'authenticated_agent_task_result',
  issue,action_id:action,result:{run_id:run,run_attempt:1,
    kind:'developer',target_sha:target},
  source:{agent_id:'dev-qwen-01'},implementing_pr:{number:3017}})+'\n');
const intent=Buffer.from(JSON.stringify({schema_version:1,
  kind:'trusted_qwen_publisher_write_ahead_intent',issue,action_id:action,
  worker_run_id:run,worker_run_attempt:1,publisher_run_id:publisher})+'\n');
const entry=(p,b)=>({path:p,sha:blobHash(b),size:b.length,type:'blob',mode:'100644'});
const producer=entry(file,record),intended=entry(intentFile,intent);
const tree={truncated:false,tree:[producer,intended]};
// Real one-member ZIP directory structure, with the same bounded Writer
// decoding path the public read-only source attester uses.
function oneMemberZip(name,obj){
  const filename=Buffer.from(name),body=Buffer.from(JSON.stringify(obj));
  const local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);
  local.writeUInt16LE(filename.length,26);
  central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
  central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);
  central.writeUInt16LE(filename.length,28);
  const offset=local.length+filename.length+body.length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);
  end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([local,filename,body,central,filename,end]);
}
const zipA=Buffer.alloc(60,1),
  zipB=oneMemberZip('qwen-publisher-result.json',{store_commit_sha:writerSha});
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
const originalContent=fileName=>({
  sha:blobHash(fileName===file?record:intent),
  size:(fileName===file?record:intent).length,encoding:'base64',
  content:(fileName===file?record:intent).toString('base64')});
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
    if(route==='/pulls/3017')return {number:3017,head:{sha:target}};
    if(route==='/contents/'+file+'?ref='+writerSha)
      return originalContent(file);
    if(route==='/contents/'+file+'?ref='+store)
      return originalContent(file);
    if(route==='/contents/'+intentFile+'?ref='+store)
      return originalContent(intentFile);
    if(route==='/compare/'+writerSha+'...'+store)
      return {status:'ahead',merge_base_commit:{sha:writerSha}};
    if(route==='/actions/runs?head_sha='+target+'&per_page=100')
      return {total_count:0,workflow_runs:[]};
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
  const verifiedDir=path.join(root,'qwen-lineage-source');
  const verified=await stageQwenArtifactBytes({
    ...fixture(),token:'fixture-token',includeApiCache:true,outputDir:verifiedDir,
  });
  assert.deepEqual(verified,{status:'staged',artifact_count:2,
    producer_issue:3001,producer_run:run});
  assert.deepEqual(readPinnedQwenApi('/git/ref/heads/agent-store',
    verifiedDir,root),{object:{sha:store}});
  assert.deepEqual(readPinnedQwenApi('/actions/runs?head_sha='+target+'&per_page=100',
    verifiedDir,root),{total_count:0,workflow_runs:[]});
  assert.throws(()=>readPinnedQwenApi('/unlisted',verifiedDir,root),
    /missing or ambiguous/);
  assert.throws(()=>readPinnedQwenApi('/git/ref/heads/agent-store',
    verifiedDir,root+'-forged'),/missing trusted private/);
  const manifest=JSON.parse(fs.readFileSync(path.join(verifiedDir,'api-manifest.json')));
  assert.ok(manifest.entries.length>=10&&manifest.entries.length<=32);
  assert.ok(!JSON.stringify(manifest).includes('fixture-token'));
  const entry=manifest.entries.find(e=>e.route==='/pulls/3017');
  assert.ok(entry);
  const raw=path.join(verifiedDir,'api',h(Buffer.from(entry.route))+'.json');
  fs.appendFileSync(raw,' ');
  assert.throws(()=>readPinnedQwenApi(entry.route,verifiedDir,root),
    /stale or unsafe|checksum mismatch/);
  const runnerCache=verifiedDir;
  assert.deepEqual(preStagedOriginalZip(1,runnerCache,root),zipA);
  assert.throws(()=>preStagedOriginalZip(3,runnerCache,root),/missing or unsafe/);
  assert.throws(()=>preStagedOriginalZip(1,runnerCache,root+'-foreign'),/missing trusted/);
  fs.symlinkSync(path.join(root,'pass','2.zip'),path.join(runnerCache,'3.zip'));
  assert.throws(()=>preStagedOriginalZip(3,runnerCache,root),/missing or unsafe/);
  await assert.rejects(()=>stageQwenArtifactBytes({...fixture(),
    token:'fixture-token',outputDir:path.join(root,'pass')}),/fresh and empty/);
  const badMap=new Map(blobs);
  const forged=Buffer.from(record);forged[2]^=1;
  badMap.set(producer.sha,forged);
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
