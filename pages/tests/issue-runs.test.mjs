import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadIssueRunObservations} from '../scripts/issue-runs.mjs';
import {makeProjection,validateProjection} from '../scripts/project.mjs';

const sha='a'.repeat(40),now='2026-10-14T12:00:00Z',repo='BestNathan/nession';
const run={
  schema_version:1,kind:'agent_workflow_run',
  identity:{workflow_id:'requirement-acceptance',github_workflow:'Acceptance / Orchestrator',
    github_run_id:95,github_run_attempt:2,repository:repo,event:'pull_request_target',
    unique_run_name:'95-2-issue-6-pre-merge',job:'execute'},
  task:{id:'issue-6-pre-merge',type:'acceptance',issue:6,stage:'pre-merge',target_ref:sha},
  agent:{provider:'cursor',id:'agent-reviewer-01',role:'acceptor',prompt:null},
  execution:{tools:{observed:false,total:null,unique:null,by_name:null}},
  timing:{started_at:now,finished_at:now,agent_duration_ms:null},
  tokens:{total:0},cost:{charged_usd:null},
  result:{status:'completed'},
};
const action={
 id:95,run_attempt:2,name:'Acceptance / Orchestrator',
 path:'.github/workflows/acceptance-orchestrator.yml',
 event:'pull_request_target',head_sha:sha,
 repository:{full_name:repo},head_repository:{full_name:repo},
};
const issues=[{number:6,title:'Source run',state:'open',updated_at:now}];
const shape={meta:{generated_at:now,main_sha:sha,metrics_sha:'b'.repeat(40)},issues};
function project(records,workflowRuns=[action],status='available'){
  return validateProjection(makeProjection({...shape,workflowRuns,
    issueRunSource:{status,records}}));
}
async function testCheckout(fn){
  const root=await mkdtemp(join(tmpdir(),'nession-pages-runs-'));
  try{
    execFileSync('git',['init','-q',root]);
    const dir=join(root,'raw','workflows','requirement-acceptance','2026-10-14');
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,run.identity.unique_run_name+'.json'),JSON.stringify(run));
    const commit=()=>{
      execFileSync('git',['-C',root,'add','-A']);
      execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','fixture']);
      return execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    };
    const head=commit();
    await fn({root,dir,head,commit});
  }finally{await rm(root,{recursive:true,force:true});}
}
test('pinned canonical Git record yields stable issue-scoped source observation',async()=>{
 await testCheckout(async({root,head})=>{
  const res=await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6],maxFiles:20});
  assert.equal(res.status,'available');
  assert.equal(res.records.length,1);
  assert.equal(res.records[0].target_sha,sha);
  assert.equal(res.records[0].tokens_total,0);
  assert.equal(res.records[0].duration_ms,null);
  assert.equal(res.records[0].role,'acceptor');
  const projected=project(res.records);
  const seen=projected.work.issues[0].agent_runs[0];
  assert.equal(seen.verification,'github_run_verified');
  assert.equal(seen.pr_linkage,'unlinked');
  assert.equal(seen.target_sha,sha);
  assert.equal(seen.url,'https://github.com/BestNathan/nession/actions/runs/95');
  assert.equal(project(res.records,[]).work.issues[0].agent_runs[0].verification,'not_independently_verified');
  assert.equal(project(res.records,[{...action,run_attempt:3}]).work.issues[0].agent_runs[0].verification,'not_independently_verified');
  assert.equal(project(res.records,[{...action,head_sha:'f'.repeat(40)}]).work.issues[0].agent_runs[0].verification,'not_independently_verified');
  assert.equal(project(res.records,[{...action,repository:{full_name:'foreign/repo'}}]).work.issues[0].agent_runs[0].verification,'not_independently_verified');
  assert.equal(project(res.records,[{...action,path:'wrong.yml'}]).work.issues[0].agent_runs[0].verification,'not_independently_verified');
 });
});
test('wrong Metrics revision, dirty source and symlinks fail closed',async()=>{
 await testCheckout(async({root,dir,head})=>{
  assert.equal((await loadIssueRunObservations({root,expectedSha:'f'.repeat(40),at:now,issues:[6]})).status,'unavailable');
  const file=join(dir,'95-2-issue-6-pre-merge.json');
  await writeFile(file,JSON.stringify({...run,identity:{...run.identity,repository:'foreign/repo'}}));
  assert.equal((await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6]})).status,'unavailable');
  await symlink(file,join(dir,'forged.json'));
  assert.equal((await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6]})).status,'unavailable');
 });
});
test('conflicting duplicates, bad target SHA and malformed version are never published',async()=>{
 await testCheckout(async({root,dir,commit})=>{
  const conflicting={...run,identity:{...run.identity,unique_run_name:'95-2-issue-6-retry'},
    task:{...run.task,id:'issue-6-retry'}};
  await writeFile(join(dir,conflicting.identity.unique_run_name+'.json'),JSON.stringify(conflicting));
  let head=commit();
  assert.equal((await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6]})).status,'unavailable');
  await rm(join(dir,conflicting.identity.unique_run_name+'.json'));
  await writeFile(join(dir,run.identity.unique_run_name+'.json'),JSON.stringify({...run,task:{...run.task,target_ref:'refs/heads/main'}}));
  head=commit();
  assert.equal((await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6]})).status,'unavailable');
  await writeFile(join(dir,run.identity.unique_run_name+'.json'),JSON.stringify({...run,schema_version:99}));
  head=commit();
  assert.equal((await loadIssueRunObservations({root,expectedSha:head,at:now,issues:[6]})).status,'unavailable');
 });
});
test('record caps distinguish truncated coverage; malicious fields never leave the public allowlist',()=>{
 const rows=Array.from({length:7},(_,i)=>({
   issue:6,run_id:95+i,attempt:1,workflow:'issue-audit',event:'issues',
   target_sha:null,role:null,agent_id:null,provider:null,
   tokens_total:null,duration_ms:null,observed_at:now,
   prompt:'PRIVATE AGENT PROMPT',host:'10.1.2.3',
 }));
 const result=project(rows,null,'truncated');
 assert.equal(result.work.agent_run_source,'truncated');
 assert.equal(result.work.issues[0].agent_runs.length,3);
 assert.equal(result.work.issues[0].agent_runs[0].agent_id,null);
 assert.equal(result.work.issues[0].agent_runs[0].tokens_total,null);
 assert.ok(!JSON.stringify(result).includes('PRIVATE AGENT PROMPT'));
 assert.ok(!JSON.stringify(result).includes('10.1.2.3'));
 assert.equal(project([],null,'unavailable').work.issues[0].agent_runs.length,0);
 const falsified=project(rows,null,'truncated');
 falsified.work.issues[0].agent_runs[0].pr_linkage='verified';
 assert.throws(()=>validateProjection(falsified),/invalid Issue Agent source evidence/);
 falsified.work.issues[0].agent_runs[0].pr_linkage='unlinked';
 falsified.work.issues[0].agent_runs[0].checkpoint_bytes='secret';
 assert.throws(()=>validateProjection(falsified),/disallowed public field/);
});
