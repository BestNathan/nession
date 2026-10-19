'use strict';
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../../../..');
const sc='SC-05';
try{
  const p=spawnSync(process.execPath,['scripts/acceptance-quota-parent-selftest.mjs',sc],
    {cwd:root,encoding:'utf8',timeout:90000,
      env:{...process.env,GITHUB_TOKEN:'',GH_TOKEN:''}});
  if(p.error)throw p.error;
  assert.equal(p.status,0,String(p.stderr||p.stdout).slice(-3500));
  const line=p.stdout.trim().split('\n').at(-1);
  const result=JSON.parse(line);
  assert.equal(result.status,'pass');
  process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){
  process.stdout.write(JSON.stringify({status:'fail',summary:String(e),
    evidence:[{type:'runtime',value:'Independent #1940 SC-05 verifier failed'}]})+'\n');
  process.exitCode=1;
}
