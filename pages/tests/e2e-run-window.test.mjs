import test from 'node:test';
import assert from 'node:assert/strict';
import {selectScopedE2ERuns,scopedE2EPaths} from '../scripts/e2e-run-window.mjs';
const repo='BestNathan/nession',sha='a'.repeat(40);
const testRun=(id)=>({id,run_attempt:1,head_sha:sha,name:'E2E / Tests',
 path:'.github/workflows/e2e-tests.yml',event:'pull_request',head_branch:'feat/test',
 repository:{full_name:repo},head_repository:{full_name:repo},
 status:'completed',conclusion:'success'});
const ingestRun=(id)=>({...testRun(id),name:'E2E / Test Ingest',
 path:'.github/workflows/e2e-test-ingest.yml',event:'workflow_run',
 head_branch:'main'});
const payload=(tests,ingests)=>[
 {total_count:tests.length,workflow_runs:tests},
 {total_count:ingests.length,workflow_runs:ingests}
];
test('independent scoped workflows survive starvation by other repository workflows',()=>{
 assert.deepEqual(scopedE2EPaths,[
  '.github/workflows/e2e-tests.yml','.github/workflows/e2e-test-ingest.yml']);
 const data=selectScopedE2ERuns(payload([testRun(95)],[ingestRun(111)]));
 assert.deepEqual(data.runs.map(x=>x.id),[111,95]);
 assert.equal(data.truncated,false);
 // The repository mixed first 100 may contain neither relevant Run.
 assert.equal(selectScopedE2ERuns([null,{total_count:1,workflow_runs:[ingestRun(111)]}]),null);
});
test('full 100+100 workflow windows retain the 100th Test/Ingest receipt',()=>{
 const tests=Array.from({length:100},(_,i)=>testRun(5000+i));
 const ingests=Array.from({length:100},(_,i)=>ingestRun(8000+i));
 const result=selectScopedE2ERuns(payload(tests,ingests));
 assert.equal(result.runs.length,200);
 assert.equal(result.truncated,true);
 assert.ok(result.runs.some(x=>x.id===5099));
 assert.ok(result.runs.some(x=>x.id===8099));
 const partial=selectScopedE2ERuns([{total_count:120,workflow_runs:tests},
   {total_count:1,workflow_runs:[ingestRun(9000)]}]);
 assert.equal(partial.truncated,true);
});
test('real E2E workflow includes main push events that never themselves attest PR HEAD',()=>{
 const push={...testRun(96),event:'push',head_branch:'main'};
 const result=selectScopedE2ERuns(payload([testRun(95),push],[ingestRun(111)]));
 assert.equal(result.runs.length,3);
 assert.ok(result.runs.some(x=>x.id===96&&x.event==='push'));
 assert.equal(selectScopedE2ERuns(payload([
   {...testRun(95),event:'workflow_dispatch'}],[ingestRun(111)])),null);
});
test('missing, invalid and duplicated source cannot become trusted evidence',()=>{
 const clean=payload([testRun(95)],[ingestRun(111)]);
 const bads=[
  [null,clean[1]], [clean[0],null],
  [{...clean[0],total_count:0},clean[1]],
  [{...clean[0],workflow_runs:Array(101).fill(testRun(95))},clean[1]],
  payload([testRun(95)],[ingestRun(95)]),
  payload([{...testRun(95),path:'.github/workflows/foreign.yml'}],[ingestRun(111)]),
  payload([{...testRun(95),repository:{full_name:'untrusted/repo'}}],[ingestRun(111)]),
  payload([testRun(95)],[{...ingestRun(111),head_branch:'dev'}]),
  payload([testRun(95)],[{...ingestRun(111),event:'issues'}]),
  payload([testRun(95)],[{...ingestRun(111),run_attempt:0}]),
  payload([testRun(95)],[{...ingestRun(111),head_repository:{full_name:'foreign/fork'}}]),
  payload([testRun(95)],[{...ingestRun(111),conclusion:'unknown'}]),
  payload([testRun(95)],[{...ingestRun(111),head_sha:'refs/heads/main'}]),
 ];
 for(const bad of bads)assert.equal(selectScopedE2ERuns(bad),null);
 assert.equal(selectScopedE2ERuns(clean).runs.length,2);
});
