#!/usr/bin/env node
// #3243: one source-attested, main-owned PR CI proof bridge for #2990 SC-04.
// No model verdict, Issue mutation, arbitrary PR selection or PR-head execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO='BestNathan/nession', ISSUE=2990, PR=3241;
const SHA=/^[a-f0-9]{40}$/;
const PREFIX='/repos/'+REPO;
const WORKFLOW={path:'.github/workflows/ci-quality.yml',name:'CI / Quality Gate'};
const REQUIRED_JOBS=new Map([
  ['scope','Classify the exact PR or main-push change'],
  ['tooling-check','Verify repository tooling Gates'],
  ['workflow-check','Validate workflow taxonomy and references'],
  ['rust-check','Verify Rust and Acceptance Gates'],
  ['web-check','Enforce applicable Quality results at the stable check name'],
]);

function fail(reason){throw Error('unverified #2990 CI source: '+reason)}
function unique(array,predicate,label){
  const selected=array.filter(predicate);
  if(selected.length!==1)fail('expected one '+label+', got '+selected.length);
  return selected[0];
}
function validId(n){return Number.isSafeInteger(n)&&n>0}
function assertSource({repo,issue,stage,targetSha}){
  if(repo!==REPO||issue!==ISSUE||stage!=='pre-merge'||!SHA.test(targetSha))
    fail('unsupported Issue/stage/repository/exact target SHA');
}
function runSource(run,sha){
  return run&&run.name===WORKFLOW.name&&
    String(run.path).replace(/@refs\/.*$/,'')===WORKFLOW.path&&
    run.event==='pull_request'&&run.head_sha===sha&&
    run.head_repository?.full_name===REPO&&
    run.pull_requests?.some(p=>p.number===PR);
}
function requiredJob(jobs,name,stepName){
  const job=unique(jobs,j=>j.name===name,name+' job');
  if(!validId(job.id)||job.status!=='completed'||job.conclusion!=='success')fail(name+' job not successfully completed');
  const step=unique(job.steps||[],s=>s.name===stepName,
    name+' required step');
  if(step.status!=='completed'||step.conclusion!=='success')
    fail(name+' required step did not pass');
  return job;
}
function assertGateLog(log){
  if(typeof log!=='string'||log.length>1024*1024)
    fail('tooling Gate log absent or oversized');
  if(!/[✓✔]\s+requirement-acceptance-selftest(?:\s|$)/m.test(log))
    fail('requirement-acceptance-selftest was not observed executing');
  const summaries=[...log.matchAll(/(\d+) gates: (\d+) passed, (\d+) failed, (\d+) errors/g)];
  if(!summaries.some(m=>Number(m[1])>0&&m[1]===m[2]&&m[3]==='0'&&m[4]==='0'))
    fail('missing full successful tooling Gate summary');
}
export async function collectVerifiedIssueLifecycleCi(
  {repo,issue,stage,targetSha},get,getLog){
  assertSource({repo,issue,stage,targetSha});
  const pr=await get(PREFIX+'/pulls/'+PR);
  if(pr?.number!==PR||pr.state!=='open'||pr.draft||
    pr.base?.ref!=='main'||pr.base?.repo?.full_name!==REPO||
    pr.head?.repo?.full_name!==REPO||pr.head?.sha!==targetSha)
    fail('PR #3241 current head/base identity mismatch');
  const list=await get(PREFIX+'/actions/runs?head_sha='+targetSha+
    '&event=pull_request&per_page=100');
  if(!Array.isArray(list?.workflow_runs)||
    !Number.isSafeInteger(list.total_count)||list.total_count>100)
    fail('incomplete GitHub workflow-run discovery');
  const candidates=list.workflow_runs.filter(r=>runSource(r,targetSha))
    .sort((a,b)=>b.id-a.id);
  if(!candidates.length)fail('no authenticated PR Quality source run');
  const run=candidates[0];
  if(!validId(run.id)||!validId(run.run_attempt)||
    run.status!=='completed'||run.conclusion!=='success')
    fail('latest PR Quality source not fully successful');
  const latest=await get(PREFIX+'/actions/runs/'+run.id);
  if(latest?.id!==run.id||latest.run_attempt!==run.run_attempt||
    latest.status!=='completed'||latest.conclusion!=='success'||
    !runSource(latest,targetSha))
    fail('selected run identity changed');
  const found=await get(PREFIX+'/actions/runs/'+run.id+
    '/attempts/'+run.run_attempt+'/jobs?per_page=100');
  if(!Array.isArray(found?.jobs)||found.jobs.length>100||
    (found.total_count!=null&&found.total_count>100))
    fail('incomplete authenticated Quality jobs');
  const jobs=[];
  for(const [name,stepName] of REQUIRED_JOBS){
    const job=requiredJob(found.jobs,name,stepName);
    if(job.run_id!==run.id||job.run_attempt!==run.run_attempt)
      fail('job Run/Attempt identity mismatch: '+name);
    jobs.push({name,id:job.id,conclusion:job.conclusion,required_step:stepName});
  }
  const tooling=jobs.find(j=>j.name==='tooling-check');
  assertGateLog(await getLog(PREFIX+'/actions/jobs/'+tooling.id+'/logs'));
  return {
    schema_version:1,kind:'verified_issue_lifecycle_ci',
    issue:ISSUE,pr:PR,target_sha:targetSha,
    quality:{run_id:run.id,run_attempt:run.run_attempt,
      workflow:WORKFLOW.path,conclusion:'success'},
    jobs,verified_gate:'requirement-acceptance-selftest',
  };
}

