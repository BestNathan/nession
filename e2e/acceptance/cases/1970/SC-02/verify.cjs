'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../../../..');
try{
  const s=fs.readFileSync(path.join(root,'scripts/acceptance-quota-recovery.mjs'),'utf8');
  const begin=s.indexOf('for(const {run,pr} of selected)');
  const first=s.indexOf('recoverablePrepareJobs(jobs,run)',begin);
  const expensive=s.indexOf('for(const [file,name] of SOURCES)',begin);
  assert.ok(begin>=0&&first>begin&&expensive>first,
    'immutable failed-prepare authentication must precede CI/E2E queries');
  const run=spawnSync(process.execPath,['scripts/acceptance-quota-recovery.mjs','self-test'],{
    cwd:root,encoding:'utf8',timeout:90000,
    env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:''},
  });
  if(run.error)throw run.error;
  assert.equal(run.status,0,String(run.stderr||run.stdout).slice(-4000));
  assert.match(run.stdout,/finite API request budget/);
  assert.match(s,/assert\.deepEqual\(burstResult,\{candidates:3,retried:0,api_calls:5\}\)/);
  process.stdout.write(JSON.stringify({status:'pass',
    summary:"Canonical recovery negative fixtures still reject stale SHA/attempt, forged or downstream-gate evidence and quota-exhausted operations.",
    evidence:[{type:'runtime',value:'Canonical bounded recovery and exact-attempt negative fixtures executed on target SHA'}]})+'\n');
}catch(e){
  process.stdout.write(JSON.stringify({status:'fail',summary:String(e),
    evidence:[{type:'runtime',value:'SC-02 verified recovery fixture failed'}]})+'\n');
  process.exitCode=1;
}
