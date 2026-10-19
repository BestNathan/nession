// Read-only source attestation for publicly published Pages Agent observations.
// Main workflow code, not mutable Issue text, defines the trusted HTTPS/digest gate.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const WORKFLOW='.github/workflows/deploy-pages.yml';
const NAME='Deploy / Public Pages';
const BUILD='Build independent Pages', DEPLOY='Publish independent Pages';
const VERIFY='Verify public site URL and exact deployed main SHA';
const CAPTURE='Capture exact static public evidence digest and coverage';
const OBSERVED=/^\d{4}-\d{2}-\d{2}T[^\s]+Z Public Issue Agent Run observation: (source_backed_observation|not_observed) \(source=(available|truncated|unavailable), runs=(\d+), digest=([a-f0-9]{64})\)$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;

export function attestPagesDeployment(repo,sha,run,jobs,log) {
  if(repo!==REPO||!SHA.test(sha)||!positive(run?.id)||
    run?.name!==NAME||run?.path!==WORKFLOW||
    run?.event!=='push'||run?.head_branch!=='main'||run?.head_sha!==sha||
    run?.repository?.full_name!==repo||run?.head_repository?.full_name!==repo||
    !positive(run?.run_attempt)||run?.status!=='completed'||run?.conclusion!=='success')
    throw Error('Pages deployment Run identity not attested');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>35)throw Error('unbounded Pages jobs');
  const owned=name=>jobs.jobs.filter(j=>j.name===name&&j.run_id===run.id&&
    j.run_attempt===run.run_attempt&&j.head_sha===sha&&j.status==='completed'&&
    j.conclusion==='success');
  const build=owned(BUILD),publish=owned(DEPLOY);
  if(build.length!==1||publish.length!==1||
    !positive(build[0].id)||!positive(publish[0].id)||
    !build[0].steps?.some(s=>s.name===CAPTURE&&s.conclusion==='success')||
    !build[0].steps?.some(s=>s.name==='Upload standalone Pages'&&s.conclusion==='success')||
    !publish[0].steps?.some(s=>s.name===VERIFY&&s.conclusion==='success')||
    !publish[0].steps?.some(s=>s.name==='Deploy GitHub Pages'&&s.conclusion==='success'))
    throw Error('Pages exact-attempt HTTPS/digest verification job not attested');
  if(typeof log!=='string'||log.length>1024*1024)throw Error('unbounded Pages deploy log');
  // Excludes literal shell script `echo "$status"` lines and user-provided prose.
  const matches=log.split(/\r?\n/).map(line=>line.match(OBSERVED)).filter(Boolean);
  if(matches.length!==1)throw Error('missing or ambiguous actual deployed Pages observation');
  const [,status,source,rawCount,digest]=matches[0];
  const count=Number(rawCount);
  if(!Number.isSafeInteger(count)||count<0||!DIGEST.test(digest))throw Error('invalid public Pages count or digest');
  if(status==='source_backed_observation'&&
    (source==='unavailable'||count===0))throw Error('forged Pages observation success');
  if(status==='not_observed'&&source!=='unavailable'&&count>0)
    throw Error('ambiguous Pages observation outcome');
  return {run_id:run.id,run_attempt:run.run_attempt,build_job_id:build[0].id,
    publish_job_id:publish[0].id,status,source,count,digest};
}
export function attestPublicPagesObservation(repo,sha,run,jobs,log) {
  const proof=attestPagesDeployment(repo,sha,run,jobs,log);
  if(proof.status!=='source_backed_observation')return null;
  return {
    kind:'verified_public_pages_agent_observation',schema_version:1,
    target_sha:sha,run_id:proof.run_id,run_attempt:proof.run_attempt,
    build_job_id:proof.build_job_id,publish_job_id:proof.publish_job_id,
    source:proof.source,observed_issue_agent_runs:proof.count,
    public_json_sha256:proof.digest,
    public_url:'https://bestnathan.github.io/nession/data/site.json',
    source_url:'https://github.com/'+repo+'/actions/runs/'+proof.run_id,
    verified_by:'GitHub REST exact Run/Attempt/Jobs and completed HTTPS/digest verification job log',
    implements_pr_linkage:false,establishes_sc_verdict:false,
  };
}

