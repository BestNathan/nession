'use strict';
// This source-aligned Case executes the canonical production routing test,
// including negative fixtures. It never reads token-bearing environment keys
// or treats absent evidence as Pass.
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root=path.resolve(__dirname,'../../../../..');
const target=path.join(root,'scripts','acceptance-postrun-waker-selftest.mjs');
function execute(){
  if(!fs.statSync(target).isFile())throw Error('canonical self-test missing');
  const result=spawnSync(process.execPath,[target,...[]],{
    cwd:root,encoding:'utf8',timeout:90000,
    env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''},
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('canonical self-test failed: '+String(result.stderr||result.stdout).slice(-4000));
  if(!/passed/.test(result.stdout))throw Error('canonical negative-fixture completion evidence missing');
  process.stdout.write(JSON.stringify({
    status:'pass',
    summary:'The real Post-Run Waker test exercises source-run authentication, main-only upstream subscription, exact SHA and negative attempt/branch/source identities.',
    evidence:[{type:'runtime',value:'acceptance-postrun-waker-selftest.mjs: successful production-route negative fixtures at exact checked-out target SHA'}],
  })+'\n');
}
try{execute()}catch(error){
  process.stdout.write(JSON.stringify({
    status:'fail',summary:String(error.message||error),
    evidence:[{type:'runtime',value:'SC-02 canonical routing/negative fixtures did not pass'}],
  })+'\n');
  process.exitCode=1;
}
