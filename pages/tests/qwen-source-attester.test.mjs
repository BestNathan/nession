import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attestQwenPublisherSource} from '../scripts/qwen-source-attester.mjs';
import {projectLineage,validateLineageProjection} from '../scripts/lineage.mjs';
import {loadPinnedQwenLineage} from '../scripts/qwen-lineage-reader.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const REPO='BestNathan/nession';
const store='c'.repeat(40),input='a'.repeat(40),head='b'.repeat(40),
  writer='d'.repeat(40),action='e'.repeat(64),issue=2961,prNo=2963,
  workerId=42401513247,publisherId=42402434528;
function zip(files){
 const local=[],central=[];let offset=0;
 for(const [name,text] of files){
  const filename=Buffer.from(name),data=Buffer.from(text);
  const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50,0);
  l.writeUInt16LE(20,4);l.writeUInt32LE(data.length,18);
  l.writeUInt32LE(data.length,22);l.writeUInt16LE(filename.length,26);
  const cent=Buffer.alloc(46);cent.writeUInt32LE(0x02014b50,0);
  cent.writeUInt16LE(20,4);cent.writeUInt16LE(20,6);
  cent.writeUInt32LE(data.length,20);cent.writeUInt32LE(data.length,24);
  cent.writeUInt16LE(filename.length,28);cent.writeUInt32LE(offset,42);
  local.push(l,filename,data);central.push(cent,filename);
  offset+=l.length+filename.length+data.length;
 }
 const dir=Buffer.concat(central),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);
 end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);
 end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,dir,end]);
}
const resultJson='{"outcome":"implementation_ready"}';
const originalZip=zip([['result.json',resultJson],
  ['proof.json','{"metadata":"bounded"}'],
  ['ciphertext.json','{"sealed":"redacted"}']]);
const producerPath='workflows/issues/'+issue+'/producer-results-v2/'+
  workerId+'-1-'+action+'.json';
const record={schema_version:2,kind:'authenticated_agent_task_result',
 issue,action_id:action,
 result:{kind:'developer',issue,run_id:workerId,run_attempt:1,
   target_sha:head,outcome:'implementation_ready',task_id:action},
 source:{repository:REPO,path:'.github/workflows/agent-develop.yml',
   name:'Agent / Development',run_id:workerId,attempt:1,
   event:'workflow_dispatch',ref:'refs/heads/main',
   issue,task_id:action,agent_id:'dev-qwen-01',input_sha:input,
   output_sha:head,verified:true},
 artifact:{id:77,digest:'sha256:'+sha(originalZip),
   json_sha256:sha(Buffer.from(resultJson)),source_run_id:workerId,
   source_run_attempt:1},
 acceptance_result:null,
 implementing_pr:{repository:REPO,number:prNo,head_sha_at_attestation:head,
   relation:'trusted_pr_head_at_result_attestation'},
};
const producerBytes=Buffer.from(JSON.stringify(record)+'\n');
const publisherProof={
 schema_version:1,kind:'trusted_qwen_publisher_handoff',
 issue,action_id:action,developer_run_id:workerId,publisher_run_id:publisherId,
 pull_request:prNo,pr_head_sha:head,reviewer_action_id:17,
 status:'reviewer_pending',store_commit_sha:writer,
 producer_result_path:producerPath,producer_result_sha256:sha(producerBytes),
};
const publisherZip=zip([['qwen-publisher-result.json',
  JSON.stringify(publisherProof)]]);
const workerRun={id:workerId,run_attempt:1,name:'Agent / Development',
 path:'.github/workflows/agent-develop.yml',event:'workflow_dispatch',
 head_branch:'main',head_sha:input,status:'completed',conclusion:'success',
 repository:{full_name:REPO},head_repository:{full_name:REPO}};
const publisherRun={id:publisherId,run_attempt:1,
 name:'Store / Qwen Publisher',path:'.github/workflows/store-qwen-publisher.yml',
 event:'workflow_run',head_branch:'main',head_sha:input,
 status:'completed',conclusion:'success',
 repository:{full_name:REPO},head_repository:{full_name:REPO}};
const artifact=(id,name,bytes,run)=>({id,name,expired:false,
 digest:'sha256:'+sha(bytes),workflow_run:{id:run.id,head_sha:run.head_sha}});
