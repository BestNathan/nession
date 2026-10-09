'use strict';
// A main *post-merge* Case supplies executable evidence for #1499 SC-05.
// Only the subsequent trusted Case Ingest + deterministic Issue updater may
// project the verdict; this verifier never calls GitHub Issue write APIs.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {verifyOnlineAgent,runtimeFromEnv}=require('../../../../../acceptance/shared/protocol-online-agent.js');
const root=path.resolve(__dirname,'../../../../..');

function mergeParents(sha){
  const raw=execFileSync('git',['cat-file','-p',sha],{cwd:root,encoding:'utf8'});
  const parents=raw.split('\n\n',1)[0].split('\n').filter(line=>line.startsWith('parent ')).map(line=>line.slice(7));
  assert.equal(parents.length,2,'main source must be a normal two-parent PR merge commit');
  for(const parent of parents)assert.match(parent,/^[a-f0-9]{40}$/);
  return parents;
}
function selfTest(){
  const sha='a'.repeat(40);
  assert.match(sha,/^[a-f0-9]{40}$/);
  assert.throws(()=>mergeParents('not-a-valid-SHA'),/fatal|Not a valid|bad object|Command failed/);
  console.log('main Case source identity negative fixture passed');
}
async function check(){
  const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(sha,/^[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_REF_NAME,'main','main post-merge Case cannot execute as staging acceptance');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sha);
  assert.ok(Number.isSafeInteger(Number(process.env.GITHUB_RUN_ID))&&Number(process.env.GITHUB_RUN_ID)>0);
  const parents=mergeParents(sha);
  const runtime=runtimeFromEnv();
  assert.equal(runtime.target_sha,sha);
  assert.equal(runtime.profile,'full-stack-local');
  assert.match(process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256||'',/^[0-9a-f]{64}$/);
  const caseTree=execFileSync('git',['rev-parse',sha+':e2e/acceptance/cases/1499/SC-05'],{
    cwd:root,encoding:'utf8',
  }).trim();
  assert.match(caseTree,/^[0-9a-f]{40}$/);
  const manifest=fs.readFileSync(path.join(__dirname,'case.yaml'),'utf8');
  assert.match(manifest,/stage: post-merge/);
  assert.match(manifest,/criterion: SC-05/);
  const trustedIngest=fs.readFileSync(path.join(root,'scripts/acceptance-case-ingest.mjs'),'utf8');
  assert.match(trustedIngest,/assertSourceBoundRecord/);
  assert.match(trustedIngest,/applyAcceptanceResultToBody/);
  const protocol=await verifyOnlineAgent(runtime);
  assert.equal(protocol.status,'pass');
  const response=await fetch(runtime.base_url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200);
  console.log(JSON.stringify({
    status:'pass',
    summary:'Real two-parent main merge SHA served isolated Server/Agent/Web; source-aligned Case and trusted projection path were verified. Actual SC projection must be attested separately by Case Ingest.',
    evidence:[
      {type:'git',value:'main_sha='+sha+' parents='+parents.join(',')+' case_tree='+caseTree},
      {type:'runtime',value:'real server.auth / agent.list and Web HTTP='+response.status},
      {type:'contract',value:'post-merge SC-05 contract_sha256='+process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256},
      {type:'trust',value:'main-controlled source-bound Case ingest and deterministic updater; no Issue write from source verifier'},
      {type:'boundary',value:'main source execution is not production VPN deployment or artifact retention proof'},
    ],
  }));
}
if(process.argv.includes('--self-test'))selfTest();
else check().catch(e=>{
  const m=e instanceof Error?e.message:String(e);
  console.error(m);
  console.log(JSON.stringify({status:'fail',summary:m,evidence:[
    {type:'git',value:'main merge identity, live runtime, or Case trust path failed'},
  ]}));
  process.exitCode=1;
});
