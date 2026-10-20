// Exact historical Cursor Resume lookup failure attestor (#2045).
// Pure source authentication; no Store write, no GitHub POST, no model access.
export const FAILED_RUN=39376331942;
export const FAILED_SHA='fdcfd3b6e40f891a7ef601c3539609113b2f4f5e';
export const FAILED_AGENT='agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6';
const REPO='BestNathan/nession';
const expectedJobs={claim:118475197901,restore:118475234505,developer:118475281078};
function deny(s){throw Error('native Resume recovery attestation: '+s);}
export function verifyNativeResumeFailure(run,jobs,artifacts,developerLog,storeHead){
  if(run?.id!==FAILED_RUN||run.run_attempt!==1||run.head_sha!==FAILED_SHA||
    run.head_branch!=='main'||run.path!=='.github/workflows/agent-develop.yml'||
    run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
    run.status!=='completed'||run.conclusion!=='failure'||
    run.actor?.login!=='github-actions[bot]'||
    run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO)
    deny('Run/commit identity or conclusive failure unverified');
  if(jobs?.total_count!==3||jobs.jobs?.length!==3||
    jobs.jobs.some(j=>expectedJobs[j.name]!==j.id||j.run_id!==run.id||
      j.run_attempt!==1||j.status!=='completed')||
    new Set(jobs.jobs.map(j=>j.name)).size!==3)
    deny('unexpected or incomplete Worker job topology');
  const claim=jobs.jobs.find(j=>j.name==='claim');
  const restore=jobs.jobs.find(j=>j.name==='restore');
  const developer=jobs.jobs.find(j=>j.name==='developer');
  if(claim.conclusion!=='success'||restore.conclusion!=='success'||
    developer.conclusion!=='failure')deny('untrusted job outcome');
  const required=(j,n)=>j.steps?.filter(x=>x.name===n);
  const succeeded=(j,n)=>required(j,n)?.length===1 && required(j,n)[0].conclusion==='success';
  for(const name of ['Publish non-authoritative Worker Run claim before any model call',
    'Upload Worker claim for independent HMAC and Store reconciliation'])
    if(!succeeded(claim,name))deny('authenticated claim stage missing');
  for(const name of ['Authenticate exact resumed Run from the committed Store',
    'Rewrap committed native checkpoint in trusted isolated process',
    'Upload encrypted native transfer for the same admitted Run'])
    if(!succeeded(restore,name))deny('authenticated v1 restore missing');
  for(const name of ['Require exact authenticated Run ID from immutable Store receipt',
    'Derive only the public RSA sealing key in isolated pre-model step',
    'Require pinned Cursor Provider and public-only Session sealing key',
    'Download only same-Run trusted encrypted native transfer',
    'Restore native bytes and synchronize live Issue before model'])
    if(!succeeded(developer,name))deny('authenticated Developer preflight missing');
  const executed=required(developer,'Execute real Developer in isolated Docker with no host credentials');
  if(executed?.length!==1||executed[0].conclusion!=='failure'||
    required(developer,'Upload only encrypted native Session and bounded sanitized result')?.[0]?.conclusion!=='skipped'||
    required(developer,'Upload canonical immutable Agent telemetry')?.[0]?.conclusion!=='skipped')
    deny('model output may exist; no recovery');
  // Immutable old provider cursor.mjs at FAILED_SHA invokes Agent.resume before
  // agent.send, so precisely this native lookup error denotes pre-send failure.
  // Reject partial/multiple/unbounded logs; a generic failed job is NOT enough.
  if(typeof developerLog!=='string'||developerLog.length>1024*1024||
    !developerLog.split('\n').some(line=>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ##\[error\]Agent agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6 not found\r?$/.test(line)))
    deny('exact native lookup-before-send error missing');
  if(artifacts?.total_count!==2||artifacts.artifacts?.length!==2)
    deny('ambiguous or missing historical artifacts');
  const names=['development-worker-claim-'+FAILED_RUN+'-1',
    'development-native-transfer-'+FAILED_RUN+'-1'];
  if(artifacts.artifacts.some(a=>!names.includes(a.name)||a.expired!==false||
    a.workflow_run?.id!==FAILED_RUN||a.workflow_run.head_sha!==FAILED_SHA||
    !/^sha256:[a-f0-9]{64}$/.test(a.digest??''))||
    new Set(artifacts.artifacts.map(a=>a.name)).size!==2)
    deny('native result/claim artifact inconsistent');
  // v1 HEAD must still be exact and v2 must be absent at the Store CAS read.
  if(storeHead?.version!==1||
    storeHead.checkpoint_path!=='roles/developer/dev-cursor-01/issues/1997/checkpoints/00000001.json'||
    storeHead.ciphertext_sha256!=='a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107')
    deny('native checkpoint advanced or differs from signed parent');
  return Object.freeze({verified:true,issue:1997,run_id:FAILED_RUN,attempt:1,
    failure_code:'native_cursor_agent_not_found_before_send'});
}

// This trusted Controller-only reader verifies a fresh GitHub API snapshot;
// the Store CAS writer must independently reread its own head before mutation.
export async function verifyNativeResumeFailureLive(token,fetchFn=fetch){
  if(typeof token!=='string'||token.length<8)deny('independent GitHub reader required');
  const request=async path=>{
    const r=await fetchFn('https://api.github.com/repos/'+REPO+path,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
    if(!r.ok)deny('GitHub proof request failed '+r.status);
    return r;
  };
  const json=async path=>(await request(path)).json();
  const run=await json('/actions/runs/'+FAILED_RUN);
  const jobs=await json('/actions/runs/'+FAILED_RUN+'/jobs?per_page=100');
  const artifacts=await json('/actions/runs/'+FAILED_RUN+'/artifacts?per_page=100');
  const text=await (await request('/actions/jobs/'+expectedJobs.developer+'/logs')).text();
  if(text.length>1024*1024)deny('historical log exceeds size bound');
  const record=await json('/contents/roles/developer/dev-cursor-01/issues/1997/head.json?ref=agent-store');
  if(record?.type!=='file'||record.encoding!=='base64'||typeof record.content!=='string'||
     record.size>8192)deny('untrusted native Store head response');
  const decoded=Buffer.from(record.content.replace(/\s/g,''),'base64');
  if(decoded.length>8192)deny('unbounded Store head');
  let head;
  try{head=JSON.parse(decoded.toString('utf8'));}catch{deny('unparseable Store head');}
  return verifyNativeResumeFailure(run,jobs,artifacts,text,head);
}