async function githubGet(path){
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)fail('GitHub read token unavailable');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Accept:'application/vnd.github+json',
      Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'nession-pr-issue-lifecycle-evidence'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)fail('GitHub source API HTTP '+response.status);
  return response.json();
}
async function githubLog(path){
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)fail('GitHub read token unavailable');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)fail('GitHub job-log HTTP '+response.status);
  const txt=await response.text();
  if(txt.length>1024*1024)fail('oversized job log');
  return txt;
}
async function selfTest(){
  const sha='a'.repeat(40);
  const source={repo:REPO,issue:ISSUE,stage:'pre-merge',targetSha:sha};
  const pr={number:PR,state:'open',draft:false,base:{ref:'main',repo:{full_name:REPO}},
    head:{sha,repo:{full_name:REPO}}};
  const run={id:100,run_attempt:1,name:WORKFLOW.name,path:WORKFLOW.path,
    event:'pull_request',head_sha:sha,head_repository:{full_name:REPO},
    pull_requests:[{number:PR}],status:'completed',conclusion:'success'};
  const jobs=[...REQUIRED_JOBS].map(([name,step],i)=>({
    id:1000+i,run_id:100,run_attempt:1,name,status:'completed',conclusion:'success',
    steps:[{name:step,status:'completed',conclusion:'success'}],
  }));
  const log='✓ requirement-acceptance-selftest\n64 gates: 64 passed, 0 failed, 0 errors';
  const request=async path=>{
    if(path.endsWith('/pulls/'+PR))return pr;
    if(path.includes('/actions/runs?'))return {workflow_runs:[run],total_count:1};
    if(path.endsWith('/actions/runs/100'))return run;
    if(path.endsWith('/attempts/1/jobs?per_page=100'))return {jobs,total_count:jobs.length};
    throw Error('unexpected fixture GitHub path '+path);
  };
  const real=await collectVerifiedIssueLifecycleCi(source,request,async()=>log);
  assert.equal(real.target_sha,sha);
  assert.equal(real.jobs.length,5);
  assert.equal(real.verified_gate,'requirement-acceptance-selftest');
  const variants=[
    [{...source,targetSha:'wrong'},request,async()=>log],
    [source,async p=>p.endsWith('/pulls/'+PR)?{...pr,head:{...pr.head,sha:'b'.repeat(40)}}:request(p),async()=>log],
    [source,async p=>p.includes('/actions/runs?')?{workflow_runs:[{...run,conclusion:'failure'}],total_count:1}:request(p),async()=>log],
    [source,async p=>p.includes('/actions/runs?')?{workflow_runs:[{...run,path:'.github/workflows/fake.yml'}],total_count:1}:request(p),async()=>log],
    [source,async p=>p.includes('/actions/runs?')?{workflow_runs:[{...run,head_sha:'b'.repeat(40)}],total_count:1}:request(p),async()=>log],
    [source,async p=>p.includes('/attempts/1/jobs?')?{jobs:jobs.filter(j=>j.name!=='tooling-check')}:request(p),async()=>log],
    [source,async p=>p.includes('/attempts/1/jobs?')?{jobs:[...jobs,jobs[0]]}:request(p),async()=>log],
    [source,async p=>p.includes('/attempts/1/jobs?')?{jobs:jobs.map(j=>j.name==='tooling-check'?{...j,conclusion:'skipped'}:j)}:request(p),async()=>log],
    [source,async p=>p.includes('/attempts/1/jobs?')?{jobs:jobs.map(j=>j.name==='tooling-check'?{...j,steps:[{...j.steps[0],conclusion:'failure'}]}:j)}:request(p),async()=>log],
    [source,async p=>p.includes('/attempts/1/jobs?')?{jobs:jobs.map(j=>j.name==='tooling-check'?{...j,steps:[...j.steps,j.steps[0]]}:j)}:request(p),async()=>log],
    [source,request,async()=>log.replace('✓ requirement-acceptance-selftest','- not run')],
    [source,request,async()=>log.replace('64 passed','63 passed')],
  ];
  for(const [s,g,t] of variants){
    await assert.rejects(collectVerifiedIssueLifecycleCi(s,g,t),
      /unverified #2990 CI source/);
  }
  console.log('PR lifecycle CI: positive and twelve fail-closed source/step/Gate fixtures passed');
}
async function main(){
  const cmd=process.argv[2];
  if(cmd==='self-test'){await selfTest();return;}
  if(cmd!=='collect'||!process.argv[3]||!process.argv[4])
    throw Error('usage: acceptance-pr-lifecycle-ci-evidence.mjs self-test|collect WORKSPACE OUT');
  const sha=execFileSync('git',['-C',process.argv[3],'rev-parse','HEAD'],
    {encoding:'utf8'}).trim();
  const verified=await collectVerifiedIssueLifecycleCi({
    repo:process.env.GITHUB_REPOSITORY,issue:Number(process.env.ISSUE_NUMBER),
    stage:process.env.ACCEPTANCE_STAGE,targetSha:sha,
  },githubGet,githubLog);
  fs.writeFileSync(process.argv[4],JSON.stringify({
    schema_version:1,kind:'acceptance_ci_evidence',target_sha:sha,
    verified_issue_lifecycle_ci:verified,
  },null,2)+'\n');
  console.log('Source-authenticated Issue #2990 PR Quality Gate evidence collected');
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  main().catch(err=>{console.error(err.stack||err);process.exitCode=1});
}
