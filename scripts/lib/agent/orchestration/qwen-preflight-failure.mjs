// #2817: one immutable, independently observed real pre-model failure.
// Never infer "no model called" from untrusted Issue text or a failed
// workflow conclusion alone. Read exact GitHub Run, step, artifact and log.
const REPO='BestNathan/nession';
export const SOURCE=Object.freeze({
  issue:2817,
  action_id:'61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3',
  run_id:42187623195,
  attempt:1,
  source_sha:'149df703ff383e7bb6958eb6d1448f6ad7248ca6',
  failure_code:'qwen_native_sealing_public_key_missing',
});
function fail(s){throw Error('trusted Qwen preflight recovery: '+s);}
export function verifyQwenPreflightFailure(run,jobs,artifacts,log){
  if(run?.id!==SOURCE.run_id||run.run_attempt!==1||
     run.head_sha!==SOURCE.source_sha||run.head_branch!=='main'||
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
     qwen.run_id!==run.id||qwen.run_attempt!==1||
     !Number.isSafeInteger(qwen.id)||qwen.id<1||
     others.some(x=>x.conclusion!=='skipped'))
    fail('Qwen failed before actual model execution not established');
  const step=name=>qwen.steps?.filter(x=>x.name===name);
  const passed=[
    'Checkout main-owned Qwen model-runner code only',
    'Require exact signed Qwen Store ACK before any model or source checkout'];
  if(passed.some(n=>step(n)?.length!==1||step(n)[0].conclusion!=='success'))
    fail('verified Store admission did not precede preflight');
  const failed='Validate pinned Qwen model, endpoint, public Session key and CLI version';
  if(step(failed)?.length!==1||step(failed)[0].conclusion!=='failure')
    fail('not the exact RSA-key preflight failure');
  if(qwen.steps.some(s=>
    ['Prepare disposable exact-SHA tracked source without executing it',
     'Execute Store-admitted Qwen CLI in unprivileged Docker',
     'Upload only bounded patch and encrypted native Session'].includes(s.name)&&
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
     !/^.*QWEN_RESUME_PUBLIC_KEY_B64:\s*$/m.test(log)||
     !log.includes('DECODER routines::unsupported')||
     !log.includes('Process completed with exit code 1'))
    fail('source logs do not independently prove the missing public key');
  return Object.freeze({verified:true,...SOURCE});
}
export async function verifyQwenPreflightFailureLive(token,fetchFn=fetch){
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
  const run=await get('/actions/runs/'+SOURCE.run_id);
  const jobs=await get('/actions/runs/'+SOURCE.run_id+'/jobs?per_page=100');
  const artifacts=await get('/actions/runs/'+SOURCE.run_id+'/artifacts?per_page=100');
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
  return verifyQwenPreflightFailure(run,jobs,artifacts,log);
}
