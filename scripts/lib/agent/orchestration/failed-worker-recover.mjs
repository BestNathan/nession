// Trusted exact failed-run recovery source verifier. No model-supplied fields.
export const CONTROLLED_FAILED_RUN=39267659650;
export const CONTROLLED_FAILED_SHA='b565469dd9c65e45ff0d7dbae37fb4a53424dc58';
const REPO='BestNathan/nession';
function deny(reason){throw Error('verified failure recovery: '+reason);}
export function verifyKnownFailure(run,jobs,artifacts) {
  if(run?.id!==CONTROLLED_FAILED_RUN||run?.run_attempt!==1||
    run?.head_sha!==CONTROLLED_FAILED_SHA||run?.head_branch!=='main'||
    run?.path!=='.github/workflows/agent-develop.yml'||
    run?.name!=='Agent / Development'||run?.event!=='workflow_dispatch'||
    run?.status!=='completed'||run?.conclusion!=='failure'||
    run?.actor?.login!=='github-actions[bot]'||
    run?.repository?.full_name!==REPO||
    run?.head_repository?.full_name!==REPO)deny('not the exact completed trusted Worker');
  if(jobs?.total_count!==1||jobs?.jobs?.length!==1)deny('ambiguous job list');
  const job=jobs.jobs[0];
  if(job.id!==118111376604||job.run_id!==run.id||job.run_attempt!==1||
    job.name!=='developer'||job.status!=='completed'||job.conclusion!=='failure')
    deny('invalid failed job identity');
  const step=name=>job.steps?.filter(s=>s.name===name);
  const passed=['Publish non-authoritative Worker Run claim before any model call',
    'Upload Worker claim for independent HMAC and Store reconciliation',
    'Require exact authenticated Run ID from immutable Store receipt',
    'Derive only the public RSA sealing key in isolated pre-model step',
    'Require pinned Cursor Provider and public-only Session sealing key'];
  if(passed.some(name=>step(name)?.length!==1||step(name)[0].conclusion!=='success'))
    deny('untrusted pre-model admission');
  const model=step('Execute authenticated bounded real Developer slice');
  if(model?.length!==1||model[0].conclusion!=='failure')deny('not the known model entry failure');
  if(job.steps?.some(s=>s.name==='Upload only encrypted native Session and bounded sanitized result'&&s.conclusion==='success'))
    deny('model result exists; never redeliver');
  const claim='development-worker-claim-'+run.id+'-1';
  if(artifacts?.total_count!==1||artifacts?.artifacts?.length!==1||
    artifacts.artifacts[0].name!==claim||
    artifacts.artifacts[0].expired!==false||
    artifacts.artifacts[0].workflow_run?.id!==run.id||
    artifacts.artifacts[0].workflow_run?.head_sha!==run.head_sha||
    !/^sha256:[a-f0-9]{64}$/.test(artifacts.artifacts[0].digest??''))
    deny('ambiguous or forged artifact evidence');
  return Object.freeze({verified:true,issue:1997,run_id:run.id,
    attempt:1,failure_code:'native_sdk_sandbox_unavailable'});
}
export async function verifyKnownFailureLive(token,fetchFn=fetch) {
  if(typeof token!=='string'||token.length<8)deny('missing independent Actions reader');
  const json=async path=>{
    const result=await fetchFn('https://api.github.com/repos/'+REPO+path,{
      headers:{Authorization:'Bearer '+token,
        Accept:'application/vnd.github+json'}});
    if(!result.ok)deny('GitHub proof request failed '+result.status);
    return result.json();
  };
  const run=await json('/actions/runs/'+CONTROLLED_FAILED_RUN);
  const jobs=await json('/actions/runs/'+CONTROLLED_FAILED_RUN+'/jobs?per_page=100');
  const artifacts=await json('/actions/runs/'+CONTROLLED_FAILED_RUN+'/artifacts?per_page=100');
  const verified=verifyKnownFailure(run,jobs,artifacts);
  const response=await fetchFn('https://api.github.com/repos/'+REPO+
    '/actions/jobs/118111376604/logs',{
    headers:{Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json'}});
  if(!response.ok)deny('source Worker log unavailable');
  const reportedSize=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(reportedSize)&&reportedSize>1024*1024)
    deny('source Worker log exceeds bound');
  const text=await response.text();
  if(text.length>1024*1024||
    !text.includes('Local SDK sandboxing was requested, but sandboxing is not supported in this environment.'))
    deny('source Worker did not fail with the independently observed SDK isolation incompatibility');
  return verified;
}
