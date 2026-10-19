'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../../../..');
try{
  const source=fs.readFileSync(path.join(root,'scripts/acceptance-quota-recovery.mjs'),'utf8');
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/acceptance-quota-recovery.yml'),'utf8');
  assert.match(workflow,/workflow_run:\s*\n\s+workflows: \["CI \/ Quality Gate"\]/);
  assert.match(workflow,/branches: \[main\]/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow,/github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow,/group: acceptance-quota-scan/);
  assert.match(source,/authorizeInvocation\(process\.env,api\)/);
  assert.match(source,/source\.run_attempt===attempt/);
  assert.match(source,/source\.path==='\.github\/workflows\/ci-quality\.yml'/);
  const t=spawnSync(process.execPath,['scripts/acceptance-quota-recovery.mjs','self-test'],
    {cwd:root,encoding:'utf8',timeout:90000,env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:''}});
  if(t.error)throw t.error;
  assert.equal(t.status,0,String(t.stderr||t.stdout).slice(-4500));
  assert.match(t.stdout,/source-attested event wake/);
  process.stdout.write(JSON.stringify({status:'pass',
    summary:"Authenticated CI main-push completion runs the same bounded scheduled recovery with exact source attestation.",
    evidence:[{type:'runtime',value:'Production recovery authorizer + workflow trigger + negative fixtures passed on checked-out exact target SHA'}]})+'\n');
}catch(e){
  process.stdout.write(JSON.stringify({status:'fail',summary:String(e),
    evidence:[{type:'runtime',value:'SC-01 trusted wake verification failed'}]})+'\n');
  process.exitCode=1;
}
