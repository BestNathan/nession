// #3601: independently attest the sole known Reviewer Run whose bounded
// malformed-JSON verdict caused a post-model failure. No model text, source
// selected by Issue comments, or uploaded output may attest a Reviewer result.
import {REVIEWER_JSON_FAILURE as F,
  REVIEWER_JSON_FAILURE_SOURCES} from './outbox.mjs';
const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
function deny(s){throw Error('trusted Reviewer JSON failure: '+s);}
export function attestReviewerJsonFailure(run,listing,artifacts,source=F){
  if(!REVIEWER_JSON_FAILURE_SOURCES.includes(source))
    deny('unknown exact post-model source identity');
  if(run?.id!==source.run_id||run.run_attempt!==1||
      run.name!=='Agent / Review'||
      run.path!=='.github/workflows/agent-review.yml'||
      run.event!=='workflow_dispatch'||run.actor?.login!=='github-actions[bot]'||
      run.head_branch!=='main'||run.head_sha!==source.main_sha||
      run.status!=='completed'||run.conclusion!=='failure'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO||
      !Array.isArray(listing?.jobs)||listing.total_count!==3||
      listing.jobs.length!==3)
    deny('Run/Attempt/Actor/main or exact three-Job inventory differs');
  const one=name=>listing.jobs.filter(j=>j.name===name);
  const prepare=one('prepare'),review=one('review'),metrics=one('notify-metrics');
  if(prepare.length!==1||review.length!==1||metrics.length!==1||
      ![...prepare,...review,...metrics].every(j=>
        j.run_id===source.run_id&&j.status==='completed'&&
        (j.run_attempt==null||j.run_attempt===1))||
      prepare[0].conclusion!=='success'||review[0].conclusion!=='failure'||
      metrics[0].conclusion!=='skipped'||!Array.isArray(prepare[0].steps)||
      !Array.isArray(review[0].steps))
    deny('not the known successful admission + failed model Review');
  const exactly=(steps,name,conclusion)=>steps.filter(s=>s.name===name&&
    s.status==='completed'&&s.conclusion===conclusion).length===1;
  const workerStep=source.issue===3784
    ?'Run the read-only Reviewer Slice directly with Node.js'
    :'Run the read-only Reviewer Slice in an OS-isolated container';
  if(!exactly(prepare[0].steps,'Prepare the reviewer admission','success')||
      !exactly(review[0].steps,workerStep,'failure')||
      review[0].steps.filter(s=>s.conclusion==='failure').length!==1)
    deny('failed step is not the bounded Review model output stage');
  // The original signed admission and claim must exist, but no verdict,
  // result, or telemetry Artifact can have been accepted from this Run.
  if(!Array.isArray(artifacts?.artifacts)||artifacts.total_count!==2||
      artifacts.artifacts.length!==2)
    deny('ambiguous successful result or incomplete Artifact inventory');
  for(const prefix of ['review-admission','review-claim']){
    const matched=artifacts.artifacts.filter(a=>a.name===
      prefix+'-'+source.run_id+'-1');
    const artifact=matched[0];
    if(matched.length!==1||artifact.expired!==false||
        !positive(artifact.id)||!positive(artifact.size_in_bytes)||
        !DIGEST.test(artifact.digest??'')||
        artifact.workflow_run?.id!==source.run_id||
        artifact.workflow_run?.head_sha!==source.main_sha)
      deny('missing or forged immutable Reviewer admission/claim');
  }
  return Object.freeze({verified:true,issue:source.issue,action_id:source.action_id,
    run_id:source.run_id,attempt:1,source_sha:source.source_sha,
    failure_code:source.failure_code});
}
async function api(token,path){
  if(typeof token!=='string'||token.length<8)deny('missing read token');
  const resp=await fetch('https://api.github.com/repos/'+REPO+path,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!resp.ok)deny('GitHub source read failed '+resp.status);
  return resp.json();
}
export async function verifyReviewerJsonFailureLive(token,source=F){
  if(!REVIEWER_JSON_FAILURE_SOURCES.includes(source))
    deny('unknown live post-model failure identity');
  const [run,jobs,artifacts]=await Promise.all([
    api(token,'/actions/runs/'+source.run_id),
    api(token,'/actions/runs/'+source.run_id+'/jobs?per_page=100'),
    api(token,'/actions/runs/'+source.run_id+'/artifacts?per_page=100'),
  ]);
  return attestReviewerJsonFailure(run,jobs,artifacts,source);
}
