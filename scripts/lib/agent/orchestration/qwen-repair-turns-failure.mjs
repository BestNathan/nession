// #3885: exact, independently attested second-cycle #3784 native Qwen
// Repair exceeded the bounded 10-turn CLI limit AFTER authenticated Restore.
// This source is terminal: no accepted patch or v3 checkpoint can be inferred.
// Only trusted-main Controller may convert this into one new signed Action.
const REPO='BestNathan/nession';
export const SOURCE=Object.freeze({
  issue:3784,
  action_id:'5107e565bc70480fc49f726033d1185888b19f80d79a282eb53583d966d581e8',
  run_id:44470557905,attempt:1,
  source_sha:'51f82d64ec159397ea501e6cbb99e7039ee141bd',
  run_head_sha:'33caaf85ca93c53bb403a8994f7536650c76d47b',
  checkpoint_version:2,
  checkpoint_commit_sha:'5abbda5ec5bb7979b3990cc7fcc21295ab2be9c2',
  checkpoint_source_sha:'5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  checkpoint_source_run_id:44457696317,
  checkpoint_ciphertext_sha256:'adb6d2437f2de6b209f9df0b93cf6fb7950c26b561550a747189015e69e6c510',
  state_version:29,
  failure_code:'qwen_repair_native_max_turns_exhausted',
});
const ARTIFACTS=Object.freeze({
  ['development-worker-claim-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14503412956,size:1487,
    digest:'sha256:4d306f6adc8a1b06166e53aa26fd921e868bb5b39dd1cedaa0fc6b91df972573',
  }),
  ['development-qwen-transfer-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14503923166,size:250551,
    digest:'sha256:236c43bb922c3a25d77d0c61976271893f8e18d894d040bca7c54e8340b0830d',
  }),
  ['agent-telemetry-developer-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14503778718,size:797,
    digest:'sha256:1eab4608abf7922583b7d29944338e08f62ecc17c4b136169be20978fdec5009',
  }),
});
const jobsExpected={
  claim:'success','qwen-restore':'success','qwen-developer':'failure',
  restore:'skipped',developer:'skipped','wake-qwen-result':'skipped',
};
function fail(reason){throw Error('authenticated Qwen Repair turns failure: '+reason);}
export function verifyQwenRepairTurnsFailure(run,jobs,artifacts,log){
  const f=SOURCE;
  if(run?.id!==f.run_id||run.run_attempt!==1||
     run.head_sha!==f.run_head_sha||run.head_branch!=='main'||
     run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO||
     run.status!=='completed'||run.conclusion!=='failure')
    fail('unknown or untrusted native Repair source Run');
  if(jobs?.total_count!==6||jobs.jobs?.length!==6||
     Object.entries(jobsExpected).some(([name,conclusion])=>
       jobs.jobs.filter(j=>j.name===name&&j.status==='completed'&&
         j.conclusion===conclusion&&j.run_id===f.run_id&&
         j.run_attempt===1).length!==1))
    fail('wrong or ambiguous native Repair Job inventory');
  const worker=jobs.jobs.find(x=>x.name==='qwen-developer');
  if(worker.id!==135378976890)
    fail('wrong native Qwen model Job');
  const restore=jobs.jobs.find(x=>x.name==='qwen-restore');
  const steps=(job,name,conclusion)=>job.steps?.filter(s=>s.name===name&&
    s.conclusion===conclusion).length===1;
  if(!steps(restore,'Require exact signed resumed Qwen Worker Store ACK','success')||
     !steps(restore,
       'Rewrap immutable original native Qwen checkpoint without any writer token',
       'success')||
     !steps(restore,
       'Upload only authenticated recipient-bound Qwen ciphertext','success')||
     !steps(worker,
       'Require exact signed Qwen Store ACK before any model or source checkout','success')||
     !steps(worker,'Attest latest committed Qwen Reviewer Issue comment before Repair','success')||
     !steps(worker,'Restore Qwen native Session before Node model execution','success')||
     !steps(worker,'Execute Store-admitted Qwen Developer directly with Node.js','failure')||
     !steps(worker,'Upload canonical real Qwen Developer telemetry','success')||
     !steps(worker,'Upload only bounded patch and encrypted native Session','skipped')||
     !steps(worker,'Remove private transient restored Session and Issue data','success'))
    fail('not the signed Restore-success/model-failure boundary');
  if(artifacts?.total_count!==3||artifacts.artifacts?.length!==3||
     artifacts.artifacts.some(a=>{
       const expected=ARTIFACTS[a.name];
       return !expected||a.id!==expected.id||
         a.digest!==expected.digest||a.size_in_bytes!==expected.size||
         a.expired!==false||a.workflow_run?.id!==f.run_id||
         a.workflow_run?.head_sha!==f.run_head_sha;
     })||new Set(artifacts.artifacts.map(a=>a.name)).size!==3)
    fail('unexpected Result, missing transfer or forged Run artifact');
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
     !log.includes('subtype=error_max_turns, provider_result_error=true')||
     !log.includes('Qwen CLI failed (status=1, terminal=other')||
     !log.includes('stderr_category=model); raw model output withheld')||
     !log.includes('Process completed with exit code 1.'))
    fail('bounded sanitized max-turns CLI failure log not independently proven');
  return Object.freeze({verified:true,issue:f.issue,action_id:f.action_id,
    run_id:f.run_id,attempt:1,source_sha:f.source_sha,
    run_head_sha:f.run_head_sha,failure_code:f.failure_code});
}
export async function verifyQwenRepairTurnsFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('missing trusted read-only GitHub Actions token');
  const base='https://api.github.com/repos/'+REPO;
  const headers={Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json'};
  const request=async path=>{
    const response=await fetchFn(base+path,{headers});
    if(!response.ok)fail('failed Run proof unavailable '+response.status);
    return response;
  };
  const f=SOURCE;
  const [run,jobs,artifacts,log]=await Promise.all([
    request('/actions/runs/'+f.run_id),
    request('/actions/runs/'+f.run_id+'/jobs?per_page=100'),
    request('/actions/runs/'+f.run_id+'/artifacts?per_page=100'),
    request('/actions/jobs/135378976890/logs'),
  ]);
  const size=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(size)&&size>1024*1024)
    fail('unsafe unbounded GitHub Job log');
  return verifyQwenRepairTurnsFailure(await run.json(),await jobs.json(),
    await artifacts.json(),await log.text());
}
