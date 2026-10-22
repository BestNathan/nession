'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../../../..');
try{
  const canonical=fs.readFileSync(path.join(root,'scripts/acceptance-quota-recovery.mjs'),'utf8');

  const test=spawnSync(process.execPath,['scripts/acceptance-quota-recovery.mjs','self-test'],{
    cwd:root,encoding:'utf8',timeout:90000,
    env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:''},
  });
  if(test.error)throw test.error;
  assert.equal(test.status,0,String(test.stderr||test.stdout).slice(-4000));
  assert.match(test.stdout,/bounded bursts passed/);
  process.stdout.write(JSON.stringify({status:'pass',
    summary:"The real bounded recovery selector verifies current PR/Run/attempt and two GitHub-attested exact-head source workflows before replay.",
    evidence:[{type:'runtime',value:'Canonical recovery self-test passed at checked-out exact target SHA; quota, stale-attempt and burst negative fixtures verified'}],
  })+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({status:'fail',summary:String(error),
    evidence:[{type:'runtime',value:'SC-01 trusted recovery test failed'}]})+'\n');
  process.exitCode=1;
}
