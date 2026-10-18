// Authenticated, read-only public Pages publication evidence.
// This is not an SC projector or a privileged Pages producer.
// Exact GitHub REST workflow/job identities must back the log message.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const WORKFLOW='Deploy / Public Pages';
const PATH='.github/workflows/deploy-pages.yml';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const fullRepo=x=>x?.full_name===REPO;
const jobName={build:'Build independent Pages',deploy:'Publish independent Pages'};

export function parsePublicPagesBuildLog(log, sha) {
  if(typeof log!=='string'||log.length>1048576||!SHA.test(sha))return null;
  const candidates=[];
  for(const line of log.split(/\r?\n/)){
    const m=line.match(/^\d{4}-\d{2}-\d{2}T[^\s]+Z (\{[^\n]{20,1500}\})\s*$/);
    if(!m||!m[1].includes('"source_main_sha"'))continue;
    let data;
    try{data=JSON.parse(m[1]);}catch{return null;}
    if(data.source_main_sha!==sha||!SHA.test(data.metrics_sha)||
      !['available','truncated','unavailable'].includes(data.agent_run_observation))
      return null;
    candidates.push({metrics_sha:data.metrics_sha,source:data.agent_run_observation});
  }
  if(candidates.length!==1)return null;
  return candidates[0];
}

export function parsePublicPagesPublishLog(log){
  if(typeof log!=='string'||log.length>1048576)return null;
  const candidates=[];
  for(const line of log.split(/\r?\n/)){
    const m=line.match(/^\d{4}-\d{2}-\d{2}T[^\s]+Z Public Issue Agent Run observation: (source_backed_observation|not_observed) \(source=(available|truncated|unavailable), runs=(\d+), digest=([a-f0-9]{64})\)\s*$/);
    if(!m)continue;
    const runs=Number(m[3]);
    if(!Number.isSafeInteger(runs)||runs<0||runs>36||!HASH.test(m[4]))return null;
    const status=m[1],source=m[2];
    if(status==='source_backed_observation'&&(source==='unavailable'||runs<1))return null;
    if(status==='not_observed'&&source!=='unavailable'&&runs!==0)return null;
    candidates.push({status,source,observed_runs:runs,digest:m[4]});
  }
  if(candidates.length!==1)return null;
  return candidates[0];
}

export function attestPublicPagesRun(run,payload,sha){
  if(!run||run.name!==WORKFLOW||run.path!==PATH||run.event!=='push'||
    run.head_branch!=='main'||run.head_sha!==sha||!SHA.test(sha)||
    !fullRepo(run.repository)||!fullRepo(run.head_repository)||
    run.status!=='completed'||run.conclusion!=='success'||
    !positive(run.id)||!positive(run.run_attempt)||
    !payload||!Array.isArray(payload.jobs))return null;
  const jobs={};
  for(const [k,n] of Object.entries(jobName)){
    const matches=payload.jobs.filter(j=>j.name===n);
    if(matches.length!==1)return null;
    const j=matches[0];
    if(!positive(j.id)||j.run_id!==run.id||j.run_attempt!==run.run_attempt||
       j.head_sha!==sha||j.status!=='completed'||j.conclusion!=='success')return null;
    jobs[k]=j.id;
  }
  return {run_id:run.id,run_attempt:run.run_attempt,head_sha:sha,
    build_job_id:jobs.build,publish_job_id:jobs.deploy};
}

// The only positive attestation is a live anonymous-HTTPS echo *inside*
// the authenticated successful trusted-main publish job (not a fixture).
export async function collectPublicPagesEvidence({repo,sha,runs,get,getText}){
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(runs))return [];
  const candidates=runs.filter(x=>x?.head_sha===sha&&x?.name===WORKFLOW&&
    x?.path===PATH&&x?.event==='push'&&x?.status==='completed'&&
    x?.conclusion==='success').sort((a,b)=>b.id-a.id).slice(0,3);
  for(const candidate of candidates){
    try{
      const live=await get('/repos/'+repo+'/actions/runs/'+candidate.id);
      const jobs=await get('/repos/'+repo+'/actions/runs/'+live.id+'/attempts/'+live.run_attempt+'/jobs?per_page=100');
      const proof=attestPublicPagesRun(live,jobs,sha);
      if(!proof)continue;
      const [buildLog,deployLog]=await Promise.all([
        getText('/repos/'+repo+'/actions/jobs/'+proof.build_job_id+'/logs'),
        getText('/repos/'+repo+'/actions/jobs/'+proof.publish_job_id+'/logs'),
      ]);
      const build=parsePublicPagesBuildLog(buildLog,sha);
      const pub=parsePublicPagesPublishLog(deployLog);
      if(!build||!pub||build.source!==pub.source)continue;
      return [{...proof,metrics_sha:build.metrics_sha,
        status:pub.status,source:pub.source,observed_runs:pub.observed_runs,
        published_json_sha256:pub.digest,
        source_url:'https://github.com/'+repo+'/actions/runs/'+live.id}];
    }catch{ /* Missing/expired GitHub evidence must never become a Pass. */ }
  }
  return [];
}

