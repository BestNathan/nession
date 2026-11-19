// #3885: independently authenticate one source-locked failed Reviewer
// preparation after published PR #3919 and Store v12. No model was run.
// Never retry the consumed original Run/ticket or accept an Issue-authored
// assertion in place of GitHub Run/Job/Artifact evidence.
export const SOURCE=Object.freeze({
  issue:3784,
  action_id:'1251328b3288d32c751a347a016ff5d25740704cd8b16e227bd49a6bdd672087',
  run_id:44431618028,
  attempt:1,
  run_head_sha:'65da9467375627baa6ea19359b3abedd4515f3ef',
  source_sha:'5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  publisher_run_id:44281178406,
  failure_code:'qwen_review_authenticated_base_context_oversized',
});
const REPO='BestNathan/nession';
function fail(s){throw Error('trusted Qwen Reviewer oversized-base failure: '+s);}
export function attestQwenReviewerBaseFailure(run,jobs,artifacts,jobLog){
  const s=SOURCE;
  if(run?.id!==s.run_id||run.run_attempt!==1||
      run.name!=='Agent / Review'||
      run.path!=='.github/workflows/agent-review.yml'||
      run.event!=='workflow_dispatch'||
      run.actor?.login!=='github-actions[bot]'||
      run.head_branch!=='main'||run.head_sha!==s.run_head_sha||
      run.status!=='completed'||run.conclusion!=='failure'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO)
    fail('failed Reviewer Run is not the exact main-owned source');
  const names=['prepare','review','notify-metrics'];
  if(jobs?.total_count!==3||jobs.jobs?.length!==3||
      names.some(n=>jobs.jobs.filter(j=>j?.name===n).length!==1))
    fail('Reviewer failed Job inventory differs');
  const prepare=jobs.jobs.find(j=>j.name==='prepare');
  const review=jobs.jobs.find(j=>j.name==='review');
  const metrics=jobs.jobs.find(j=>j.name==='notify-metrics');
  if(prepare?.run_id!==s.run_id||prepare.status!=='completed'||
      prepare.conclusion!=='failure'||
      (prepare.run_attempt!==undefined&&prepare.run_attempt!==1)||
      review?.conclusion!=='skipped'||
      metrics?.conclusion!=='skipped'||
      !Array.isArray(prepare.steps)||
      prepare.steps.filter(j=>j.conclusion==='failure').length!==1||
      prepare.steps.filter(j=>j.conclusion==='failure')[0]?.name!==
        'Prepare the reviewer admission')
    fail('model-capable Reviewer ran or failed outside exact admission step');
  if(artifacts?.total_count!==0||artifacts.artifacts?.length!==0)
    fail('an untrusted Reviewer result Artifact exists');
  if(typeof jobLog!=='string'||jobLog.length<1||
      jobLog.length>1024*1024||
      !jobLog.includes('Reviewer admission prep: unsafe PR base file')||
      !jobLog.includes('Process completed with exit code 1.'))
    fail('no exact oversized immutable base-file pre-model log');
  return Object.freeze({verified:true,...s});
}
export async function verifyQwenReviewerBaseFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('independent GitHub reader token required');
  const base='https://api.github.com/repos/'+REPO;
  const get=async endpoint=>{
    const response=await fetchFn(base+endpoint,{headers:{
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
    if(!response.ok)fail('source read failed');
    return response;
  };
  const [run,jobs,artifacts,log]=await Promise.all([
    get('/actions/runs/'+SOURCE.run_id),
    get('/actions/runs/'+SOURCE.run_id+'/jobs?per_page=100'),
    get('/actions/runs/'+SOURCE.run_id+'/artifacts?per_page=100'),
    get('/actions/jobs/135250113142/logs'),
  ]);
  const bounded=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(bounded)&&bounded>1024*1024)
    fail('unbounded original Reviewer Job log');
  return attestQwenReviewerBaseFailure(await run.json(),await jobs.json(),
    await artifacts.json(),await log.text());
}
