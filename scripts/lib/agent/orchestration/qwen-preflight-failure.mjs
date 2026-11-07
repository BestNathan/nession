// #2817: immutable, independently observed real pre-model failures.
// Never infer "no model called" from untrusted Issue text or a failed
// workflow conclusion alone. Read exact GitHub Run, attempt, step, artifact
// and log. Each source is one exact failure; generalizing requires new
// evidence and a new bounded recovery slice.
const REPO='BestNathan/nession';
export const SOURCE=Object.freeze({
  issue:2817,
  action_id:'61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3',
  run_id:42187623195,
  attempt:1,
  source_sha:'149df703ff383e7bb6958eb6d1448f6ad7248ca6',
  failure_code:'qwen_native_sealing_public_key_missing',
});
// The second exact pre-model failure: the dedicated Restore private key was
// absent on current main after the first successor was dispatched. The Run
// head is the workflow code SHA, while source_sha remains the admitted task
// SHA from the signed Outbox action.
export const SOURCE_V2=Object.freeze({
  issue:2817,
  action_id:'0ca813917a26c699af111593b3b3b855ea70d65bca447b78b33031a966f84ec4',
  run_id:42339656510,
  attempt:1,
  source_sha:'149df703ff383e7bb6958eb6d1448f6ad7248ca6',
  run_head_sha:'5cabd47497cffc1571af18ac4900646363f40f33',
  failure_code:'qwen_native_restore_private_key_missing',
});
const PASSED_STEPS=[
  'Checkout main-owned Qwen model-runner code only',
  'Require exact signed Qwen Store ACK before any model or source checkout'];
const FAILED_STEP=
  'Validate pinned Qwen model, endpoint, public Session key and CLI version';
const BLOCKED_STEPS=[
  'Prepare disposable exact-SHA tracked source without executing it',
  'Execute Store-admitted Qwen CLI in unprivileged Docker',
  'Upload only bounded patch and encrypted native Session'];