const source=()=>({
 storeSha:store,producerPath,producerBytes,originalStoreBytes:producerBytes,
 intent:{schema_version:1,kind:'trusted_qwen_publisher_write_ahead_intent',
   issue,action_id:action,worker_run_id:workerId,worker_run_attempt:1,
   worker_source_sha:input,publisher_run_id:publisherId,
   source_sha:input,checkpoint_commit_sha:writer},
 workerRun,workerArtifacts:{total_count:1,artifacts:[
   artifact(77,'development-worker-'+workerId+'-1',originalZip,workerRun)]},
 workerZip:originalZip,publisherRun,publisherArtifacts:{
   total_count:1,artifacts:[artifact(78,
     'qwen-developer-v2-'+publisherId+'-1',publisherZip,publisherRun)]},
 publisherZip,pull:{number:prNo,base:{ref:'main',repo:{full_name:REPO}},
   head:{sha:head,repo:{full_name:REPO}}},
 storeAncestry:{merge_base_commit:{sha:writer},status:'ahead'},
});
test('independent original Worker, Artifact, Publisher and Store author proof',()=>{
 const verified=attestQwenPublisherSource(source());
 assert.equal(verified.issue,issue);
 assert.equal(verified.run_id,workerId);
 assert.equal(verified.origin.producer_attempt,1);
 assert.equal(verified.origin.result_digest,sha(producerBytes));
 assert.equal(verified.slice_id,null);
 const projection=validateLineageProjection(projectLineage({
   issueNumbers:[issue],pulls:[{number:prNo,head_sha:head}],
   attested:{status:'verified',source_ref_sha:store,records:[verified]},
 }));
 assert.equal(projection.status,'verified');
 assert.equal(projection.edges.length,1);
 assert.equal(projection.edges[0].slice_id,null);
});
test('self-declared verified and Git tree alone never create an edge',()=>{
 const absent=source();
 absent.publisherArtifacts={total_count:0,artifacts:[]};
 assert.equal(attestQwenPublisherSource(absent),null);
});
test('foreign, stale, colliding, replayed or missing proofs fail closed',()=>{
 const cases=[
  s=>{s.storeSha='0'.repeat(40);s.originalStoreBytes=Buffer.from('other');},
  s=>{s.workerRun={...s.workerRun,run_attempt:2};},
  s=>{s.workerRun={...s.workerRun,repository:{full_name:'evil/repo'}};},
  s=>{s.workerRun={...s.workerRun,head_sha:'f'.repeat(40)};},
  s=>{s.workerZip=Buffer.from('broken');},
  s=>{s.workerArtifacts.artifacts[0].expired=true;},
  s=>{s.workerArtifacts.artifacts.push(s.workerArtifacts.artifacts[0]);
    s.workerArtifacts.total_count=2;},
  s=>{s.publisherRun={...s.publisherRun,
    path:'.github/workflows/evil.yml'};},
  s=>{s.publisherArtifacts.artifacts[0].digest='sha256:'+'f'.repeat(64);},
  s=>{s.publisherZip=Buffer.from('broken');},
  s=>{s.pull.head.sha='f'.repeat(40);},
  s=>{s.pull.head.repo.full_name='evil/repo';},
  s=>{s.storeAncestry.merge_base_commit.sha='f'.repeat(40);},
  s=>{s.producerPath='workflows/issues/2961/../../secrets';},
 ];
 for(const mutate of cases){
   const s=source();mutate(s);
   assert.equal(attestQwenPublisherSource(s),null);
 }
 const forged=structuredClone(record);forged.source.repository='evil/repo';
 const s=source();s.producerBytes=Buffer.from(JSON.stringify(forged));
 s.originalStoreBytes=s.producerBytes;
 assert.equal(attestQwenPublisherSource(s),null);
});

test('trusted-only diagnostics identify a bounded failed proof phase, never raw source',()=>{
 const recorded=[];
 const altered=source();
 altered.workerArtifacts.artifacts[0].digest='sha256:'+'f'.repeat(64);
 const result=attestQwenPublisherSource({
   ...altered,onDiagnostic:stage=>recorded.push(stage)});
 assert.equal(result,null);
 assert.deepEqual(recorded,['worker-zip-bytes']);
 assert.ok(!JSON.stringify(recorded).includes('ciphertext'));
});

