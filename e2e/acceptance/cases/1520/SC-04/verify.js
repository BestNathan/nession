'use strict';
// #1520 SC-04: observe real staging merge identity; never infer production release.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../../../..');
async function check(){
  const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(sha,/^[a-f0-9]{40}$/);
  const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  assert.equal(checkout,sha,'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'staging','not executing on real staging push');
  const parents=execFileSync('git',['show','-s','--format=%P','HEAD'],{cwd:repo,encoding:'utf8'}).trim().split(/\s+/);
  assert.equal(parents.length,2,'staging SHA must be normal two-parent PR merge commit');
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,sha,'Runtime did not start at staged SHA');
  assert.equal(runtime.profile,'full-stack-local');
  const url=String(runtime.base_url||'');
  assert.match(url,/^http:\/\/localhost:[0-9]+$/);
  const response=await fetch(url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200,'merged staging Web stack not serving');
  process.stdout.write(JSON.stringify({status:'pass',
    summary:'Normal two-parent staging merge commit runs isolated product Web at the exact SHA; production release is explicitly separate.',
    evidence:[
      {type:'git',value:'staging merge='+sha+' parent0='+parents[0]+' parent1='+parents[1]},
      {type:'runtime',value:'full-stack target_sha='+runtime.target_sha+' Web HTTP=200'},
      {type:'release-boundary',value:'staging verification only; main/prod deployment not asserted'},
    ]})+'\n');
}
check().catch(e=>{
  const m=e instanceof Error?e.message:String(e);
  process.stderr.write(m+'\n');
  process.stdout.write(JSON.stringify({status:'fail',summary:m,
    evidence:[{type:'runtime',value:'staging merge identity / live proof failed'}]})+'\n');
  process.exitCode=1;
});
