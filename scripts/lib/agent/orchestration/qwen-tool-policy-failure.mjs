// #3885: exact second Node Developer failure, after authenticated #3784
// first CLI failure recovery. The CLI completed with actual Read×7, Edit×1,
// Grep×1, but the old Source tool allowlist refused read-only Grep.
// No failed GitHub attempt may be rerun and no native Result existed.
export const SOURCE=Object.freeze({
  issue:3784,
  action_id:'3687526b2196cbad0db36ff935cc29a97f89d84e85494bdebe1c08503fa86549',
  run_id:44256663685,attempt:1,
  source_sha:'76ed2d01195ad31ecdef97bc40ffa9f6d48427e6',
  run_head_sha:'7f2e720db120790efd351fd5c08e674cc9928249',
  failure_code:'qwen_native_readonly_discovery_rejected',
});
const REPO='BestNathan/nession';
const ARTIFACTS=Object.freeze({
  ['development-worker-claim-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14406396956,
    digest:'sha256:50cef1cbb0b5b4eed518a6a8f61ec7524616e27a9a6af3990c517ae7bcb9eac2',
  }),
  ['agent-telemetry-developer-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14405618537,
    digest:'sha256:03196d3fc7fe549d40b8d151742a5d87a9fe2f884e5af0e4a7db876833ab157d',
  }),
});
function fail(s){throw Error('trusted Qwen readonly-tool recovery: '+s);}
const success=[
  'Require exact signed Qwen Store ACK before any model or source checkout',
  'Validate pinned Qwen model, endpoint, public Session key and CLI version',
  'Prepare disposable exact-SHA tracked source without executing it',
  'Fetch only bounded read-only Issue context before Node model',
  'Install pinned Qwen Claude CLI on Node Runner',
  'Upload canonical real Qwen Developer telemetry',
  'Remove private transient restored Session and Issue data',
];
export function verifyQwenToolPolicyFailure(run,jobs,artifacts,log){
  const s=SOURCE;
  if(run?.id!==s.run_id||run.run_attempt!==1||
      run.head_sha!==s.run_head_sha||run.head_branch!=='main'||
      run.path!=='.github/workflows/agent-develop.yml'||
      run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
      run.status!=='completed'||run.conclusion!=='failure'||
      run.actor?.login!=='github-actions[bot]'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO)
    fail('original Source Run identity differs from signed Store');
  const expected=['claim','qwen-developer','qwen-restore','restore',
    'developer','wake-qwen-result'];
  if(jobs?.total_count!==expected.length||
      jobs.jobs?.length!==expected.length||
      expected.some(n=>jobs.jobs.filter(x=>x.name===n).length!==1))
    fail('ambiguous original Worker Job set');
  const claim=jobs.jobs.find(x=>x.name==='claim');
  const worker=jobs.jobs.find(x=>x.name==='qwen-developer');
  if(claim?.conclusion!=='success'||claim.status!=='completed'||
      worker?.id!==134640077758||worker.run_id!==s.run_id||
      worker.run_attempt!==1||worker.status!=='completed'||
      worker.conclusion!=='failure'||
      jobs.jobs.filter(x=>!['claim','qwen-developer'].includes(x.name))
        .some(x=>x.conclusion!=='skipped'))
    fail('not the exact second failed Worker Job');
  const step=name=>worker.steps?.filter(x=>x.name===name);
  const completed=(name,outcome)=>step(name)?.length===1&&
    step(name)[0].conclusion===outcome;
  if(success.some(n=>!completed(n,'success'))||
      !completed('Execute Store-admitted Qwen Developer directly with Node.js','failure')||
      !completed('Upload only bounded patch and encrypted native Session','skipped'))
    fail('expected original read-only discovery rejection step missing');
  if(artifacts?.total_count!==2||artifacts.artifacts?.length!==2||
      new Set(artifacts.artifacts.map(a=>a.name)).size!==2||
      artifacts.artifacts.some(a=>!Object.hasOwn(ARTIFACTS,a.name)||
        a.id!==ARTIFACTS[a.name].id||
        a.digest!==ARTIFACTS[a.name].digest||
        a.expired!==false||a.size_in_bytes<1||
        a.workflow_run?.id!==s.run_id||
        a.workflow_run?.head_sha!==s.run_head_sha))
    fail('missing, duplicated or unauthorized result Artifact');
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
     !log.includes('Qwen Developer source: required actual restricted native Read/Edit evidence missing')||
     !log.includes('Process completed with exit code 1.'))
    fail('exact native tool policy rejection log unavailable');
  // Authenticated telemetry Artifact ZIP digest above pins the independently
  // observed Read×7 / Edit×1 / Grep×1 summary. Neither the model response nor
  // the Issue comment is accepted as authority for tool observations.
  return Object.freeze({verified:true,...s});
}
export async function verifyQwenToolPolicyFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)
    fail('trusted independent read-only Actions token required');
  const base='https://api.github.com/repos/'+REPO;
  const read=async path=>{
    const r=await fetchFn(base+path,{headers:{
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
    if(!r.ok)fail('GitHub source read failed');
    return r;
  };
  const [run,jobs,artifacts,log]=await Promise.all([
    read('/actions/runs/'+SOURCE.run_id),
    read('/actions/runs/'+SOURCE.run_id+'/jobs?per_page=100'),
    read('/actions/runs/'+SOURCE.run_id+'/artifacts?per_page=100'),
    read('/actions/jobs/134640077758/logs'),
  ]);
  const size=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(size)&&size>1024*1024)
    fail('original Job log exceeds safe bound');
  return verifyQwenToolPolicyFailure(await run.json(),await jobs.json(),
    await artifacts.json(),await log.text());
}
