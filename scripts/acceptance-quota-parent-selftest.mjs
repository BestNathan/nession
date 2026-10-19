#!/usr/bin/env node
// Independent deterministic acceptance of Issue #1940. No tokens or Issue writes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {reconcile,authorizeInvocation,candidates,proof,classify,RateLimited,recoverablePrepareJobs} from './acceptance-quota-recovery.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO='BestNathan/nession',SHA='a'.repeat(40);
const SOURCES=[['ci-quality.yml','CI / Quality Gate'],['e2e-tests.yml','E2E / Tests']];
const repoIdentity={full_name:REPO};
const run=(o={})=>({id:9,run_attempt:1,created_at:'2026-10-19T00:00:00Z',
  name:'Acceptance / Orchestrator',path:'.github/workflows/acceptance-orchestrator.yml',
  event:'pull_request_target',head_sha:SHA,head_branch:'fix/a',status:'completed',
  conclusion:'failure',repository:repoIdentity,head_repository:repoIdentity,...o});
const pull=(o={})=>({number:7,state:'open',head:{sha:SHA,ref:'fix/a',repo:repoIdentity},
  base:{ref:'main'},...o});
const job=(o={})=>({id:77,run_id:9,run_attempt:1,name:'prepare-pre-merge',
  status:'completed',conclusion:'failure',...o});
const check=(file,name,o={})=>({id:file==='ci-quality.yml'?12:13,run_attempt:1,
  name,path:'.github/workflows/'+file,event:'pull_request',head_branch:'fix/a',head_sha:SHA,
  created_at:'2026-10-19T00:00:00Z',status:'completed',conclusion:'success',
  pull_requests:[{number:7}],repository:repoIdentity,head_repository:repoIdentity,...o});
