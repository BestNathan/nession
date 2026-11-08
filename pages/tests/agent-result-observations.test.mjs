import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadPinnedAgentResultObservations,validateAgentResultObservations}
  from '../scripts/agent-result-observations.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';

const repo='BestNathan/nession',store='a'.repeat(40),head='b'.repeat(40),
  action='c'.repeat(64),run=42403363557,attempt=1,issue=2961,pr=2963;
const record={
  schema_version:2,kind:'authenticated_agent_task_result',issue,action_id:action,
  result:{kind:'reviewer',issue,run_id:run,run_attempt:attempt,target_sha:head,
    outcome:'approved',task_id:action},
  source:{repository:repo,path:'.github/workflows/agent-review.yml',name:'Agent / Review',
    run_id:run,attempt,event:'workflow_dispatch',ref:'refs/heads/main',
    issue,task_id:action,agent_id:'review-qwen-01',
    input_sha:head,output_sha:head,verified:true},
  artifact:{id:42,digest:'sha256:'+'d'.repeat(64),
    json_sha256:'e'.repeat(64),source_run_id:run,source_run_attempt:attempt},
  acceptance_result:null,
  implementing_pr:{repository:repo,number:pr,head_sha_at_attestation:head,
    relation:'trusted_pr_head_at_result_attestation'},
};
const path='workflows/issues/'+issue+'/results/'+run+'-'+attempt+'-'+action+'.json';
const blob=doc=>{
  const bytes=Buffer.from(JSON.stringify(doc));
  const sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  return {entry:{type:'blob',mode:'100644',path,sha,size:bytes.length},
    data:{sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')+'\n'}};
};
const api=(doc=record,overrides={})=>{
  const {entry,data}=blob(doc);
  return {ref:{state:'present',sha:store},issueNumbers:[issue],
    getTree:async()=>({tree:[entry],truncated:false}),
    getBlob:async()=>data,
    getCurrentRef:async()=>({state:'present',sha:store}),
    ...overrides};
};
test('pinned Store claims remain explicitly UNVERIFIED, not a verified lineage edge',async()=>{
  const result=await loadPinnedAgentResultObservations(api());
  assert.equal(result.status,'available');
  assert.equal(result.source_ref_sha,store);
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].run_id,run);
  assert.equal(result.records[0].claimed_pr_number,pr);
  assert.equal(result.records[0].verification,'unverified_candidate');
  assert.ok(!JSON.stringify(result).includes('artifact'));
  assert.ok(!JSON.stringify(result).includes('checkpoint'));
  assert.deepEqual(validateAgentResultObservations(result),result);
  const p=validateProjection(makeProjection({
    issues:[{number:issue,title:'Controlled',state:'open',
      updated_at:'2026-11-07T00:00:00Z'}],
    agentResultObservations:result,
    agentStoreSource:{status:'present_unverified',sha:store,
      url:'https://github.com/BestNathan/nession/tree/agent-store'}
  }));
  assert.equal(p.work.lineage.status,'unavailable');
  assert.equal(p.work.lineage.edges.length,0);
  assert.equal(p.work.agent_result_observations.records.length,1);
});
test('unpublished write-ahead intents cannot become public Agent claims',async()=>{
  const result=await loadPinnedAgentResultObservations(api({
    kind:'trusted_qwen_publisher_write_ahead_intent'
  }));
  assert.equal(result.status,'available');
  assert.deepEqual(result.records,[]);
});
test('missing, ambiguous, drifted, unsafe and corrupt source fails closed',async()=>{
  const {entry,data}=blob(record);
  const cases=[
    {ref:{state:'missing'}},
    {getTree:async()=>({tree:[entry],truncated:true})},
    {getTree:async()=>({tree:[{...entry,mode:'120000'}],truncated:false})},
    {getTree:async()=>({tree:[{...entry,size:999999}],truncated:false})},
    {getBlob:async()=>({...data,sha:'f'.repeat(40)})},
    {getBlob:async()=>({...data,content:'not base64!'})},
    {getCurrentRef:async()=>({state:'present',sha:'f'.repeat(40)})},
    {getTree:async()=>({tree:[entry,entry],truncated:false})},
  ];
  for(const override of cases){
    const observed=await loadPinnedAgentResultObservations(api(record,override));
    assert.equal(observed.status,'unavailable');
    assert.deepEqual(observed.records,[]);
  }
  const forged=structuredClone(record);
  forged.source.repository='other/repo';
  assert.equal((await loadPinnedAgentResultObservations(api(forged))).status,'unavailable');
  const unsafe=await loadPinnedAgentResultObservations(api());
  unsafe.records[0].access_token='secret';
  assert.throws(()=>validateAgentResultObservations(unsafe),/unsafe public/);
  const swapped=await loadPinnedAgentResultObservations(api());
  swapped.records[0].source_url='https://github.com/other/repo/actions/runs/'+run;
  assert.throws(()=>validateAgentResultObservations(swapped),/unsafe public/);
  const drift=await loadPinnedAgentResultObservations(api());
  const p=makeProjection({agentResultObservations:drift,
    agentStoreSource:{status:'present_unverified',sha:'f'.repeat(40),
      url:'https://github.com/BestNathan/nession/tree/agent-store'}});
  assert.throws(()=>validateProjection(p),/pinned source/);
});
test('bounded source windows preserve truncation and no zero-for-unavailable',async()=>{
  const {entry}=blob(record);
  const many=Array.from({length:3},(_,i)=>({...entry,path:entry.path.replace(
    '/results/', '/results/') ,sha:entry.sha}));
  // The source cannot emit duplicates even when all files are individually valid.
  assert.equal((await loadPinnedAgentResultObservations(api(record,{
    getTree:async()=>({tree:many,truncated:false})
  }))).status,'unavailable');
  const absent=await loadPinnedAgentResultObservations(api(record,{
    getTree:async()=>({tree:[],truncated:false})
  }));
  assert.equal(absent.status,'available');
  assert.equal(absent.records.length,0);
  assert.equal((await loadPinnedAgentResultObservations(api(record,{
    getTree:async()=>({tree:[],truncated:true})
  }))).status,'unavailable');
});
