#!/usr/bin/env node
// Trusted main, bounded scheduled replay of stranded Acceptance failed jobs.
import assert from 'node:assert/strict';
const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,MAX=4,MAX_ATTEMPTS=3;
const ACCEPT='.github/workflows/acceptance-orchestrator.yml';
const SOURCES=[['ci-quality.yml','CI / Quality Gate'],['e2e-tests.yml','E2E / Tests']];
function ok(v,m){if(!v)throw Error('acceptance quota recovery: '+m)}
function id(v){return Number.isSafeInteger(v)&&v>0}
function source(r){return r&&id(r.id)&&id(r.run_attempt)&&SHA.test(r.head_sha??'')&&
  r.event==='pull_request_target'&&r.path===ACCEPT&&r.name==='Acceptance / Orchestrator'&&
  r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO}
export class RateLimited extends Error{}
export function classify(status,h={},body=''){
  if(status===429||(status===403&&(h['x-ratelimit-remaining']==='0'||
    h['retry-after']||/rate limit/i.test(body))))
    return new RateLimited('HTTP '+status+' quota; reset '+(h['x-ratelimit-reset']||'unknown')+
      ', retry-after '+(h['retry-after']||'next schedule'));
  return Error('GitHub API HTTP '+status+' '+String(body).slice(0,200));
}
export function candidates(runs,pulls){
  ok(Array.isArray(runs)&&runs.length<=100,'unbounded runs');
  ok(Array.isArray(pulls)&&pulls.length<=100,'unbounded pulls');
  const latest=new Map();
  for(const r of runs){
    if(!source(r))continue;
    const key=r.head_sha+'/'+r.head_branch,p=latest.get(key);
    if(!p||String(r.created_at)>String(p.created_at)||
      (r.created_at===p.created_at&&r.id>p.id))latest.set(key,r);
  }
  const eligible=[];
  for(const r of latest.values()){
    if(r.status!=='completed'||r.conclusion!=='failure'||
      r.run_attempt>=MAX_ATTEMPTS)continue;
    const matches=pulls.filter(p=>p.state==='open'&&id(p.number)&&
      p.head?.sha===r.head_sha&&p.head?.ref===r.head_branch&&
      p.head?.repo?.full_name===REPO&&['main','staging'].includes(p.base?.ref));
    if(matches.length===1)eligible.push({run:r,pr:matches[0]});
  }
  return eligible.sort((a,b)=>String(b.run.created_at).localeCompare(String(a.run.created_at)))
    .slice(0,MAX);
}
export function proof(runs,file,name,sha,pr,headBranch){
  ok(Array.isArray(runs)&&runs.length<=15,'unbounded proof');
  const accepted=runs.filter(r=>r.head_sha===sha&&r.event==='pull_request'&&
    r.path==='.github/workflows/'+file&&r.name===name&&id(r.id)&&id(r.run_attempt)&&
    r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO&&
    // GitHub sometimes omits pull_requests for pull_request-triggered Runs.
    // Exact SHA + same-repo head branch are still required in that case.
    (Array.isArray(r.pull_requests)&&r.pull_requests.length>0
      ? r.pull_requests.some(p=>p.number===pr)
      : r.head_branch===headBranch))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||b.id-a.id);
  return accepted[0]?.status==='completed'&&accepted[0]?.conclusion==='success';
}
export async function reconcile(request,log=()=>{}){
  const root='repos/'+REPO+'/';
  const response=await request(root+'actions/workflows/acceptance-orchestrator.yml/runs?event=pull_request_target&per_page=100');
  ok(Array.isArray(response.workflow_runs)&&response.workflow_runs.length<=100,'invalid run list');
  if(!response.workflow_runs.some(r=>source(r)&&r.conclusion==='failure'))
    return {candidates:0,retried:0};
  const pulls=await request(root+'pulls?state=open&per_page=100');
  const selected=candidates(response.workflow_runs,pulls);
  let retried=0;
  for(const {run,pr} of selected){
    let valid=true;
    for(const [file,name] of SOURCES){
      const data=await request(root+'actions/workflows/'+file+'/runs?event=pull_request&head_sha='+
        run.head_sha+'&per_page=15');
      ok(data&&Array.isArray(data.workflow_runs),'missing exact-head proof');
      if(!proof(data.workflow_runs,file,name,run.head_sha,pr.number,pr.head.ref)){valid=false;break}
    }
    if(!valid)continue;
    // Re-read both authoritative objects after the list queries. No queued,
    // superseded, stale, successful, forged or wrong-attempt run may be replayed.
    const prLive=await request(root+'pulls/'+pr.number);
    const current=await request(root+'actions/runs/'+run.id);
    if(prLive.state!=='open'||prLive.head?.sha!==run.head_sha||
      prLive.head?.ref!==run.head_branch||prLive.head?.repo?.full_name!==REPO||
      prLive.base?.ref!==pr.base.ref||!source(current)||current.id!==run.id||
      current.head_sha!==run.head_sha||current.head_branch!==run.head_branch||
      current.run_attempt!==run.run_attempt||
      current.run_attempt>=MAX_ATTEMPTS||current.status!=='completed'||
      current.conclusion!=='failure')continue;
    await request(root+'actions/runs/'+run.id+'/rerun-failed-jobs','POST');
    retried++;
    log('Requested failed jobs replay; PR #'+pr.number+' sha '+run.head_sha+
      ' original run '+run.id+' attempt '+run.run_attempt);
  }
  return {candidates:selected.length,retried};
}
async function api(path,method='GET'){
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  ok(Boolean(token),'missing Actions API token');
  const r=await fetch('https://api.github.com/'+path,{method,
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(15000)});
  const body=await r.text();
  if(!r.ok)throw classify(r.status,Object.fromEntries(
    ['retry-after','x-ratelimit-remaining','x-ratelimit-reset'].map(k=>[k,r.headers.get(k)||''])),body);
  if(!body.trim())return {};
  return JSON.parse(body);
}
function run(extra={}){
  return {id:9,run_attempt:1,created_at:'2026-10-18T12:00:00Z',
    name:'Acceptance / Orchestrator',path:ACCEPT,event:'pull_request_target',
    head_sha:'a'.repeat(40),head_branch:'fix/a',status:'completed',conclusion:'failure',
    repository:{full_name:REPO},head_repository:{full_name:REPO},...extra};
}
function pull(extra={}){
  return {number:7,state:'open',head:{sha:'a'.repeat(40),ref:'fix/a',
    repo:{full_name:REPO}},base:{ref:'main'},...extra};
}
function check(file,name,extra={}){
  return {id:file==='ci-quality.yml'?12:13,run_attempt:1,
    name,path:'.github/workflows/'+file,event:'pull_request',head_branch:'fix/a',
    head_sha:'a'.repeat(40),created_at:'2026-10-18T12:00:00Z',
    status:'completed',conclusion:'success',pull_requests:[{number:7}],
    repository:{full_name:REPO},head_repository:{full_name:REPO},...extra};
}
async function selfTest(){
  assert.equal(candidates([run()],[pull()]).length,1);
  for(const bad of [
    run({head_sha:'b'.repeat(40)}),run({head_repository:{full_name:'evil/repo'}}),
    run({event:'push'}),run({status:'in_progress',conclusion:null}),
    run({conclusion:'success'}),
  ])assert.equal(candidates([bad],[pull()]).length,0);
  assert.equal(candidates([run()],[pull(),pull()]).length,0);
  assert.equal(candidates([run(),run({id:10,created_at:'2026-10-18T12:01:00Z',
    status:'queued',conclusion:null})],[pull()]).length,0);
  assert.equal(candidates([run({run_attempt:3})],[pull()]).length,0);
  assert.equal(candidates([run({run_attempt:4})],[pull()]).length,0);
  for(const [file,name] of SOURCES){
    assert.equal(proof([check(file,name)],file,name,'a'.repeat(40),7,'fix/a'),true);
    assert.equal(proof([check(file,name,{pull_requests:[]})],file,name,'a'.repeat(40),7,'fix/a'),true);
    assert.equal(proof([check(file,name,{pull_requests:[],head_branch:'fork/other'})],file,name,'a'.repeat(40),7,'fix/a'),false);
    for(const invalid of [
      {run_attempt:0},{conclusion:'failure'},{event:'push'},
      {head_sha:'b'.repeat(40)},{pull_requests:[{number:8}]},
      {path:'.github/workflows/evil.yml'},
      {head_repository:{full_name:'evil/repo'}},
    ])assert.equal(proof([check(file,name,invalid)],file,name,'a'.repeat(40),7,'fix/a'),false);
    assert.equal(proof([check(file,name),check(file,name,{id:14,
      created_at:'2026-10-18T12:02:00Z',status:'in_progress',conclusion:null})],
    file,name,'a'.repeat(40),7,'fix/a'),false);
  }
  const seen=[];
  function mocked({live=run(),freshPR=pull(),badProof=false}={}){
    return async(path,method='GET')=>{
      seen.push(method+' '+path);
      if(method==='POST')return {};
      if(path.includes('acceptance-orchestrator.yml/runs'))return {workflow_runs:[run()]};
      if(path.includes('/pulls?'))return [pull()];
      if(path.endsWith('pulls/7'))return freshPR;
      if(path.endsWith('actions/runs/9'))return live;
      const found=SOURCES.find(([f])=>path.includes('/'+f+'/runs?'));
      if(found)return {workflow_runs:[check(...found,badProof?{conclusion:'failure'}:{})]};
      throw Error('unexpected mock path '+path);
    };
  }
  assert.equal((await reconcile(mocked())).retried,1);
  assert.equal(seen.filter(x=>x.startsWith('POST ')).length,1);
  assert.ok(seen.length<=7);
  seen.length=0;
  assert.equal((await reconcile(mocked({live:run({run_attempt:2})}))).retried,0);
  assert.equal((await reconcile(mocked({live:run({run_attempt:3})}))).retried,0);
  assert.equal(seen.filter(x=>x.startsWith('POST ')).length,0);
  assert.equal((await reconcile(mocked({badProof:true}))).retried,0);
  assert.equal((await reconcile(mocked({freshPR:pull({state:'closed'})}))).retried,0);
  for(const code of [403,429]){
    const err=classify(code,{'retry-after':'90'},'rate limit exceeded');
    assert.ok(err instanceof RateLimited);
    await assert.rejects(()=>reconcile(async()=>{throw err}),RateLimited);
  }
  assert.ok(!(classify(403,{},'permission denied') instanceof RateLimited));
  assert.ok(candidates(Array.from({length:100},(_,i)=>run({id:100+i,
    head_branch:'b'+i,head_sha:(i.toString(16).padStart(40,'a')).slice(-40)})),[]).length<=MAX);
  console.log('Acceptance quota recovery: exact SHA, stale attempt, capped retry budget, exhausted quota, wrong proof, idempotency and bounded bursts passed');
}
async function main(){
  if(process.argv[2]==='self-test')return selfTest();
  ok(process.argv[2]==='run','usage self-test | run');
  ok(process.env.GITHUB_REPOSITORY===REPO&&process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_EVENT_NAME==='schedule','only trusted main schedule may recover');
  try{
    const out=await reconcile(api,console.log);
    console.log('Acceptance quota recovery: '+JSON.stringify(out));
  }catch(e){
    if(e instanceof RateLimited){
      console.log(e.message+'; no verdict created, defer until a later scheduled execution');
      return;
    }
    throw e;
  }
}
if(process.argv[1]&&import.meta.url==='file://'+process.argv[1])
  main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
