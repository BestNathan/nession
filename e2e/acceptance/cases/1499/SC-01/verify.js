'use strict';
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {runtimeFromEnv,verifyOnlineAgent}=require('../../../../../acceptance/shared/protocol-online-agent.js');
const {pinnedRun,SOURCES,fetchJson,failIdentityFixtures,report,fail}=require('../../../shared/trusted-run-store-proof.cjs');
const path=require('node:path');
const root=path.resolve(__dirname,'../../../../..');
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target);
  assert.equal(process.env.GITHUB_REF_NAME,'staging');
  const runtime=runtimeFromEnv();
  assert.equal(runtime.target_sha,target);
  const health=await verifyOnlineAgent(runtime);
  assert.equal(health.status,'pass');
  const [scenario,acceptance]=await Promise.all([
    pinnedRun(SOURCES.scenario),pinnedRun(SOURCES.acceptance)]);
  assert.equal(acceptance.item.result,'Pass');
  assert.equal(scenario.item.evaluation,null);
  failIdentityFixtures(scenario.item);
  const entry=await fetchJson('/contents/indexes/by-sha/'+scenario.item.target_sha+
    '/scenario/'+scenario.item.run_id+'-'+scenario.item.run_attempt+
    '-terminal-attach-resume-'+scenario.item.run_index+'.json?ref=acceptance-results');
  assert.equal(entry.encoding,'base64');
  const index=JSON.parse(Buffer.from(entry.content.replace(/\s/g,''),'base64').toString('utf8'));
  assert.equal(index.mode,'scenario');
  assert.equal(index.source.original_sha256,scenario.source.original_sha256);
  assert.equal(index.record,SOURCES.scenario.path);
  assert.equal(index.execution_id,scenario.item.execution_id);
  report('Real source Case and Scenario orphan blobs independently bound to GitHub-owned run, SHA and immutable Git tree, with a live staging Agent.',[
    {type:'source',value:'scenario run='+scenario.run.id+' SHA='+scenario.item.target_sha+' Git blob='+SOURCES.scenario.blob},
    {type:'source',value:'Case run='+acceptance.run.id+' SHA='+acceptance.item.target_sha+' Git blob='+SOURCES.acceptance.blob},
    {type:'tree',value:'both source Git commit Case/Scenario trees matched immutable record digests'},
    {type:'negative',value:'rejected wrong run identity, short source SHA and invalid contract digest'},
    {type:'runtime',value:'real staging Server/Agent on target='+target},
  ]);
}
main().catch(fail);
