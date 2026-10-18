import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {decodeAgentResultCandidate,scanPinnedAgentCandidates,
 authenticatedLineageFromCandidates} from '../scripts/agent-result-candidates.mjs';
import {projectLineage} from '../scripts/lineage.mjs';
const repo='BestNathan/nession',head='a'.repeat(40),
  action='b'.repeat(64),artifactHash='c'.repeat(64),input='d'.repeat(40);
const source={repository:repo,path:'.github/workflows/agent-develop.yml',
 name:'Agent / Development',run_id:72,attempt:2,event:'workflow_dispatch',
 ref:'refs/heads/main',issue:1964,task_id:action,agent_id:'developer-test-01',
 input_sha:input,output_sha:head,verified:true};
const result={
 schema_version:2,kind:'authenticated_agent_task_result',issue:1964,action_id:action,
 result:{kind:'developer',issue:1964,run_id:72,run_attempt:2,target_sha:head,
  outcome:'implementation_ready',task_id:action},
 source,artifact:{id:82,digest:'sha256:'+artifactHash,
  json_sha256:'e'.repeat(64),source_run_id:72,source_run_attempt:2},
 acceptance_result:null,
 implementing_pr:{repository:repo,number:1919,head_sha_at_attestation:head,
  relation:'trusted_pr_head_at_result_attestation'},
};
const filename='72-2-'+action+'.json';
const sha=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const candidate=(r=result)=>decodeAgentResultCandidate(r,1964,filename,'f'.repeat(40),sha(r));
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
async function setup(fn){
 const root=await mkdtemp(join(tmpdir(),'nession-agent-source-'));
 try{
  git(root,'init','-q');
  const folder=join(root,'workflows','issues','1964','results');
  await mkdir(folder,{recursive:true});
  const file=join(folder,filename);
  await writeFile(file,JSON.stringify(result));
  const commit=()=>{
   git(root,'add','-A');
   git(root,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','receipt');
   return git(root,'rev-parse','HEAD');
  };
  let expectedSha=commit();
  await fn({root,folder,file,expectedSha,commit});
 }finally{await rm(root,{force:true,recursive:true});}
}
test('strict v2 and legacy v1 extract only minimal unverified private candidates',()=>{
 const c=candidate();
 assert.equal(c.version,2);
 assert.equal(c.kind,'unverified_result_candidate');
 assert.equal(c.implementing_pr.number,1919);
 assert.equal(c.target_sha,head);
 assert.equal(c.artifact_id,82);
 assert.equal(c.slice_id,undefined);
 assert.ok(!JSON.stringify(c).includes('implementation_ready'));
 assert.ok(!JSON.stringify(c).includes('CURSOR_API_KEY'));
 const v1=structuredClone(result);v1.schema_version=1;delete v1.implementing_pr;
 assert.equal(candidate(v1).version,1);
 assert.equal(candidate(v1).implementing_pr,null);
});
test('arbitrary in-record verified v2 cannot mint public lineage',()=>{
 const c=candidate();
 const possible=authenticatedLineageFromCandidates([c],{status:'verified'});
 assert.equal(possible,null);
 const publicLineage=projectLineage({issueNumbers:[1964],
  pulls:[{number:1919,head_sha:head}],attested:possible});
 assert.equal(publicLineage.status,'unavailable');
 assert.deepEqual(publicLineage.edges,[]);
});
test('Git-committed canonical paths and SHA are required; no private fields exported',async()=>{
 await setup(async ({root,expectedSha})=>{
  const r=await scanPinnedAgentCandidates({root,expectedSha,issues:[1964]});
  assert.equal(r.status,'available');
  assert.equal(r.candidates.length,1);
  assert.equal(r.source_ref_sha,expectedSha);
  assert.equal(r.candidates[0].implementing_pr.number,1919);
  assert.ok(!JSON.stringify(r).includes('private prompt'));
  assert.deepEqual((await scanPinnedAgentCandidates({root,expectedSha,issues:[1965]})).candidates,[]);
  assert.equal((await scanPinnedAgentCandidates({root,expectedSha:'f'.repeat(40),issues:[1964]})).status,'unavailable');
 });
});
test('forged writer/PR metadata, swapped attempts, unsafe fields all fail closed',()=>{
 const bad=[
  {...result,raw_agent_transcript:'private prompt'},
  {...result,source:{...source,repository:'attacker/repo'}},
  {...result,source:{...source,run_id:73}},
  {...result,source:{...source,attempt:1}},
  {...result,source:{...source,verified:false}},
  {...result,result:{...result.result,run_attempt:3}},
  {...result,result:{...result.result,target_sha:input}},
  {...result,action_id:'f'.repeat(64)},
  {...result,artifact:{...result.artifact,source_run_id:73}},
  {...result,artifact:{...result.artifact,digest:'bogus'}},
  {...result,implementing_pr:{...result.implementing_pr,number:0}},
  {...result,implementing_pr:{...result.implementing_pr,repository:'foreign/repo'}},
  {...result,implementing_pr:{...result.implementing_pr,head_sha_at_attestation:input}},
  {...result,implementing_pr:{...result.implementing_pr,slice_id:'forged'}},
  {...result,implementing_pr:{...result.implementing_pr,relation:'timeline_mention'}},
  {...result,schema_version:3},
 ];
 for(const doc of bad)assert.throws(()=>candidate(doc),/unsafe or unauthenticated/);
});
test('dirty checkout, path mismatch, selected-issue symlink, malformed record fail closed',async()=>{
 await setup(async ({root,file,folder,expectedSha})=>{
  await writeFile(file,JSON.stringify({...result,implementing_pr:
   {...result.implementing_pr,number:0}}));
  assert.equal((await scanPinnedAgentCandidates({root,expectedSha,issues:[1964]})).status,'unavailable');
  await writeFile(file,JSON.stringify(result));
  await symlink(file,join(folder,'73-2-'+'f'.repeat(64)+'.json'));
  assert.equal((await scanPinnedAgentCandidates({root,expectedSha,issues:[1964]})).status,'unavailable');
 });
});
test('an actual empty pinned Git orphan is empty, not verified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nession-empty-agent-store-'));
 try{
  git(root,'init','-q');
  git(root,'-c','user.name=Test','-c','user.email=test@example.org',
   'commit','--allow-empty','-qm','bootstrap');
  const expectedSha=git(root,'rev-parse','HEAD');
  const r=await scanPinnedAgentCandidates({root,expectedSha,issues:[1964]});
  assert.equal(r.status,'empty');
  assert.deepEqual(r.candidates,[]);
  assert.equal(r.source_ref_sha,expectedSha);
 }finally{await rm(root,{force:true,recursive:true});}
});
