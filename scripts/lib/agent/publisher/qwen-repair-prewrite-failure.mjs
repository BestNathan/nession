// #4046: exactly one source-attested Qwen Publisher failed before any
// GitHub write. Never treat a generic failed Publisher or Issue comment as
// license to reuse a committed write-ahead Intent.
export const SOURCE=Object.freeze({
  issue:3784,run_id:44476308903,run_attempt:1,
  head_sha:'b5588d85b2e3098e3507aa5bb5f0488e7f8bce59',
  source_ingest_run_id:44476225367,worker_run_id:44475622445,
  action_id:'133f50b3b250d1baf0bbc05c3f3b2aa652d9f9db13f1f35f961a91e704a0326f',
  source_sha:'51f82d64ec159397ea501e6cbb99e7039ee141bd',
  checkpoint_version:3,state_version:32,
  failure_code:'qwen_repair_chained_git_parent_prewrite_failure',
});
const REPO='BestNathan/nession';
function fail(s){throw Error('trusted Qwen pre-write Publisher failure: '+s);}
export function verifyQwenRepairPrewriteFailure(run,jobs,artifacts,log){
  const f=SOURCE;
  if(run?.id!==f.run_id||run.run_attempt!==1||
     run.name!=='Store / Qwen Publisher'||
     run.path!=='.github/workflows/store-qwen-publisher.yml'||
     run.event!=='workflow_dispatch'||run.head_branch!=='main'||
     run.head_sha!==f.head_sha||
     run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.status!=='completed'||run.conclusion!=='failure')
    fail('wrong signed main-only Publisher Run');
  if(jobs?.total_count!==4||jobs.jobs?.length!==4)
    fail('incomplete or additional GitHub Publisher Job inventory');
  const expected={detect:'success','reconcile-original':'skipped',
    publish:'failure','wake-reviewer':'skipped'};
  if(Object.entries(expected).some(([name,conclusion])=>
     jobs.jobs.filter(j=>j.name===name&&j.run_id===f.run_id&&
       j.run_attempt===1&&j.status==='completed'&&
       j.conclusion===conclusion).length!==1))
    fail('wrong real failed Publisher Job outcomes');
  const pub=jobs.jobs.find(x=>x.name==='publish');
  if(pub.id!==135397672702)
    fail('wrong signed Qwen Publisher Job identity');
  const step=(name,conclusion)=>pub.steps?.filter(s=>s.name===name&&
    s.conclusion===conclusion).length===1;
  if(!step('Validate signed Qwen/Store/Publisher negative contracts before secrets','success')||
     !step('Fetch exact trusted Ingest receipt and original Worker ZIPs','success')||
     !step('Checkout inert publication source strictly as Git data','success')||
     !step('Mint repository-scoped Store Writer App token outside model jobs','success')||
     !step('Mint separate Publisher GitHub App token','success')||
     !step('Authenticate original Qwen and publish/reconcile one real PR','failure')||
     !step('Publish bounded Developer v2 producer and Store writer receipt','skipped'))
    fail('Publisher did not fail at exact pre-write stage');
  if(artifacts?.total_count!==0||artifacts.artifacts?.length!==0)
    fail('Publisher wrote an unexpected result artifact');
  if(typeof log!=='string'||log.length<1||log.length>2*1024*1024||
     !log.includes('Qwen Repair PR update: original Qwen PR-A commit parent or tree was rewritten')||
     !log.includes('Process completed with exit code 1.'))
    fail('actual pre-write parent-check failure is not independently authenticated');
  // The pinned original Run SHA contains the named ancestry check BEFORE
  // the first git/blobs POST. A differently ordered code version is denied.
  return Object.freeze({verified:true,issue:f.issue,run_id:f.run_id,
    attempt:1,run_head_sha:f.head_sha,source_ingest_run_id:f.source_ingest_run_id,
    worker_run_id:f.worker_run_id,action_id:f.action_id,
    source_sha:f.source_sha,failure_code:f.failure_code});
}
export async function verifyQwenRepairPrewriteFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('missing read-only authenticated Actions token');
  const base='https://api.github.com/repos/'+REPO;
  const headers={Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json'};
  const request=async endpoint=>{
    const response=await fetchFn(base+endpoint,{headers});
    if(!response.ok)fail('live signed evidence unavailable '+response.status);
    return response;
  };
  const f=SOURCE;
  const [run,jobs,artifacts,log]=await Promise.all([
    request('/actions/runs/'+f.run_id),
    request('/actions/runs/'+f.run_id+'/jobs?per_page=100'),
    request('/actions/runs/'+f.run_id+'/artifacts?per_page=100'),
    request('/actions/jobs/135397672702/logs'),
  ]);
  const len=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(len)&&len>2*1024*1024)
    fail('unbounded Publisher log evidence');
  return verifyQwenRepairPrewriteFailure(await run.json(),await jobs.json(),
    await artifacts.json(),await log.text());
}