test('pinned public reader joins only independently witnessed Qwen source',async()=>{
 const s=source(),bytes=new Map();
 function entry(name,doc){
   const raw=Buffer.from(JSON.stringify(doc)+'\n');
   const h=createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
   const item={path:name,sha:h,mode:'100644',type:'blob',size:raw.length};
   bytes.set(h,{sha:h,size:raw.length,encoding:'base64',
     content:raw.toString('base64')});
   return item;
 }
 const producer=entry(producerPath,record);
 // Existing fixture has JSON with no newline; construct the record's actual
 // pinned bytes using the exact producerBytes to prove sha256 fidelity.
 const b=producerBytes;
 const exactSha=createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
 producer.sha=exactSha;producer.size=b.length;
 bytes.set(exactSha,{sha:exactSha,size:b.length,encoding:'base64',
   content:b.toString('base64')});
 const intentPath='workflows/issues/'+issue+'/results/'+workerId+'-1-'+action+'.json';
 const intent=entry(intentPath,s.intent);
 const base={ref:{state:'present',sha:store},
   issueNumbers:[issue],pulls:[{number:prNo,head_sha:head}],
   getTree:async()=>({tree:[producer,intent],truncated:false}),
   getBlob:async h=>bytes.get(h),
   getOriginalStoreBytes:async()=>producerBytes,
   getRun:async id=>id===workerId?s.workerRun:s.publisherRun,
   getArtifacts:async id=>id===workerId?s.workerArtifacts:s.publisherArtifacts,
   getArtifactZip:async id=>id===77?s.workerZip:s.publisherZip,
   getPull:async()=>s.pull,
   getCompare:async()=>s.storeAncestry,
   getCurrentRef:async()=>({state:'present',sha:store})};
 const verified=await loadPinnedQwenLineage(base);
 assert.equal(verified.status,'verified');
 const diagnostics=[];
 const rejected=await loadPinnedQwenLineage({
   ...base,onDiagnostic:phase=>diagnostics.push(phase),
   getOriginalStoreBytes:async()=>Buffer.from('forged'),
 });
 assert.equal(rejected.status,'unavailable');
 assert.deepEqual(diagnostics,[
   'independent-attestation/producer-json','independent-attestation']);
 assert.equal(verified.records.length,1);
 assert.equal(verified.records[0].run_id,workerId);
 assert.equal(verified.records[0].slice_id,null);
 for(const tamper of [
   {...base,getCurrentRef:async()=>({state:'present',sha:'a'.repeat(40)})},
   {...base,getOriginalStoreBytes:async()=>Buffer.from('forged')},
   {...base,getArtifacts:async id=>id===publisherId?
     {total_count:0,artifacts:[]}:s.workerArtifacts},
   {...base,getPull:async()=>({...s.pull,head:{...s.pull.head,sha:'f'.repeat(40)}})},
   {...base,issueNumbers:[issue,issue]},
   {...base,getTree:async()=>({tree:[producer,intent],truncated:true})},
   {...base,getTree:async()=>({tree:[{...producer,mode:'120000'},intent],
     truncated:false})},
   {...base,getBlob:async id=>id===producer.sha?
     {...bytes.get(id),content:'not base64'}:bytes.get(id)},
   {...base,getCompare:async()=>({merge_base_commit:{sha:'f'.repeat(40)},
     status:'ahead'})},
   {...base,getRun:async id=>id===workerId?
     {...s.workerRun,run_attempt:2}:s.publisherRun},
 ]){
   const result=await loadPinnedQwenLineage(tamper);
   assert.equal(result.status,'unavailable');
   assert.deepEqual(result.records,[]);
 }
});

// Real Qwen Artifacts contain a full encrypted native Session, not a tiny ZIP.
// Its opaque companion may exceed 512 KiB while result.json remains 64 KiB.
// The attester must hash all transport bytes but extract only the bounded
// result member and never export ciphertext into the public Pages projection.
test('original Worker ZIP with >512 KiB encrypted native companion is valid',()=>{
 const encryptedJson='{"ciphertext":"'+'x'.repeat(768*1024)+'"}';
 const largeWorkerZip=zip([
   ['result.json',resultJson],
   ['proof.json','{"metadata":"bounded"}'],
   ['ciphertext.json',encryptedJson],
 ]);
 assert.ok(largeWorkerZip.length>512*1024);
 const alteredRecord={...record,artifact:{...record.artifact,
   digest:'sha256:'+sha(largeWorkerZip)}};
 const largeBytes=Buffer.from(JSON.stringify(alteredRecord)+'\n');
 const largePublisherProof={...publisherProof,
   producer_result_sha256:sha(largeBytes)};
 const largePublisherZip=zip([['qwen-publisher-result.json',
   JSON.stringify(largePublisherProof)]]);
 const state=source();
 state.workerZip=largeWorkerZip;
 state.workerArtifacts.artifacts[0].digest='sha256:'+sha(largeWorkerZip);
 state.producerBytes=largeBytes;
 state.originalStoreBytes=largeBytes;
 state.publisherZip=largePublisherZip;
 state.publisherArtifacts.artifacts[0].digest='sha256:'+sha(largePublisherZip);
 const verified=attestQwenPublisherSource(state);
 assert.equal(verified?.issue,issue);
 assert.equal(verified?.run_id,workerId);
 assert.equal(verified?.origin.result_digest,sha(largeBytes));
 assert.equal(verified?.slice_id,null);
 assert.equal(JSON.stringify(verified).includes('ciphertext'),false);
 // A Publisher Artifact must still observe its separate 512 KiB cap.
 state.publisherZip=zip([['qwen-publisher-result.json',
   JSON.stringify(largePublisherProof)+' '.repeat(600*1024)]]);
 state.publisherArtifacts.artifacts[0].digest='sha256:'+sha(state.publisherZip);
 assert.equal(attestQwenPublisherSource(state),null);
});
