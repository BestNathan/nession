import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLineage,validateLineageProjection} from '../scripts/lineage.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';
const sha='a'.repeat(40),store='b'.repeat(40),digest='c'.repeat(64),action='d'.repeat(64);
const source={repository:'BestNathan/nession',source_ref_sha:store,producer_run_id:21,
 producer_attempt:2,result_digest:digest,writer_receipt_digest:'e'.repeat(64),
 source_url:'https://github.com/BestNathan/nession/actions/runs/21'};
const edge={issue:6,pr_number:7,pr_head_sha:sha,role:'developer',
 agent_id:'dev-cursor-01',run_id:21,attempt:2,action_id:action,slice_id:null,
 origin:source,verification:'authenticated_at_attestation'};
const fixture=(overrides={})=>({issueNumbers:[6],pulls:[{number:7,head_sha:sha}],
 attested:{status:'verified',source_ref_sha:store,records:[edge]},...overrides});
test('no trusted source is never a verified causal edge',()=>{
 const empty=validateLineageProjection(projectLineage({issueNumbers:[6],pulls:[{number:7,head_sha:sha}]}));
 assert.deepEqual(empty,{schema_version:1,status:'unavailable',edges:[],truncated:false});
 assert.equal(projectLineage(fixture({attested:{status:'unavailable',source_ref_sha:store,records:[edge]}})).status,'unavailable');
 assert.equal(projectLineage(fixture({pulls:[{number:7,head_sha:'f'.repeat(40)}]})).edges.length,0);
 assert.equal(projectLineage(fixture({issueNumbers:[8]})).edges.length,0);
});
test('only exact authenticated attestation-time PR bindings yield a typed edge',()=>{
 const p=validateLineageProjection(projectLineage(fixture()));
 assert.equal(p.status,'verified');assert.equal(p.edges.length,1);
 assert.equal(p.edges[0].pr_number,7);assert.equal(p.edges[0].source_ref_sha,store);
 assert.equal(p.edges[0].slice_id,null);
 assert.equal(p.edges[0].verification,'authenticated_at_attestation');
 assert.ok(!JSON.stringify(p).includes('token'));
});
test('fail closed on foreign, corrupt, conflicting, replay and model-derived linkage',()=>{
 const bad=[
  {...edge,origin:{...source,repository:'other/repo'}},
  {...edge,origin:{...source,source_ref_sha:'f'.repeat(40)}},
  {...edge,origin:{...source,producer_run_id:0}},
  {...edge,origin:{...source,producer_run_id:72,
    source_url:'https://github.com/BestNathan/nession/actions/runs/72'}},
  {...edge,origin:{...source,producer_attempt:1}},
  {...edge,origin:{...source,producer_run_id:21,producer_attempt:3}},
  // The edge cannot silently switch to a different valid run or attempt
  // while preserving a previously plausible source URL.
  {...edge,run_id:72},
  {...edge,attempt:3},
  {...edge,origin:{...source,
    source_url:'https://github.com/BestNathan/nession/actions/runs/72'}},
  {...edge,origin:{...source,
    source_url:'https://github.com/BestNathan/nession/actions/runs/21?revision='+sha}},
  {...edge,origin:{...source,
    source_url:'https://github.com/BestNathan/nession/actions/runs/021'}},

  {...edge,origin:{...source,writer_receipt_digest:'fake'}},
  {...edge,origin:{...source,source_url:'https://evil.com/run'}},
  {...edge,pr_head_sha:'g'.repeat(40)},
  {...edge,pr_number:0},
  {...edge,action_id:'fake'},
  {...edge,attempt:0},
  {...edge,slice_id:'inferred-slice'},
  {...edge,verification:'verified_from_issue_comment'},
  {...edge,raw_prompt:'secret'},
  {...edge,agent_id:null},
 ];
 for(const e of bad)
  assert.equal(projectLineage(fixture({attested:{status:'verified',source_ref_sha:store,records:[e]}})).status,'unavailable');
 const dup=projectLineage(fixture({attested:{status:'verified',source_ref_sha:store,records:[edge,edge]}}));
 assert.equal(dup.edges.length,1);
 const conflict={...edge,role:'reviewer'};
 assert.equal(projectLineage(fixture({attested:{status:'verified',source_ref_sha:store,records:[edge,conflict]}})).status,'unavailable');
 const overflow=projectLineage(fixture({attested:{status:'verified',source_ref_sha:store,records:Array(49).fill(edge)}}));
 assert.equal(overflow.status,'unavailable');
});
test('public projector prevents forged lineage, private spill and missing source confusion',()=>{
 const raw=makeProjection({issues:[{number:6,state:'open',title:'Proof',
 updated_at:'2026-10-18T00:00:00Z'}],
 pulls:[{number:7,state:'open',title:'PR',updated_at:'2026-10-18T00:00:00Z',
 head:{sha,repo:{full_name:'BestNathan/nession'}}}]});
 const p=validateProjection(raw);
 assert.deepEqual(p.work.lineage.edges,[]);
 assert.equal(p.work.lineage.status,'unavailable');
 assert.equal(p.work.acceptance_e2e.status,'unavailable');
 p.work.lineage=projectLineage(fixture());
 assert.equal(p.work.lineage.edges[0].source_url,
   'https://github.com/BestNathan/nession/actions/runs/21');
 // Different well-formed GitHub Run links are not sufficient evidence of
 // this Agent's own Run/Attempt, even when the same repository owns both.
 const swapped=structuredClone(p);
 swapped.work.lineage.edges[0].source_url='https://github.com/BestNathan/nession/actions/runs/72';
 assert.throws(()=>validateProjection(swapped),/invalid public causal edge/);
 const foreign=structuredClone(p);
 foreign.work.lineage.edges[0].source_url='https://github.com/other/repo/actions/runs/21';
 assert.throws(()=>validateProjection(foreign),/invalid public causal edge/);
 const unrelatedAttempt=projectLineage(fixture({attested:{status:'verified',
   source_ref_sha:store,records:[{...edge,origin:{...source,producer_attempt:1}}]}}));
 assert.equal(unrelatedAttempt.status,'unavailable');
 p.work.lineage.edges[0].checkpoint_bytes='secret';
 assert.throws(()=>validateProjection(p),/invalid public causal edge/);
});
