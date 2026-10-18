'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../../..');
try{
  const source=fs.readFileSync(path.join(root,'scripts/acceptance-quota-recovery.mjs'),'utf8');
  assert.match(source,/recoverablePrepareJobs\(jobs,run\)/);
  assert.match(source,/MAX_REQUESTS=26/);
  assert.match(source,/run\.run_attempt\+'\/jobs\?per_page=100'/);
  const result=spawnSync(process.execPath,['scripts/acceptance-quota-recovery.mjs','self-test'],{
    cwd:root,encoding:'utf8',timeout:90000,
    env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:''},
  });
  if(result.error)throw result.error;
  assert.equal(result.status,0,String(result.stderr||result.stdout).slice(-5000));
  assert.match(result.stdout,/failed-prepare-only replay/);
  process.stdout.write(JSON.stringify({status:'pass',
    summary:"The canonical scheduled reconciliation now requires the exact attempt's failed prepare-pre-merge job before requesting a replay.",
    evidence:[{type:'runtime',value:'Canonical exact-head recovery and negative-fixture self-test passed on checked-out merged target SHA'}]})+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({status:'fail',summary:String(error),
    evidence:[{type:'runtime',value:'SC-01 failed-prepare proof failed'}]})+'\n');
  process.exitCode=1;
}
