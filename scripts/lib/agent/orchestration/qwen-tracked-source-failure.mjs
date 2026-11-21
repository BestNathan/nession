// #4174: independently attest ONE real completed native Qwen Source Gate
// failure. This is not an instruction from the model, a retry, or permission
// to accept its rejected worktree. No raw model text is exposed.
export const SOURCE=Object.freeze({
  issue:4065,
  action_id:'f085d5919b3277e4fb68d49f48f9a311a83ad5032a90ec651aba93392888eb44',
  run_id:44733719096,attempt:1,
  source_sha:'8b7777f48a577d01961fd7d9e75311f75d6d57a1',
  run_head_sha:'8b7777f48a577d01961fd7d9e75311f75d6d57a1',
  failure_code:'qwen_tracked_source_gate_rejected',
});
const REPO='BestNathan/nession';
const JOB_ID=136279796177;
const ARTIFACTS=Object.freeze({
  ['development-worker-claim-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14627851470,digest:'sha256:20a4679663ea9afc518a1713c3497e5f1c7bc0a0675a39540ed55955681e605f',
  }),
  ['agent-telemetry-developer-'+SOURCE.run_id+'-1']:Object.freeze({
    id:14628061648,digest:'sha256:f99942cf43be5a94b0ded8e39090a9a25dd506ee2143381246cb64a6dade40e1',
  }),
});
function fail(why){throw Error('trusted Qwen tracked-source recovery: '+why);}
export function verifyQwenTrackedSourceFailure(run,jobs,artifacts,log) {
  const s=SOURCE;
  if(run?.id!==s.run_id||run.run_attempt!==1||
     run.head_sha!==s.run_head_sha||run.head_branch!=='main'||
     run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.status!=='completed'||run.conclusion!=='failure'||
     run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO)
    fail('exact original failed Run identity unavailable');
  const expected=['claim','qwen-developer','qwen-restore','restore',
    'developer','wake-qwen-result'];
  if(!jobs||jobs.total_count!==expected.length||
     jobs.jobs?.length!==expected.length||
     expected.some(n=>jobs.jobs.filter(x=>x.name===n).length!==1))
    fail('incomplete original Worker Job set');
  const claim=jobs.jobs.find(x=>x.name==='claim');
  const worker=jobs.jobs.find(x=>x.name==='qwen-developer');
  if(claim.status!=='completed'||claim.conclusion!=='success'||
     worker?.id!==JOB_ID||worker.run_id!==s.run_id||
     worker.run_attempt!==1||worker.status!=='completed'||
     worker.conclusion!=='failure'||
     jobs.jobs.filter(x=>!['claim','qwen-developer'].includes(x.name))
       .some(x=>x.conclusion!=='skipped'))
    fail('Worker failed at a different boundary');
  const step=(name,outcome)=>worker.steps?.filter(x=>
    x.name===name&&x.status==='completed'&&x.conclusion===outcome).length===1 &&
    worker.steps.filter(x=>x.name===name).length===1;
  for(const name of [
    'Require exact signed Qwen Store ACK before any model or source checkout',
    'Validate pinned Qwen model, endpoint, public Session key and CLI version',
    'Prepare disposable exact-SHA tracked source without executing it',
    'Fetch only bounded read-only Issue context before Node model',
    'Install pinned Qwen Claude CLI on Node Runner',
    'Upload canonical real Qwen Developer telemetry',
    'Remove private transient restored Session and Issue data',
  ])if(!step(name,'success'))fail('required original preflight/cleanup step absent');
  if(!step('Execute Store-admitted Qwen Developer directly with Node.js','failure')||
     !step('Upload only bounded patch and encrypted native Session','skipped'))
    fail('not a rejected final native Developer proposal');
  if(artifacts?.total_count!==2||artifacts.artifacts?.length!==2||
     new Set(artifacts.artifacts.map(x=>x.name)).size!==2||
     artifacts.artifacts.some(a=>
       !Object.hasOwn(ARTIFACTS,a.name)||
       a.id!==ARTIFACTS[a.name].id||
       a.digest!==ARTIFACTS[a.name].digest||
       a.expired!==false||a.size_in_bytes<1||
       a.workflow_run?.id!==s.run_id||
       a.workflow_run?.head_sha!==s.run_head_sha))
    fail('source Artifact digest/identity mismatch or accepted patch exists');
  if(typeof log!=='string'||log.length<1||log.length>1024*1024||
     !log.includes('Qwen Developer source: untracked, index, rename or delete change prohibited')||
     !log.includes('Process completed with exit code 1.'))
    fail('required original final Source Gate failure not found');
  return Object.freeze({verified:true,...s});
}
export async function verifyQwenTrackedSourceFailureLive(token,request=fetch) {
  if(typeof token!=='string'||token.length<8)
    fail('trusted read-only GitHub token required');
  const base='https://api.github.com/repos/'+REPO;
  const read=async p=>{
    const r=await request(base+p,{headers:{
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'}});
    if(!r.ok)fail('GitHub Actions source unavailable');
    return r;
  };
  const [run,jobs,artifacts,log]=await Promise.all([
    read('/actions/runs/'+SOURCE.run_id),
    read('/actions/runs/'+SOURCE.run_id+'/jobs?per_page=100'),
    read('/actions/runs/'+SOURCE.run_id+'/artifacts?per_page=100'),
    read('/actions/jobs/'+JOB_ID+'/logs'),
  ]);
  const length=Number(log.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>1024*1024)
    fail('original Job log exceeds bounded size');
  return verifyQwenTrackedSourceFailure(await run.json(),await jobs.json(),
    await artifacts.json(),await log.text());
}
