// Exact #1997 published-PR native Repair failure attestor. No model, writer,
// Store mutation or automatic replay. A model MAY have been called: only
// accepted result/checkpoint/PR side effects are known to be absent.
const REPO='BestNathan/nession';
const RUN=42020432271;
const SOURCE_SHA='d0dfdfe98e2d61bd37b5c64bf1d4bed19a3dfa40';
const EXPECTED_JOBS={claim:127221529476,restore:127221604872,
  developer:127221738966};
const EXPECTED_ARTIFACTS=new Map([
  ['development-worker-claim-42020432271-1',
   'sha256:4529b6b0271bdd78844b306dd3fd602258838387972c2ade7530c4fdd6285492'],
  ['development-native-transfer-42020432271-1',
   'sha256:32c7fcf77fd27c57fbfdcfcd72ecf70552b7f2690e04328dcbf0aee503d0f167'],
]);
const FAILURE='cursor_native_read_missing_uncommitted';
function fail(s){throw Error('trusted Repair failure attestation: '+s);}
function step(job,name,status){
  const items=job?.steps?.filter(s=>s.name===name);
  if(items?.length!==1||items[0].conclusion!==status)fail('expected exact '+name+' stage '+status);
}
export function verifyControlledRepairRuntimeFailure(run,jobs,artifacts,developerLog){
  if(run?.id!==RUN||run.run_attempt!==1||run.head_sha!==SOURCE_SHA||
     run.head_branch!=='main'||run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.status!=='completed'||run.conclusion!=='failure'||
     run.actor?.login!=='github-actions[bot]'||
     run.repository?.full_name!==REPO||
     run.head_repository?.full_name!==REPO)
    fail('not the immutable failed Developer workflow Run');
  if(jobs?.total_count!==3||jobs.jobs?.length!==3||
     new Set(jobs.jobs.map(j=>j.name)).size!==3||
     jobs.jobs.some(j=>EXPECTED_JOBS[j.name]!==j.id||
       j.run_id!==RUN||
       (j.run_attempt!=null&&j.run_attempt!==1)||
       j.status!=='completed'))
    fail('untrusted Worker job topology');
  const claim=jobs.jobs.find(j=>j.name==='claim');
  const restore=jobs.jobs.find(j=>j.name==='restore');
  const developer=jobs.jobs.find(j=>j.name==='developer');
  if(claim?.conclusion!=='success'||restore?.conclusion!=='success'||
     developer?.conclusion!=='failure')
    fail('missing Claim/Restore success or exact terminal Developer failure');
  for(const name of [
    'Publish non-authoritative Worker Run claim before any model call',
    'Upload Worker claim for independent HMAC and Store reconciliation',
  ])step(claim,name,'success');
  for(const name of [
    'Authenticate exact resumed Run from the committed Store',
    'Rewrap committed native checkpoint in trusted isolated process',
    'Upload encrypted native transfer for the same admitted Run',
  ])step(restore,name,'success');
  for(const name of [
    'Require exact authenticated Run ID from immutable Store receipt',
    'Derive only the public RSA sealing key in isolated pre-model step',
    'Require pinned Cursor Provider and public-only Session sealing key',
    'Download only same-Run trusted encrypted native transfer',
    'Restore native bytes and synchronize live Issue before model',
    'Stage only the exact authenticated published PR Git tree for Repair',
  ])step(developer,name,'success');
  step(developer,'Execute real Developer in isolated Docker with no host credentials','failure');
  step(developer,'Upload canonical immutable Agent telemetry','skipped');
  step(developer,'Upload only encrypted native Session and bounded sanitized result','skipped');
  if(artifacts?.total_count!==2||artifacts.artifacts?.length!==2||
     new Set(artifacts.artifacts.map(a=>a.name)).size!==2||
     artifacts.artifacts.some(a=>EXPECTED_ARTIFACTS.get(a.name)!==a.digest||
       a.expired!==false||a.workflow_run?.id!==RUN||
       a.workflow_run?.head_sha!==SOURCE_SHA))
    fail('untrusted claim/transfer artifacts or accepted model result exists');
  if(typeof developerLog!=='string'||developerLog.length>1024*1024||
     !developerLog.split('\n').some(line=>
       /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ##\[error\]bounded Developer: real native read\/edit Provider outcome missing\r?$/.test(line)))
    fail('exact bounded no-result error is absent');
  // The SDK reported Ripgrep errors, but they may be nonfatal, and the
  // Provider could have been invoked. Preserve that uncertainty forever.
  return Object.freeze({verified:true,issue:1997,run_id:RUN,attempt:1,
    failure_code:FAILURE});
}
export async function verifyControlledRepairRuntimeFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)fail('independent GitHub API token required');
  const request=async suffix=>{
    const response=await fetchFn('https://api.github.com/repos/'+REPO+suffix,{
      headers:{Authorization:'Bearer '+token,
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'}});
    if(!response.ok)fail('GitHub API proof read '+response.status);
    return response;
  };
  const json=async suffix=>(await request(suffix)).json();
  const run=await json('/actions/runs/'+RUN);
  const jobs=await json('/actions/runs/'+RUN+'/jobs?per_page=100');
  const artifacts=await json('/actions/runs/'+RUN+'/artifacts?per_page=100');
  const log=await (await request('/actions/jobs/'+EXPECTED_JOBS.developer+'/logs')).text();
  return verifyControlledRepairRuntimeFailure(run,jobs,artifacts,log);
}
