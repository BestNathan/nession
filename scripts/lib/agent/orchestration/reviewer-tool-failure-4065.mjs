// #4211: exact independent attestation of the real #4065 Reviewer Slice
// post-model read-only tool-policy denial. Never publish or accept its
// attempted tool-use, and never return raw model/session/log bytes.
import {REVIEWER_TOOL_FAILURE_4065 as F} from './outbox.mjs';
const REPO='BestNathan/nession';
const REVIEW_JOB=136428975706;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const ARTIFACTS=Object.freeze({
  ['review-admission-'+F.run_id+'-1']:Object.freeze({
    id:14649063663,digest:'sha256:ef6672ace1b6533e7a07517c9f16cbfa7dcc9f3747652ddbc774bb4e3790fc32',
  }),
  ['review-claim-'+F.run_id+'-1']:Object.freeze({
    id:14650262447,digest:'sha256:4ebf9b52b50b1723457d444177360a2d70677ff34983608acd95eb29c621c96a',
  }),
});
const fail=s=>{throw Error('trusted Reviewer tool-policy failure: '+s);};
function exactly(jobs,name,conclusion,runId){
  const found=jobs.jobs.filter(x=>x.name===name);
  if(found.length!==1||found[0].status!=='completed'||
    found[0].conclusion!==conclusion||found[0].run_id!==runId||
    (found[0].run_attempt!=null&&found[0].run_attempt!==1))
    fail('wrong exact Reviewer '+name+' job result');
  return found[0];
}
function step(job,name,conclusion){
  if(!Array.isArray(job.steps)||job.steps.filter(x=>
    x.name===name&&x.status==='completed'&&x.conclusion===conclusion).length!==1)
    fail('wrong expected Reviewer step '+name);
}
export function attestReviewerToolFailure4065(run,jobs,artifacts,log) {
  if(run?.id!==F.run_id||run.run_attempt!==1||
    run.name!=='Agent / Review'||run.path!=='.github/workflows/agent-review.yml'||
    run.head_sha!==F.main_sha||run.head_branch!=='main'||
    run.event!=='workflow_dispatch'||run.actor?.login!=='github-actions[bot]'||
    run.status!=='completed'||run.conclusion!=='failure'||
    run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO)
    fail('wrong original failed Run identity');
  if(!Array.isArray(jobs?.jobs)||jobs.total_count!==3||jobs.jobs.length!==3)
    fail('wrong complete Reviewer job inventory');
  const prepare=exactly(jobs,'prepare','success',F.run_id);
  const review=exactly(jobs,'review','failure',F.run_id);
  exactly(jobs,'notify-metrics','skipped',F.run_id);
  if(review.id!==REVIEW_JOB||review.steps.filter(x=>x.conclusion==='failure').length!==1)
    fail('wrong failed Reviewer stage');
  step(prepare,'Prepare the reviewer admission','success');
  step(review,'Run the read-only Reviewer Slice directly with Node.js','failure');
  if(!Array.isArray(artifacts?.artifacts)||artifacts.total_count!==2||
     artifacts.artifacts.length!==2||
     new Set(artifacts.artifacts.map(x=>x.name)).size!==2)
    fail('untrusted/extra failed Review Artifacts');
  for(const a of artifacts.artifacts){
    const expected=ARTIFACTS[a.name];
    if(!expected||a.id!==expected.id||a.digest!==expected.digest||
      !DIGEST.test(a.digest)||a.expired!==false||
      !Number.isSafeInteger(a.size_in_bytes)||a.size_in_bytes<1||
      a.workflow_run?.id!==F.run_id||
      a.workflow_run?.head_sha!==F.main_sha)
      fail('review admission/claim Artifact identity mismatch');
  }
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
    !log.includes('Reviewer Slice: write/shell tool observed in a read-only review')||
    !log.includes('Process completed with exit code 1.'))
    fail('not the exact blocked native write/shell policy failure');
  return Object.freeze({verified:true,issue:F.issue,action_id:F.action_id,
    run_id:F.run_id,attempt:1,source_sha:F.source_sha,
    failure_code:F.failure_code});
}
export async function verifyReviewerToolFailure4065Live(token,request=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('missing read-only Github token');
  const base='https://api.github.com/repos/'+REPO;
  const api=async path=>{
    const r=await request(base+path,{headers:{
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'}});
    if(!r.ok)fail('original GitHub source read failed');
    return r;
  };
  const [run,jobs,artifacts,logs]=await Promise.all([
    api('/actions/runs/'+F.run_id),
    api('/actions/runs/'+F.run_id+'/jobs?per_page=100'),
    api('/actions/runs/'+F.run_id+'/artifacts?per_page=100'),
    api('/actions/jobs/'+REVIEW_JOB+'/logs'),
  ]);
  const length=Number(logs.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>1024*1024)
    fail('source job log exceeds bound');
  return attestReviewerToolFailure4065(
    await run.json(),await jobs.json(),await artifacts.json(),await logs.text());
}