const LOG_PROOF={
  [SOURCE.failure_code]:log=>
    /^.*QWEN_RESUME_PUBLIC_KEY_B64:\s*$/m.test(log)&&
    log.includes('DECODER routines::unsupported')&&
    log.includes('Process completed with exit code 1'),
  [SOURCE_V2.failure_code]:log=>
    /^.*QWEN_RESUME_PRIVATE_KEY_B64:\s*$/m.test(log)&&
    log.includes('Qwen native Restore private key is not configured')&&
    log.includes('Process completed with exit code 1'),
};
const LOG_ERROR={
  [SOURCE.failure_code]:
    'source logs do not independently prove the missing public key',
  [SOURCE_V2.failure_code]:
    'source logs do not independently prove the missing private key',
};
const RUN_ROUTE={
  [SOURCE.failure_code]:id=>'/actions/runs/'+id,
  [SOURCE_V2.failure_code]:id=>
    '/actions/runs/'+id+'/attempts/'+SOURCE_V2.attempt,
};
const JOBS_ROUTE={
  [SOURCE.failure_code]:id=>'/actions/runs/'+id+'/jobs?per_page=100',
  [SOURCE_V2.failure_code]:id=>
    '/actions/runs/'+id+'/attempts/'+SOURCE_V2.attempt+'/jobs?per_page=100',
};
function fail(s){throw Error('trusted Qwen preflight recovery: '+s);}
function verifyFailure(source,run,jobs,artifacts,log){
  const expectedHead=source.run_head_sha??source.source_sha;
  if(run?.id!==source.run_id||run.run_attempt!==source.attempt||
     run.head_sha!==expectedHead||run.head_branch!=='main'||
     run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||
     run.event!=='workflow_dispatch'||run.status!=='completed'||
     run.conclusion!=='failure'||run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO)
    fail('Run identity is not the authenticated original Qwen failure');
  if(jobs?.total_count!==5||jobs.jobs?.length!==5)
    fail('ambiguous source Job set');
  const names=['claim','qwen-developer','qwen-restore','restore','developer'];
  if(names.some(n=>jobs.jobs.filter(x=>x.name===n).length!==1))
    fail('unexpected source Job identities');
  const claim=jobs.jobs.find(x=>x.name==='claim');
  const qwen=jobs.jobs.find(x=>x.name==='qwen-developer');
  const others=jobs.jobs.filter(x=>!['claim','qwen-developer'].includes(x.name));
  if(claim?.status!=='completed'||claim.conclusion!=='success'||
     qwen?.status!=='completed'||qwen.conclusion!=='failure'||
     qwen.run_id!==run.id||qwen.run_attempt!==source.attempt||
     !Number.isSafeInteger(qwen.id)||qwen.id<1||
     others.some(x=>x.conclusion!=='skipped'))
    fail('Qwen failed before actual model execution not established');
  const step=name=>qwen.steps?.filter(x=>x.name===name);
  if(PASSED_STEPS.some(n=>step(n)?.length!==1||
      step(n)[0].conclusion!=='success'))
    fail('verified Store admission did not precede preflight');
  if(step(FAILED_STEP)?.length!==1||
      step(FAILED_STEP)[0].conclusion!=='failure')
    fail('not the exact Qwen key preflight failure');
  if(qwen.steps.some(s=>BLOCKED_STEPS.includes(s.name)&&
      s.conclusion!=='skipped'))
    fail('model or native Store candidate may have been executed');
  const expected='development-worker-claim-'+run.id+'-1';
  if(artifacts?.total_count!==1||artifacts.artifacts?.length!==1||
     artifacts.artifacts[0].name!==expected||
     artifacts.artifacts[0].expired!==false||
     artifacts.artifacts[0].workflow_run?.id!==run.id||
     artifacts.artifacts[0].workflow_run?.head_sha!==run.head_sha||
     !/^sha256:[a-f0-9]{64}$/.test(artifacts.artifacts[0].digest??''))
    fail('missing unique verified claim or native result exists');
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
     LOG_PROOF[source.failure_code]?.(log)!==true)
    fail(LOG_ERROR[source.failure_code]);
  return Object.freeze({verified:true,...source});
}
export function verifyQwenPreflightFailure(run,jobs,artifacts,log){
  return verifyFailure(SOURCE,run,jobs,artifacts,log);
}
export function verifyQwenPreflightFailureV2(run,jobs,artifacts,log){
  return verifyFailure(SOURCE_V2,run,jobs,artifacts,log);
}
async function verifyLive(source,token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('missing independent GitHub Actions read credential');
  const base='https://api.github.com/repos/'+REPO;
  const get=async route=>{
    const response=await fetchFn(base+route,{
      headers:{Authorization:'Bearer '+token,
        Accept:'application/vnd.github+json'}});
    if(!response.ok)fail('GitHub source read error '+response.status);
    return response.json();
  };
  const run=await get(RUN_ROUTE[source.failure_code](source.run_id));
  const jobs=await get(JOBS_ROUTE[source.failure_code](source.run_id));
  const artifacts=await get('/actions/runs/'+source.run_id+'/artifacts?per_page=100');
  const candidate=jobs.jobs?.filter(x=>x.name==='qwen-developer')??[];
  if(candidate.length!==1||!Number.isSafeInteger(candidate[0].id)||
     candidate[0].id<1)fail('missing exact failed Qwen Job');
  const response=await fetchFn(base+'/actions/jobs/'+candidate[0].id+'/logs',{
    headers:{Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json'}});
  if(!response.ok)fail('source Qwen Job log unavailable');
  const size=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(size)&&size>1024*1024)
    fail('failed Job log too large');
  const log=await response.text();
  return verifyFailure(source,run,jobs,artifacts,log);
}
export function verifyQwenPreflightFailureLive(token,fetchFn=fetch){
  return verifyLive(SOURCE,token,fetchFn);
}
export function verifyQwenPreflightFailureV2Live(token,fetchFn=fetch){
  return verifyLive(SOURCE_V2,token,fetchFn);
}