// #4046 follow-up: FIRST source-attested recovery ran against trusted main,
// wrote its distinct Store marker, and was denied by a read-only patch
// materialization mode check BEFORE any GitHub API call. It did not write C.
export const SECOND_SOURCE=Object.freeze({
  ...SOURCE,run_id:44495243036,run_attempt:1,
  head_sha:'68eb90ec61830d7db141c0cd6d42c1272ce4b26b',
  event:'issue_comment',actor:'BestNathan',
  publish_job_id:135460787782,
  failure_code:'qwen_repair_prewrite_materialize_readonly_mode_denied',
  previous_recovery_run_id:44495243036,
  previous_marker_path:
    'workflows/issues/3784/results/44476308903-1-5495ac9faf020fba834cf802d66087832848f664d11ffa3bdaf599b80b68ec16.json',
});
export function verifySecondQwenRepairPrewriteFailure(run,jobs,artifacts,log){
  const f=SECOND_SOURCE;
  if(run?.id!==f.run_id||run.run_attempt!==1||
     run.name!=='Store / Qwen Publisher'||
     run.path!=='.github/workflows/store-qwen-publisher.yml'||
     run.event!==f.event||run.head_branch!=='main'||
     run.head_sha!==f.head_sha||run.actor?.login!==f.actor||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.status!=='completed'||run.conclusion!=='failure')
    fail('wrong signed second main-only Publisher Run');
  if(jobs?.total_count!==4||jobs.jobs?.length!==4)
    fail('incomplete second signed Publisher Jobs');
  const expected={detect:'success','reconcile-original':'skipped',
    publish:'failure','wake-reviewer':'skipped'};
  if(Object.entries(expected).some(([name,conclusion])=>
     jobs.jobs.filter(j=>j.name===name&&j.run_id===f.run_id&&
       j.run_attempt===1&&j.status==='completed'&&
       j.conclusion===conclusion).length!==1))
    fail('wrong second Publisher Job identity or state');
  const pub=jobs.jobs.find(j=>j.name==='publish');
  const step=(name,conclusion)=>pub?.steps?.filter(s=>s.name===name&&
    s.conclusion===conclusion).length===1;
  if(pub?.id!==f.publish_job_id||
     !step('Validate signed Qwen/Store/Publisher negative contracts before secrets','success')||
     !step('Fetch exact trusted Ingest receipt and original Worker ZIPs','success')||
     !step('Checkout inert publication source strictly as Git data','success')||
     !step('Mint repository-scoped Store Writer App token outside model jobs','success')||
     !step('Mint separate Publisher GitHub App token','success')||
     !step('Authenticate original Qwen and publish/reconcile one real PR','failure')||
     !step('Publish bounded Developer v2 producer and Store writer receipt','skipped'))
    fail('second Publisher failed outside exact prewrite materialization');
  if(artifacts?.total_count!==0||artifacts.artifacts?.length!==0||
     typeof log!=='string'||log.length<1||log.length>2*1024*1024||
     !log.includes('Qwen Repair PR update: missing exact immutable Store-fenced Repair grant or manifest')||
     !log.includes('Process completed with exit code 1.'))
    fail('second exact read-only materialization error not authenticated');
  // The immutable main code at f.head_sha first calls materializeQwenRepairGitTree;
  // the local plan({write:false}) guard failed synchronously before any
  // network API GET/POST. The marker must also be verified from Store.
  return Object.freeze({verified:true,issue:f.issue,run_id:f.run_id,
    attempt:1,run_head_sha:f.head_sha,source_ingest_run_id:f.source_ingest_run_id,
    worker_run_id:f.worker_run_id,action_id:f.action_id,
    source_sha:f.source_sha,failure_code:f.failure_code,
    previous_marker_path:f.previous_marker_path,
    previous_recovery_run_id:f.previous_recovery_run_id});
}
export async function verifySecondQwenRepairPrewriteFailureLive(
  token,fetchFn=fetch,
){
  if(typeof token!=='string'||token.length<8)
    fail('missing read-only authenticated Actions token');
  const base='https://api.github.com/repos/'+REPO;
  const headers={Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json'};
  const request=async endpoint=>{
    const response=await fetchFn(base+endpoint,{headers});
    if(!response.ok)fail('second signed source unavailable '+response.status);
    return response;
  };
  const f=SECOND_SOURCE;
  const [run,jobs,artifacts,log]=await Promise.all([
    request('/actions/runs/'+f.run_id),
    request('/actions/runs/'+f.run_id+'/jobs?per_page=100'),
    request('/actions/runs/'+f.run_id+'/artifacts?per_page=100'),
    request('/actions/jobs/'+f.publish_job_id+'/logs'),
  ]);
  const len=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(len)&&len>2*1024*1024)
    fail('unbounded second Publisher job evidence');
  return verifySecondQwenRepairPrewriteFailure(await run.json(),
    await jobs.json(),await artifacts.json(),await log.text());
}
