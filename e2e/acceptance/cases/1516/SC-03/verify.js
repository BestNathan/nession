'use strict';
// #1516 SC-03: verify real canonical Issue/SC execution boundary.
// Trust of the resulting record is independently enforced by the main ingest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../../../..');
async function check() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(sha, /^[a-f0-9]{40}$/, 'authenticated exact SHA required');
  assert.equal(execFileSync('git', ['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sha,
    'source SHA differs from checked out runtime');
  assert.equal(fs.existsSync(path.join(repo,'acceptance','cases')),false,
    'noncanonical duplicate Case source exists');
  const selftest = execFileSync(process.execPath,['scripts/acceptance-cases-selftest.mjs'],
    {cwd:repo,encoding:'utf8',timeout:15000});
  assert.match(selftest,/acceptance Case self-test: [0-9]+ cases passed/);
  const out=JSON.parse(execFileSync(process.execPath,['e2e/run','--validate'],{
    cwd:repo,encoding:'utf8',timeout:10000}));
  assert.equal(out.layout,'canonical');
  assert.ok(out.case_count>=13,'missing migrated Cases');
  const casePath='e2e/acceptance/cases/1516/SC-03';
  const caseTree=execFileSync('git',['rev-parse',sha+':'+casePath],{
    cwd:repo,encoding:'utf8'}).trim();
  assert.match(caseTree,/^[a-f0-9]{40}$/,'source Case tree absent');
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,sha);
  assert.equal(runtime.profile,'full-stack-local');
  const site=String(runtime.base_url || '');
  assert.match(site,/^http:\/\/localhost:[0-9]+$/,'not isolated production Web');
  const page=await fetch(site+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(page.status,200,'real full-stack Web not serving');
  process.stdout.write(JSON.stringify({status:'pass',
    summary:'The exact staged SHA owns the unique canonical Case tree and starts a working shared full stack.',
    evidence:[
      {type:'case-tree',value:casePath+' tree_sha='+caseTree},
      {type:'runtime',value:'exact_sha='+sha+' shared full-stack Web HTTP=200'},
      {type:'test',value:'trusted Case schema/source discovery '+out.case_count+' Cases; deterministic self-test passed'},
    ]})+'\n');
}
check().catch(e=>{
  const m=e instanceof Error?e.message:String(e);
  process.stderr.write(m+'\n');
  process.stdout.write(JSON.stringify({status:'fail',summary:m,
    evidence:[{type:'runtime',value:'canonical source Case migration proof failed'}]})+'\n');
  process.exitCode=1;
});
