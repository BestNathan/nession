import test from 'node:test';
import assert from 'node:assert/strict';
import {agentStoreReadiness,validateAgentStoreReadiness} from '../scripts/agent-store-readiness.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';
const a='a'.repeat(40),b='b'.repeat(40),ref={state:'present',sha:a};
const valid={name:'workflows',path:'workflows',type:'dir',sha:b,
  download_url:'https://other.invalid/never-export',secret:'NEVER PUBLIC'};
test('empty is a pinned actual empty ref, not absent, unavailable or authenticated',()=>{
 const empty=agentStoreReadiness(ref,[],ref);
 assert.deepEqual(empty,{status:'empty',sha:a,url:'https://github.com/BestNathan/nession/tree/agent-store'});
 assert.equal(agentStoreReadiness({state:'missing'},[],null).status,'missing');
 assert.equal(agentStoreReadiness(ref,null,ref).status,'unavailable');
 assert.equal(agentStoreReadiness(ref,[],{state:'present',sha:b}).status,'unavailable');
 assert.equal(agentStoreReadiness({state:'present',sha:'invalid'},[],ref).status,'unavailable');
 const p=validateProjection(makeProjection({agentStoreSource:empty}));
 assert.equal(p.work.agent_store_readiness.status,'empty');
 assert.equal(p.work.lineage.status,'unavailable');
 assert.equal(p.work.lineage.edges.length,0);
});
test('candidate tree stays unverified; data URLs and private metadata are never exported',()=>{
 const info=validateAgentStoreReadiness(agentStoreReadiness(ref,[valid],ref));
 assert.equal(info.status,'present_unverified');
 assert.equal(info.sha,a);
 assert.ok(!JSON.stringify(info).includes('NEVER PUBLIC'));
 const p=validateProjection(makeProjection({agentStoreSource:info}));
 assert.equal(p.work.lineage.status,'unavailable');
 assert.equal(p.work.agent_store_readiness.status,'present_unverified');
});
test('unsafe tree, duplicates, unexpected GitHub shapes, SHA drift fail closed',()=>{
 const bad=[
   [{...valid,name:'../workflows'}],
   [{...valid,path:'other'}],
   [{...valid,type:'symlink'}],
   [{...valid,sha:'bogus'}],
   [valid,valid],
   [valid,{...valid,name:'workflows',path:'workflows',sha:a}],
   Array.from({length:31},(_,i)=>({...valid,name:'dir'+i,path:'dir'+i})),
   {},
   'not a tree'
 ];
 for(const entries of bad)assert.equal(agentStoreReadiness(ref,entries,ref).status,'unavailable');
 const malformed=[
   {...agentStoreReadiness(ref,[valid],ref),raw_prompt:'secret'},
   {status:'present_unverified',sha:null,url:'https://github.com/BestNathan/nession/tree/agent-store'},
   {status:'empty',sha:b,url:'https://evil.test'},
   {status:'unavailable',sha:a,url:'https://github.com/BestNathan/nession/tree/agent-store'},
   {status:'verified',sha:a,url:'https://github.com/BestNathan/nession/tree/agent-store'},
 ];
 for(const record of malformed)
   assert.throws(()=>validateAgentStoreReadiness(record),/invalid public Agent Store/);
});
test('unavailable source cannot masquerade as successful Lineage verification',()=>{
 const p=makeProjection({agentStoreSource:agentStoreReadiness(ref,[],ref)});
 p.work.lineage={schema_version:1,status:'verified',truncated:false,edges:[{
   issue:1,pr_number:2,pr_head_sha:a,role:'developer',agent_id:'dev-cursor-01',
   run_id:12,attempt:1,action_id:'c'.repeat(64),slice_id:null,
   verification:'authenticated_at_attestation',source_ref_sha:a,
   source_url:'https://github.com/BestNathan/nession/actions/runs/12'
 }]};
 assert.throws(()=>validateProjection(p),/empty Agent Store cannot/);
});