export async function selfTestPublicPagesEvidence(){
  const sha='a'.repeat(40),metrics='b'.repeat(40),digest='c'.repeat(64);
  const run={name:WORKFLOW,path:PATH,event:'push',head_branch:'main',head_sha:sha,
    repository:{full_name:REPO},head_repository:{full_name:REPO},status:'completed',
    conclusion:'success',id:511,run_attempt:2};
  const jobs={jobs:Object.entries(jobName).map(([kind,name],i)=>({
    id:701+i,name,run_id:511,run_attempt:2,head_sha:sha,status:'completed',conclusion:'success'
  }))};
  const buildLog='2026-10-18T10:00:00Z '+JSON.stringify({
    source_main_sha:sha,metrics_sha:metrics,agent_run_observation:'truncated'})+'\n';
  const publishedLog='2026-10-18T10:01:00Z Public Issue Agent Run observation: source_backed_observation (source=truncated, runs=11, digest='+digest+')\n';
  const get=async p=>{
    if(p.endsWith('/actions/runs/511'))return run;
    if(p.endsWith('/actions/runs/511/attempts/2/jobs?per_page=100'))return jobs;
    throw Error('unexpected REST path '+p);
  };
  const log=async p=>p.endsWith('/701/logs')?buildLog:publishedLog;
  assert.deepEqual(await collectPublicPagesEvidence({repo:REPO,sha,runs:[run],get,getText:log}),[{
    run_id:511,run_attempt:2,head_sha:sha,build_job_id:701,publish_job_id:702,
    metrics_sha:metrics,status:'source_backed_observation',source:'truncated',
    observed_runs:11,published_json_sha256:digest,
    source_url:'https://github.com/'+REPO+'/actions/runs/511',
  }]);
  for(const wrong of [{...run,head_sha:'d'.repeat(40)},
    {...run,repository:{full_name:'foreign/repo'}},
    {...run,path:'untrusted.yml'},{...run,run_attempt:3},
    {...run,status:'in_progress'},{...run,conclusion:'failure'}]){
    assert.deepEqual(await collectPublicPagesEvidence({repo:REPO,sha,runs:[wrong],get:async()=>wrong,getText:log}),[]);
  }
  const failJobs={jobs:[...jobs.jobs,{...jobs.jobs[1],id:770}]};
  assert.deepEqual(await collectPublicPagesEvidence({repo:REPO,sha,runs:[run],
    get:async p=>p.endsWith('/jobs?per_page=100')?failJobs:run,getText:log}),[]);
  assert.equal(parsePublicPagesPublishLog(publishedLog.replace('runs=11','runs=0')),null);
  assert.equal(parsePublicPagesPublishLog(publishedLog+publishedLog),null);
  assert.equal(parsePublicPagesBuildLog(buildLog+buildLog,sha),null);
  assert.equal(parsePublicPagesPublishLog(
    '2026-10-18T10:01:00Z echo "Public Issue Agent Run observation: $status ..."'),null);
  assert.equal(parsePublicPagesPublishLog(publishedLog.replace(digest,'bad-hash')),null);
  assert.deepEqual(await collectPublicPagesEvidence({repo:REPO,sha,runs:[run],
    get,getText:async p=>p.endsWith('/701/logs')?
      buildLog:publishedLog.replace('source=truncated','source=unavailable')}),[]);
  console.log('Pages authenticated HTTPS publication: 12 source/Run/attempt/privacy negatives passed');
}
