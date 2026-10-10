'use strict';
// Read-only staging Case proof. All CI identities come from GitHub, never
// from unverifiable Issue prose or caller-supplied workflow status.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {runtimeFromEnv,verifyOnlineAgent}=require('../../../acceptance/shared/protocol-online-agent.js');
const repo=path.resolve(__dirname,'../../..');
const api='https://api.github.com/repos/BestNathan/nession';
async function get(endpoint){
  const r=await fetch(api+endpoint,{headers:{Accept:'application/vnd.github+json',
    'User-Agent':'nession-staging-continuity-case'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('GitHub source lookup unavailable '+r.status+' '+endpoint);
  return r.json();
}
async function liveContext(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target,/^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),target);
  assert.equal(process.env.GITHUB_REF_NAME,'staging','this verifier requires a real staging merged SHA');
  const parents=execFileSync('git',['rev-list','--parents','-n','1',target],{cwd:repo,encoding:'utf8'}).trim().split(' ');
  assert.equal(parents.length,3,'staging source must be a normal two-parent PR merge commit');
  const sourceHead=parents[2];
  assert.match(sourceHead,/^[a-f0-9]{40}$/);
  const runtime=runtimeFromEnv();
  assert.equal(runtime.target_sha,target);
  assert.equal(runtime.profile,'full-stack-local');
  assert.equal((await verifyOnlineAgent(runtime)).status,'pass');
  const web=await fetch(runtime.base_url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(web.status,200);
  const contract=process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256;
  assert.match(contract,/^[a-f0-9]{64}$/);
  return {target,sourceHead,contract,runtime};
}
async function sourceChecks(head){
  const d=await get('/actions/runs?head_sha='+head+'&per_page=100');
  const names=['Quality Gate','E2E Tests','Acceptance Case Smoke'];
  const matches={};
  for(const name of names){
    const chosen=d.workflow_runs.find(x=>x.name===name&&x.event==='pull_request'&&
      x.head_sha===head&&x.status==='completed'&&x.conclusion==='success');
    assert.ok(chosen,'exact PR source SHA missing successful '+name);
    matches[name]=chosen;
  }
  return matches;
}
async function artifact(run,name){
  const a=await get('/actions/runs/'+run.id+'/artifacts?per_page=50');
  const found=a.artifacts.find(x=>x.name===name&&!x.expired&&x.size_in_bytes>0);
  assert.ok(found,'real non-expired CI artifact missing: '+name);
  return found;
}
const historical={
  runId:37943938140,ingestId:37944246514,sha:'1e7b08f61e0204666891c7fdce34060966960769',
  path:'runs/2026-10-09/37943938140-1/1497/SC-04.json',
  blob:'f2b35bdc60265444af315522cf07baccb6fae4c5',
  casePath:'e2e/acceptance/cases/1497/SC-04',
};
async function canonicalIngest(){
  const [stored,source,ingest]=await Promise.all([
    get('/contents/'+historical.path+'?ref=acceptance-results'),
    get('/actions/runs/'+historical.runId),get('/actions/runs/'+historical.ingestId)
  ]);
  assert.equal(stored.sha,historical.blob);
  assert.equal(stored.encoding,'base64');
  const bytes=Buffer.from(stored.content.replace(/\s/g,''),'base64');
  const blob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  assert.equal(blob,historical.blob,'orphan Git blob changed');
  const record=JSON.parse(bytes.toString('utf8'));
  assert.equal(record.result,'Pass');
  assert.equal(record.issue,1497);
  assert.equal(record.criterion,'SC-04');
  assert.equal(record.stage,'staging');
  assert.equal(record.target_sha,historical.sha);
  assert.equal(record.provenance?.verified_source?.head_sha,source.head_sha);
  assert.equal(record.provenance?.verified_source?.run_id,source.id);
  assert.equal(source.conclusion,'success');
  assert.equal(source.head_sha,historical.sha);
  assert.equal(ingest.name,'Acceptance Case Ingest');
  assert.equal(ingest.event,'workflow_run');
  assert.equal(ingest.conclusion,'success');
  const commit=await get('/git/commits/'+historical.sha);
  const tree=await get('/git/trees/'+commit.tree.sha+'?recursive=1');
  assert.equal(tree.truncated,false);
  const entry=tree.tree.find(x=>x.path===historical.casePath&&x.type==='tree');
  assert.ok(entry);
  assert.equal(entry.sha,record.case_tree_sha,'untrusted Case path or tree digest');
  return {record,source,ingest,blob};
}
function report(summary,evidence){
  console.log(JSON.stringify({status:'pass',summary,evidence}));
}
function fail(e){
  const m=e instanceof Error?e.message:String(e);
  console.error(m);
  console.log(JSON.stringify({status:'fail',summary:m,evidence:[{type:'failure',value:'real CI/runtime or authenticated orphan proof unavailable'}]}));
  process.exitCode=1;
}
module.exports={repo,get,liveContext,sourceChecks,artifact,canonicalIngest,report,fail};
