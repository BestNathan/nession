// #3574: independently authenticate one already completed pre-model
// Qwen Reviewer failure before mutating trusted Store or dispatching a successor.
import {REVIEWER_PREMODEL_FAILURE as F,
  REVIEWER_PREMODEL_FAILURE_4065 as F4065,
  REVIEWER_PREMODEL_FAILURE_SOURCES} from './outbox.mjs';

const REPO='BestNathan/nession';
function deny(s){throw Error('trusted Reviewer pre-model failure: '+s);}
export function attestReviewerPremodelFailure(run,listing,source=F,artifacts=null){
  if(!REVIEWER_PREMODEL_FAILURE_SOURCES.includes(source))
    deny('unknown source-bound failure identity');
  if(run?.id!==source.run_id||run.run_attempt!==1||
     run.name!=='Agent / Review'||
     run.path!=='.github/workflows/agent-review.yml'||
     run.event!=='workflow_dispatch'||
     run.actor?.login!=='github-actions[bot]'||
     run.head_branch!=='main'||run.head_sha!==source.main_sha||
     run.status!=='completed'||run.conclusion!=='failure'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     !Array.isArray(listing?.jobs)||listing.total_count!==3||
     listing.jobs.length!==3)
    deny('unverified original main Reviewer Run');
  const exact=name=>listing.jobs.filter(j=>j?.name===name);
  const prepare=exact('prepare'),review=exact('review'),
    metrics=exact('notify-metrics');
  if(prepare.length!==1||review.length!==1||metrics.length!==1)
    deny('Reviewer failed job inventory differs from source');
  const jobOk=(job,conclusion)=>
    job.run_id===source.run_id&&job.status==='completed'&&
    job.conclusion===conclusion&&
    (job.run_attempt==null||job.run_attempt===1);
  if(!jobOk(prepare[0],'failure')||!jobOk(review[0],'skipped')||
     !jobOk(metrics[0],'skipped')||!Array.isArray(prepare[0].steps))
    deny('model-capable Reviewer job was not skipped');
  const failure=prepare[0].steps.filter(x=>x.conclusion==='failure');
  if(failure.length!==1||
     failure[0].name!=='Prepare the reviewer admission'||
     failure[0].status!=='completed')
    deny('failed step is not bounded trusted pre-model admission');
  // #4192: independently prove the new pre-model Run emitted NO result,
  // verdict, telemetry or partial admission Artifacts before Store recovery.
  if(source===F4065&&(
    artifacts?.total_count!==0||!Array.isArray(artifacts.artifacts)||
    artifacts.artifacts.length!==0))
    deny('unexpected Artifact for failed #4065 pre-model Reviewer');
  return Object.freeze({verified:true,issue:source.issue,action_id:source.action_id,
    run_id:source.run_id,attempt:1,source_sha:source.source_sha,
    failure_code:source.failure_code});
}
async function api(token,path){
  if(typeof token!=='string'||token.length<8)deny('missing read token');
  const response=await fetch('https://api.github.com/repos/'+REPO+path,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!response.ok)deny('source read failed ('+response.status+')');
  return response.json();
}
export async function verifyReviewerPremodelFailureLive(token,source=F){
  if(!REVIEWER_PREMODEL_FAILURE_SOURCES.includes(source))
    deny('unknown live failure identity');
  const run=await api(token,'/actions/runs/'+source.run_id);
  const jobs=await api(token,'/actions/runs/'+source.run_id+'/jobs?per_page=100');
  const artifacts=source===F4065
    ?await api(token,'/actions/runs/'+source.run_id+'/artifacts?per_page=100')
    :null;
  return attestReviewerPremodelFailure(run,jobs,source,artifacts);
}
