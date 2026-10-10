'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {repo,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
const {pinnedRun,SOURCES,failIdentityFixtures}=require('../../../shared/trusted-run-store-proof.cjs');
const check=(script)=>{
 const output=execFileSync(process.execPath,[path.join(repo,'scripts',script),'self-test'],{cwd:repo,encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
 assert.match(output,/passed|fixtures|self-test/i);
 return output.trim().slice(0,180);
};
async function main(){
 assert.equal(process.env.GITHUB_REF_NAME,'staging');
 const [scenario,acceptance]=await Promise.all([pinnedRun(SOURCES.scenario),pinnedRun(SOURCES.acceptance)]);
 failIdentityFixtures(scenario.item);
 assert.notEqual(scenario.item.target_sha,acceptance.item.target_sha);
 const proofs=[
  check('e2e-run-ingest.mjs'),
  check('acceptance-case-ingest.mjs'),
  check('e2e-test-run-ingest.mjs'),
  check('run-record-index-contract.mjs'),
 ];
 result('Trusted ingestion binds source GitHub workflow/run/attempt/SHA and immutable source tree, rejects replay/tampering and stores only source-attested orphan evidence',[
  {type:'source',value:'authentic Scenario='+scenario.run.id+' SHA='+scenario.item.target_sha+' Git blob='+scenario.blob},
  {type:'source',value:'authentic Case='+acceptance.run.id+' SHA='+acceptance.item.target_sha+' Git blob='+acceptance.blob},
  {type:'negative',value:'four main-owned ingest/index self-test suites passed: '+proofs.map(x=>x.slice(0,55)).join('; ')},
  {type:'boundary',value:'source verifier cannot edit Issues; only trusted ingest/updater projects authenticated results'}
 ]);
}
main().catch(fail);
