// Trusted Acceptance adapter for the Pages-owned Workflow publication receipt.
// Never use mutable Issue text, a PR fixture, or a model verdict as publication.
import assert from 'node:assert/strict';
import {attestPagesDeployment} from './acceptance-pages-deployment-receipt.mjs';
import {parseWorkflowPublicationLog,formatWorkflowPublication} from '../pages/scripts/publication-receipt.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const NAME='Deploy / Public Pages',PATH='.github/workflows/deploy-pages.yml';
export function shouldCollectPublicWorkflowPublication(stage,issue) {
  return stage==='post-merge'&&new Set(['2056','2073']).has(String(issue));
}
export function attestPublicWorkflowPublication(repo,sha,run,jobs,log) {
  const proof=attestPagesDeployment(repo,sha,run,jobs,log);
  const publication=parseWorkflowPublicationLog(log,sha);
  return Object.freeze({
    schema_version:1,kind:'verified_public_pages_workflow_publication',
    target_sha:sha,run_id:proof.run_id,run_attempt:proof.run_attempt,
    build_job_id:proof.build_job_id,publish_job_id:proof.publish_job_id,
    nodes:publication.nodes,public_html_sha256:publication.html_sha256,
    public_json_sha256:publication.json_sha256,
    html_url:'https://bestnathan.github.io/nession/workflows.html',
    json_url:'https://bestnathan.github.io/nession/data/workflows.json',
    source_url:'https://github.com/'+repo+'/actions/runs/'+proof.run_id,
    verified_by:'main-owned completed Run/Attempt/Jobs and bounded anonymous HTML/JSON SHA256 publisher receipt',
    establishes_sc_verdict:false,implements_pr_linkage:false
  });
}
export async function collectPublicWorkflowPublications(repo,sha,runs,get,readJobLog) {
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(runs))
    throw Error('invalid public Workflow publication source request');
  const eligible=runs.filter(r=>r?.name===NAME&&r.path===PATH&&r.head_sha===sha&&
    r.status==='completed'&&r.conclusion==='success')
    .sort((a,b)=>b.id-a.id).slice(0,3);
  for(const item of eligible){
    try{
      const run=await get('/repos/'+repo+'/actions/runs/'+item.id);
      if(run?.id!==item.id)throw Error('Run/Attempt identity changed');
      const jobs=await get('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      const pub=jobs?.jobs?.filter(j=>j.name==='Publish independent Pages'&&
        j.run_id===run.id&&j.run_attempt===run.run_attempt);
      if(pub?.length!==1||!Number.isSafeInteger(pub[0].id)||pub[0].id<=0)
        throw Error('missing unique publisher job');
      const log=await readJobLog('/repos/'+repo+'/actions/jobs/'+pub[0].id+'/logs');
      return [attestPublicWorkflowPublication(repo,sha,run,jobs,log)];
    }catch(err){
      // Unknown/HTTP outage is not Pass. Acceptance may retry after a new
      // authenticated source completion; no forged empty-success receipt.
      console.error('Workflow public publication not verified:',err.message);
    }
  }
  return [];
}
export function selfTestPublicWorkflowPublication(){
  const sha='a'.repeat(40),run={id:101,run_attempt:2,name:NAME,path:PATH,
    event:'push',head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const step=name=>({name,conclusion:'success'});
  const jobs={jobs:[
    {id:9,name:'Build independent Pages',run_id:101,run_attempt:2,head_sha:sha,
      status:'completed',conclusion:'success',
      steps:[step('Capture exact static public evidence digest and coverage'),step('Upload standalone Pages')]},
    {id:10,name:'Publish independent Pages',run_id:101,run_attempt:2,head_sha:sha,
      status:'completed',conclusion:'success',
      steps:[step('Deploy GitHub Pages'),step('Verify public site URL and exact deployed main SHA')]}
  ]};
  const marker=formatWorkflowPublication({main_sha:sha,nodes:27,
    json_sha256:'b'.repeat(64),html_sha256:'c'.repeat(64)});
  const log='2026-10-20T10:58:24.710Z Public Issue Agent Run observation: source_backed_observation (source=truncated, runs=27, digest='+'d'.repeat(64)+')\n'+
    '2026-10-20T10:58:24.711Z '+marker;
  const proof=attestPublicWorkflowPublication(REPO,sha,run,jobs,log);
  assert.equal(proof.nodes,27);assert.equal(proof.target_sha,sha);
  assert.equal(proof.establishes_sc_verdict,false);
  assert.equal(shouldCollectPublicWorkflowPublication('post-merge',2056),true);
  assert.equal(shouldCollectPublicWorkflowPublication('pre-merge',2056),false);
  assert.equal(shouldCollectPublicWorkflowPublication('post-merge',9999),false);
  for(const bad of [
    {...run,head_sha:'e'.repeat(40)},
    {...run,event:'pull_request'},
    {...run,run_attempt:1},
    {...run,conclusion:'failure'}
  ])assert.throws(()=>attestPublicWorkflowPublication(REPO,sha,bad,jobs,log),/not attested/);
  for(const badLog of [log.replace('nodes=27','nodes=0'),log+'\n'+log.split('\n')[1],
    log.replace('main_sha='+sha,'main_sha='+'e'.repeat(40)),log.replace('json_sha256=','json_sha256=x')])
    assert.throws(()=>attestPublicWorkflowPublication(REPO,sha,run,jobs,badLog));
  assert.throws(()=>attestPublicWorkflowPublication(REPO,sha,run,{jobs:[jobs.jobs[0]]},log),/not attested/);
  return true;
}
if(process.argv[2]==='self-test')selfTestPublicWorkflowPublication();