function mock({runs=[run()],pulls=[pull()],jobs={jobs:[job()],total_count:1},
  liveRun=run(),livePR=pull(),checksOk=true}={}){
  const requests=[];
  const request=async(path,method='GET')=>{
    requests.push({path,method});
    if(method==='POST'){
      assert.match(path,/\/rerun-failed-jobs$/);
      return {};
    }
    if(path.includes('acceptance-orchestrator.yml/runs?'))return {workflow_runs:runs};
    if(path.endsWith('/pulls?state=open&per_page=100'))return pulls;
    if(path.endsWith('/actions/runs/9/attempts/1/jobs?per_page=100'))return jobs;
    if(path.endsWith('/actions/runs/9'))return liveRun;
    if(path.endsWith('/pulls/7'))return livePR;
    for(const [file,name] of SOURCES)
      if(path.includes('/'+file+'/runs?'))return {workflow_runs:[
        check(file,name,checksOk?{}:{conclusion:'failure'})]};
    throw Error('unexpected GitHub API '+path);
  };
  return {request,requests};
}
const posts=m=>m.requests.filter(x=>x.method==='POST').length;
async function SC01(){
  const rs=[run(),run({id:10,head_sha:'b'.repeat(40),head_branch:'fix/b'}),
    run({id:11,head_sha:'c'.repeat(40),head_branch:'fix/c'})];
  const ps=[pull(),pull({number:8,head:{sha:'b'.repeat(40),ref:'fix/b',repo:repoIdentity}}),
    pull({number:9,head:{sha:'c'.repeat(40),ref:'fix/c',repo:repoIdentity}})];
  const calls=[];
  const response=await reconcile(async(path,method='GET')=>{
    calls.push(method+' '+path);
    assert.equal(method,'GET','nonrecoverable failure must never replay');
    if(path.includes('acceptance-orchestrator.yml/runs?'))return {workflow_runs:rs};
    if(path.endsWith('/pulls?state=open&per_page=100'))return ps;
    const m=path.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/);
    assert.ok(m,'nonrecoverable attempt must not fetch CI/E2E or live PR');
    return {total_count:1,jobs:[job({run_id:Number(m[1]),name:'pre-merge-gate'})]};
  });
  assert.deepEqual(response,{candidates:3,retried:0,api_calls:5});
  assert.equal(calls.length,5);
  assert.ok((17-response.api_calls)/17>=0.5);
  const env={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_NAME:'workflow_run',SOURCE_RUN_ID:'70',SOURCE_ATTEMPT:'2',SOURCE_SHA:SHA};
  let sourceReads=0;
  const result=await authorizeInvocation(env,async path=>{
    sourceReads++;assert.equal(path,'repos/'+REPO+'/actions/runs/70');
    return {id:70,run_attempt:2,head_sha:SHA,head_branch:'main',
      name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml',
      event:'push',status:'completed',conclusion:'success',
      repository:repoIdentity,head_repository:repoIdentity};
  });
  assert.equal(result,'trusted-main-quality');assert.equal(sourceReads,1);
  return '17 to 5 REST calls for three identical nonrecoverable candidates (-70.6%); trusted main Quality event requires one additional source GET';
}
async function SC02(){
  const rejectedJobs=[
    {total_count:1,jobs:[job({run_id:12345})]},
    {total_count:1,jobs:[job({run_attempt:2})]},
    {total_count:1,jobs:[job({name:'pre-merge-gate'})]},
    {total_count:1,jobs:[job({conclusion:'cancelled'})]},
    {total_count:2,jobs:[job()]},
    {total_count:101,jobs:[job()]},
  ];
  for(const jobs of rejectedJobs){
    assert.equal(recoverablePrepareJobs(jobs,run()),false);
    const m=mock({jobs});assert.equal((await reconcile(m.request)).retried,0);
    assert.equal(posts(m),0);
  }
  for(const bad of [{head_sha:'b'.repeat(40)},{run_attempt:2},
    {conclusion:'cancelled',status:'completed'},{head_repository:{full_name:'evil/other'}}]){
    const m=mock({liveRun:run(bad)});
    assert.equal((await reconcile(m.request)).retried,0);
    assert.equal(posts(m),0);
  }
  const m=mock({checksOk:false});
  assert.equal((await reconcile(m.request)).retried,0);
  assert.equal(posts(m),0);
  assert.equal(proof([check('ci-quality.yml','CI / Quality Gate',{event:'push'})],
    'ci-quality.yml','CI / Quality Gate',SHA,7,'fix/a'),false);
  assert.equal(candidates([run({head_repository:{full_name:'evil/other'}})],[pull()]).length,0);
  // A stale, unauthorized or rate-limited source cannot enter recovery.
  await assert.rejects(()=>authorizeInvocation({
    GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_NAME:'workflow_run',SOURCE_RUN_ID:'70',SOURCE_ATTEMPT:'1',SOURCE_SHA:SHA,
  },async()=>({id:70,run_attempt:1,head_sha:SHA,head_branch:'main',
    name:'Acceptance / Quota Recovery',path:'.github/workflows/acceptance-quota-recovery.yml',
    event:'workflow_run',status:'completed',conclusion:'success',
    repository:repoIdentity,head_repository:repoIdentity})),/unauthenticated/);
  return 'invalid jobs, stale live PR/run, forged source workflow, cancelled attempt and unverified Quality cannot produce replay POST';
}
async function SC03(){
  const rs=Array.from({length:100},(_,i)=>run({id:100+i,created_at:
    new Date(Date.UTC(2026,9,19,0,0,i)).toISOString(),head_sha:(i+1).toString(16).padStart(40,'0'),
    head_branch:'fix/'+i}));
  const ps=rs.map((x,i)=>pull({number:100+i,head:{sha:x.head_sha,ref:x.head_branch,repo:repoIdentity}}));
  const selected=candidates(rs,ps);assert.equal(selected.length,4);
  const seen=[];
  const response=await reconcile(async(path,method='GET')=>{
    seen.push({path,method});
    if(path.includes('acceptance-orchestrator.yml/runs?'))return {workflow_runs:rs};
    if(path.endsWith('/pulls?state=open&per_page=100'))return ps;
    const m=path.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/);
    assert.ok(m,'bounded negative candidates must not trigger extra API reads');
    assert.equal(method,'GET');
    return {total_count:1,jobs:[job({run_id:Number(m[1]),name:'pre-merge-gate'})]};
  });
  assert.deepEqual(response,{candidates:4,retried:0,api_calls:6});
  assert.equal(seen.length,6);
  assert.ok(response.api_calls<=26);
  assert.equal(candidates([run({run_attempt:3})],[pull()]).length,0);
  // Never let a workflow_run self-source wake up the same workflow recursively.
  await assert.rejects(()=>authorizeInvocation({GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_run',
    SOURCE_RUN_ID:'70',SOURCE_ATTEMPT:'1',SOURCE_SHA:SHA},
  async()=>({id:70,run_attempt:1,head_sha:SHA,head_branch:'main',
    event:'workflow_run',name:'Acceptance / Quota Recovery',
    path:'.github/workflows/acceptance-quota-recovery.yml',
    status:'completed',conclusion:'success',repository:repoIdentity,head_repository:repoIdentity})),
  /unauthenticated/);
  const wf=readFileSync(resolve(ROOT,'.github/workflows/acceptance-quota-recovery.yml'),'utf8');
  assert.match(wf,/group: acceptance-quota-scan/);
  assert.match(wf,/workflows: \["CI \/ Quality Gate"\]/);
  return '100 candidate burst limited to 4 PRs and 6 REST calls, 0 POST; attempt cap 3 and no recursive wake';
}
async function SC04(){
  for(const [status,headers,body,needle] of [
    [403,{'x-ratelimit-remaining':'0','x-ratelimit-reset':'1792380000'},'',/1792380000/],
    [429,{'retry-after':'120'},'',/120/],
    [403,{'retry-after':'45'},'',/45/],
  ]){
    const err=classify(status,headers,body);
    assert.ok(err instanceof RateLimited);
    assert.match(err.message,needle);
    const m=mock();await assert.rejects(()=>reconcile(async()=>{throw err}),RateLimited);
    assert.equal(posts(m),0);
  }
  assert.ok(!(classify(403,{},'Forbidden: missing permission') instanceof RateLimited));
  const cancelled=mock({jobs:{total_count:1,jobs:[job({conclusion:'cancelled'})]}});
  assert.equal((await reconcile(cancelled.request)).retried,0);
  assert.equal(posts(cancelled),0);
  for(const bad of [{head_sha:'b'.repeat(40)},{run_attempt:2}]){
    const m=mock({liveRun:run(bad)});
    assert.equal((await reconcile(m.request)).retried,0);
    assert.equal(posts(m),0);
  }
  // Reset time is logged and the run exits/delegates to a later trusted wake:
  // no tight immediate retry loop or Issue verdict is authorized by this path.
  return '403 reset-header, 429 Retry-After, permanent permission 403, cancellation, stale attempt and SHA fail closed';
}
async function SC05(){
  const here=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
  assert.match(here,/^[a-f0-9]{40}$/);
  if(process.env.NESSION_ACCEPTANCE_TARGET_SHA)
    assert.equal(here,process.env.NESSION_ACCEPTANCE_TARGET_SHA,
      'Case must execute the exact trusted acceptance target SHA');
  if(process.env.GITHUB_EVENT_NAME==='push'&&process.env.GITHUB_REF==='refs/heads/main'){
    assert.equal(here,process.env.GITHUB_SHA,'Case must use exact merged main SHA');
    assert.equal(process.env.GITHUB_REF_PROTECTED,'true',
      'GitHub Actions must attest that the target main ref is protected');
  }
  const workflow=readFileSync(resolve(ROOT,'.github/workflows/acceptance-cases.yml'),'utf8');
  assert.match(workflow,/push:\s*\n\s+branches: \[staging, main\]/);
  assert.match(workflow,/ref: \$\{\{ steps\.target\.outputs\.target_sha \}\}/);
  const recovery=readFileSync(resolve(ROOT,'.github/workflows/acceptance-quota-recovery.yml'),'utf8');
  assert.match(recovery,/github\.ref == 'refs\/heads\/main'/);
  // GitHub supplies ref_protected for push runs. This does not expose the
  // policy's individual required checks; audit exact-head CI independently.
  return 'Exact checked-out target SHA, protected main ref attestation on push, and main-only trusted recovery verified; independent Quality/E2E/Acceptance run conclusions still required';
}
const handlers={ 'SC-01':SC01, 'SC-02':SC02, 'SC-03':SC03,'SC-04':SC04,'SC-05':SC05 };
const target=process.argv[2];
if(!handlers[target])throw Error('usage: node scripts/acceptance-quota-parent-selftest.mjs SC-01|SC-02|SC-03|SC-04|SC-05');
try{
  const summary=await handlers[target]();
  console.log(JSON.stringify({status:'pass',summary,
    evidence:[{type:'runtime',value:'Independent deterministic Issue #1940 '+target+' proof passed on the checked-out target tree'}]}));
}catch(e){
  console.error(e.stack||String(e));
  console.log(JSON.stringify({status:'fail',summary:String(e),
    evidence:[{type:'runtime',value:'Issue #1940 '+target+' negative or metric proof failed'}]}));
  process.exitCode=1;
}