export async function collectPublicPagesObservation(repo,sha,runs,
  request,readJobLog) {
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(runs))throw Error('invalid Pages evidence request');
  const candidates=runs.filter(r=>r?.name===NAME&&r.path===WORKFLOW&&
    r.head_sha===sha&&r.status==='completed'&&r.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,3);
  for(const candidate of candidates){
    const run=await request('/repos/'+repo+'/actions/runs/'+candidate.id);
    if(run.id!==candidate.id)throw Error('Pages REST source identity mismatch');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+run.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    const publisher=jobs.jobs?.filter(j=>j.name===DEPLOY&&
      j.run_id===run.id&&j.run_attempt===run.run_attempt);
    if(publisher?.length!==1||!positive(publisher[0].id))
      throw Error('missing unique Pages publisher job');
    const log=await readJobLog('/repos/'+repo+'/actions/jobs/'+publisher[0].id+'/logs');
    const receipt=attestPublicPagesObservation(repo,sha,run,jobs,log);
    if(receipt)return [receipt];
  }
  return [];
}
export function selfTestPublicPagesObservation(){
  const sha='a'.repeat(40),run={id:81,run_attempt:2,name:NAME,path:WORKFLOW,
    event:'push',head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const step=name=>({name,conclusion:'success'});
  const jobs={jobs:[
    {id:7,run_id:81,run_attempt:2,head_sha:sha,name:BUILD,status:'completed',conclusion:'success',
      steps:[step('Upload standalone Pages'),step(CAPTURE)]},
    {id:8,run_id:81,run_attempt:2,head_sha:sha,name:DEPLOY,status:'completed',conclusion:'success',
      steps:[step('Deploy GitHub Pages'),step(VERIFY)]},
  ]};
  const log='2026-10-18T10:44:03.9319688Z Public Issue Agent Run observation: source_backed_observation (source=truncated, runs=11, digest='+'b'.repeat(64)+')\n';
  const prove=(r=run,j=jobs,l=log)=>attestPublicPagesObservation(REPO,sha,r,j,l);
  const ok=prove();
  assert.equal(ok.observed_issue_agent_runs,11);
  assert.equal(ok.target_sha,sha);
  assert.equal(ok.implements_pr_linkage,false);
  const negatives=[
    {...run,head_sha:'c'.repeat(40)},
    {...run,run_attempt:1},
    {...run,event:'pull_request'},
    {...run,repository:{full_name:'other/repo'}},
    {...run,head_repository:{full_name:'other/repo'}},
    {...run,path:'.github/workflows/foreign.yml'},
    {...run,conclusion:'failure'},
    {...run,head_branch:'staging'},
  ];
  for(const invalid of negatives)
    assert.throws(()=>prove(invalid),/not attested/);
  for(const bad of [
    {...jobs,jobs:jobs.jobs.map(x=>({...x,run_attempt:1}))},
    {...jobs,jobs:[jobs.jobs[0]]},
    {...jobs,jobs:[...jobs.jobs,jobs.jobs[1]]},
    {...jobs,jobs:jobs.jobs.map(x=>x.name===DEPLOY?{...x,steps:[step('Deploy GitHub Pages')]}:x)},
  ])assert.throws(()=>prove(run,bad),/not attested/);
  assert.equal(prove(run,jobs,log.replace('source_backed_observation','not_observed').replace('runs=11','runs=0')),null);
  assert.throws(()=>prove(run,jobs,log.replace('runs=11','runs=0')),/forged/);
  assert.throws(()=>prove(run,jobs,log.replace('source=truncated','source=unavailable')),/forged/);
  assert.throws(()=>prove(run,jobs,log+log),/ambiguous/);
  assert.throws(()=>prove(run,jobs,'echo "Public Issue Agent Run observation: source_backed_observation..."'),/missing/);
  assert.throws(()=>prove(run,jobs,log.replace('digest='+'b'.repeat(64),'digest=FAKE')),/missing/);
  return true;
}
