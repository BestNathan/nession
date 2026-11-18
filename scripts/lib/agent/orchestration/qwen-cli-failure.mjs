// #3885: exact, independently attested post-model Node Qwen CLI failure.
// This is NOT an automated retry of the failed Run and not a claim that a
// Provider did no work. Only the trusted Controller may consume the proof.
const REPO='BestNathan/nession';
export const SOURCE=Object.freeze({
  issue:3784,
  action_id:'11ecfaa5fe0cc391b31f1d3ec5ce89cdb833856ad484f940b9e720da33282d34',
  run_id:44250586057,attempt:1,
  source_sha:'76ed2d01195ad31ecdef97bc40ffa9f6d48427e6',
  run_head_sha:'9d6ea2c99e566389044f07ec1f0e9ed19ff46d9d',
  failure_code:'qwen_node_cli_invocation_failed',
});
const ARTIFACTS=Object.freeze({
  ['development-worker-claim-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14403737121,
    digest:'sha256:526927e63f8893443145bba623ada108a59adb855170c3a73af004cb14fb2dbe',
  }),
  ['agent-telemetry-developer-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14404126014,
    digest:'sha256:8e3b456a0a46f38e58d05435e425043fb612b57e236a85a6e764540a84a3016e',
  }),
});
function fail(s){throw Error('authenticated Qwen CLI failure: '+s);}
const requiredSuccess=[
  'Require exact signed Qwen Store ACK before any model or source checkout',
  'Validate pinned Qwen model, endpoint, public Session key and CLI version',
  'Prepare disposable exact-SHA tracked source without executing it',
  'Fetch only bounded read-only Issue context before Node model',
  'Install pinned Qwen Claude CLI on Node Runner',
  'Upload canonical real Qwen Developer telemetry',
  'Remove private transient restored Session and Issue data',
];
export function verifyQwenCliFailure(run,jobs,artifacts,log){
  const s=SOURCE;
  if(run?.id!==s.run_id||run.run_attempt!==1||
      run.head_sha!==s.run_head_sha||run.head_branch!=='main'||
      run.name!=='Agent / Development'||
      run.path!=='.github/workflows/agent-develop.yml'||
      run.event!=='workflow_dispatch'||run.status!=='completed'||
      run.conclusion!=='failure'||run.actor?.login!=='github-actions[bot]'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO)
    fail('original failed Worker Run identity changed');
  const expectedNames=['claim','qwen-developer','qwen-restore','restore',
    'developer','wake-qwen-result'];
  if(jobs?.total_count!==expectedNames.length||
      jobs.jobs?.length!==expectedNames.length||
      expectedNames.some(n=>jobs.jobs.filter(x=>x.name===n).length!==1))
    fail('incomplete or ambiguous failed Worker Job inventory');
  const claim=jobs.jobs.find(x=>x.name==='claim');
  const worker=jobs.jobs.find(x=>x.name==='qwen-developer');
  if(claim?.conclusion!=='success'||claim.status!=='completed'||
      worker?.id!==134620209710||worker.run_id!==s.run_id||
      worker.run_attempt!==1||worker.status!=='completed'||
      worker.conclusion!=='failure'||
      jobs.jobs.filter(x=>!['claim','qwen-developer'].includes(x.name))
        .some(x=>x.conclusion!=='skipped'))
    fail('source Worker Job is not uniquely identified as failed');
  const step=name=>worker.steps?.filter(x=>x.name===name);
  const done=(name,status)=>step(name)?.length===1&&
    step(name)[0].conclusion===status;
  if(requiredSuccess.some(n=>!done(n,'success'))||
      !done('Execute Store-admitted Qwen Developer directly with Node.js','failure')||
      !done('Upload only bounded patch and encrypted native Session','skipped'))
    fail('not the exact successful preflight and failed model CLI boundary');
  if(artifacts?.total_count!==2||artifacts.artifacts?.length!==2||
      artifacts.artifacts.some(a=>!Object.hasOwn(ARTIFACTS,a.name)||
        a.id!==ARTIFACTS[a.name].id||
        a.digest!==ARTIFACTS[a.name].digest||
        a.expired!==false||a.size_in_bytes<1||
        a.workflow_run?.id!==s.run_id||
        a.workflow_run?.head_sha!==s.run_head_sha))
    fail('unexpected missing, duplicate or unauthorized result Artifact');
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
      !log.includes('Qwen CLI failed; raw model output withheld')||
      !log.includes('Process completed with exit code 1.'))
    fail('failed CLI invocation log proof unavailable');
  return Object.freeze({verified:true,...s});
}
export async function verifyQwenCliFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('trusted read-only Actions token required');
  const base='https://api.github.com/repos/'+REPO;
  const request=async path=>{
    const r=await fetchFn(base+path,{headers:{
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
    if(!r.ok)fail('trusted GitHub read failed');
    return r;
  };
  const [run,jobs,artifacts,logResponse]=await Promise.all([
    request('/actions/runs/'+SOURCE.run_id),
    request('/actions/runs/'+SOURCE.run_id+'/jobs?per_page=100'),
    request('/actions/runs/'+SOURCE.run_id+'/artifacts?per_page=100'),
    request('/actions/jobs/134620209710/logs'),
  ]);
  const size=Number(logResponse.headers?.get?.('content-length'));
  if(Number.isFinite(size)&&size>1024*1024)
    fail('bounded Job log proof unavailable');
  const text=await logResponse.text();
  return verifyQwenCliFailure(await run.json(),await jobs.json(),
    await artifacts.json(),text);
}
