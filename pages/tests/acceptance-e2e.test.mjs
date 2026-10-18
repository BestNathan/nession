import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadPinnedE2E,validatePublicE2E} from '../scripts/acceptance-e2e.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';
const sha='a'.repeat(40),at='2026-10-18T15:00:00Z',repo='BestNathan/nession';
const artifact='sha256:'+'b'.repeat(64),plan='c'.repeat(64);
const result={
 schema_version:1,kind:'issue_e2e_run',target_sha:sha,run_id:95,run_attempt:2,
 plan_digest:plan,artifact_digest:artifact,
 results:[{id:'pages-overview',result:'Pass',discovered:4,passed:4,failed:0,skipped:0,flaky:0,
 assertions:25},{id:'pages-evidence',result:'Fail',discovered:2,passed:1,failed:1,skipped:0,flaky:0,assertions:6}],
};
const projection={
 schema_version:1,kind:'issue_e2e_projection_receipt',outcome:'applied',
 issue:6,run_id:95,run_attempt:2,target_sha:sha,plan_digest:plan,artifact_digest:artifact,
 ingest_run_id:111,ingest_attempt:1,
 rows:[{id:'pages-overview',result:'Pass',evidence:'run 95/2 source'},
       {id:'pages-evidence',result:'Fail',evidence:'run 95/2 source'}],
 readback_body:'SECRET RAW TEXT NOT PUBLIC',
};
const actions=[
 {id:95,run_attempt:2,head_sha:sha,name:'E2E / Tests',
   path:'.github/workflows/e2e-tests.yml',event:'pull_request',
   repository:{full_name:repo},head_repository:{full_name:repo},
   status:'completed',conclusion:'success'},
 {id:111,run_attempt:1,name:'E2E / Test Ingest',event:'workflow_run',
   path:'.github/workflows/e2e-test-ingest.yml',head_branch:'main',
   repository:{full_name:repo},head_repository:{full_name:repo},
   status:'completed',conclusion:'success'},
];
async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'pages-acceptance-'));
 try{
   execFileSync('git',['init','-q',root]);
   const dir=join(root,'runs','2026-10-18','95-2','test');
   await mkdir(join(dir,'projections'),{recursive:true});
   const record=join(dir,'issue-e2e.json');
   const receipt=join(dir,'projections','6.json');
   await writeFile(record,JSON.stringify(result));
   await writeFile(receipt,JSON.stringify(projection));
   const commit=()=>{
     execFileSync('git',['-C',root,'add','-A']);
     execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','fixture']);
     return execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
   };
   const head=commit();
   await run({root,head,commit,dir,record,receipt});
 }finally{await rm(root,{recursive:true,force:true});}
}
const collect=({root,head,prHeads=[sha],workflowRuns=actions,maxDirs=100})=>
  loadPinnedE2E({root,expectedSha:head,prHeads,workflowRuns,at,maxDirs});
test('pinned selected E2E result must match original exact-SHA Run and trusted Ingest',async()=>{
 await fixture(async x=>{
   const proof=validatePublicE2E(await collect(x));
   assert.equal(proof.status,'available');
   assert.equal(proof.source_sha,x.head);
   assert.equal(proof.records.length,2);
   assert.equal(proof.records[0].id,'pages-evidence');
   assert.equal(proof.records[0].result,'Fail');
   assert.equal(proof.records[1].result,'Pass');
   assert.equal(proof.records[1].url,'https://github.com/BestNathan/nession/actions/runs/95');
   assert.ok(!JSON.stringify(proof).includes('SECRET'));
   const publicPayload=validateProjection(makeProjection({acceptanceE2E:proof,
     meta:{acceptance_results_sha:x.head}}));
   assert.equal(publicPayload.work.acceptance_e2e.records.length,2);
   assert.equal(publicPayload.work.lineage.status,'unavailable');
   const filler=Array.from({length:198},(_,i)=>({
     id:100000+i,run_attempt:1,head_sha:'f'.repeat(40),
     name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml',
     event:'pull_request',repository:{full_name:repo},
     head_repository:{full_name:repo},status:'completed',conclusion:'failure'
   }));
   const fullWindows=await collect({...x,workflowRuns:[...filler,...actions]});
   assert.equal(fullWindows.records.length,2,
     'trusted Test Ingest at offset >100 remains independently checked');
   const cap=await loadPinnedE2E({root:x.root,expectedSha:x.head,
     prHeads:[sha],workflowRuns:[...filler,...actions],at,runWindowTruncated:true});
   assert.equal(cap.status,'truncated');
   assert.equal(cap.records.length,2);
   assert.equal((await loadPinnedE2E({root:x.root,expectedSha:x.head,
     prHeads:[sha],workflowRuns:null,at})).status,'unavailable');
   const noProducer=await collect({...x,workflowRuns:[actions[0]]});
   assert.equal(noProducer.records.length,0); // GitHub E2E alone is not an ingested per-ID receipt.
   const stale=await collect({...x,prHeads:['f'.repeat(40)]});
   assert.equal(stale.records.length,0);
   const wrongAttempt=await collect({...x,workflowRuns:[{...actions[0],run_attempt:1},actions[1]]});
   assert.equal(wrongAttempt.records.length,0);
   const crossRepo=await collect({...x,workflowRuns:[{...actions[0],repository:{full_name:'evil/repo'}},actions[1]]});
   assert.equal(crossRepo.records.length,0);
   const forgedIngest=await collect({...x,workflowRuns:[
      actions[0],{...actions[1],path:'.github/workflows/untrusted.yml'}]});
   assert.equal(forgedIngest.records.length,0);
   const forkIngest=await collect({...x,workflowRuns:[
      actions[0],{...actions[1],head_repository:{full_name:'evil/repo'}}]});
   assert.equal(forkIngest.records.length,0);
 });
});
test('pinned SHA drift, dirty input, unsafe symlink, forged counters and duplicate ID fail closed',async()=>{
 await fixture(async x=>{
   assert.equal((await collect({...x,head:'f'.repeat(40)})).status,'unavailable');
   await writeFile(x.record,JSON.stringify({...result,target_sha:'f'.repeat(40)}));
   assert.equal((await collect(x)).status,'unavailable');
   await writeFile(x.record,JSON.stringify(result));
   await symlink(x.record,join(x.dir,'projections','7.json'));
   assert.equal((await collect(x)).status,'unavailable');
 });
 await fixture(async x=>{
   await writeFile(x.record,JSON.stringify({...result,results:[
     {...result.results[0],passed:0},result.results[1]]}));
   x.head=x.commit();
   assert.equal((await collect(x)).status,'unavailable');
 });
 await fixture(async x=>{
   await writeFile(x.record,JSON.stringify({...result,results:[result.results[0],result.results[0]]}));
   x.head=x.commit();
   assert.equal((await collect(x)).status,'unavailable');
 });
});
test('unknown source, unobserved zero, injected fields and source revision mismatch are distinct',async()=>{
 await fixture(async x=>{
   const limited=await collect({...x,maxDirs:1});
   assert.equal(limited.status,'available');
   const missing=await collect({...x,prHeads:[]});
   assert.equal(missing.status,'available');
   assert.equal(missing.records.length,0);
   const tampered=structuredClone(await collect(x));
   tampered.records[0].raw_prompt='unsafe';
   assert.throws(()=>validatePublicE2E(tampered),/unsafe public/);
   const bound=makeProjection({acceptanceE2E:await collect(x),meta:{
     acceptance_results_sha:'f'.repeat(40)}});
   assert.throws(()=>validateProjection(bound),/E2E source checkout SHA mismatch/);
 });
});
