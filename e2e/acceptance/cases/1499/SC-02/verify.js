'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('node:child_process');
const {pinnedRun,SOURCES,fetchJson,report,fail}=require('../../../shared/trusted-run-store-proof.cjs');
const root=path.resolve(__dirname,'../../../../..');
async function getIndex(endpoint){
  const f=await fetchJson('/contents/'+endpoint+'?ref=acceptance-results');
  assert.equal(f.encoding,'base64');
  return JSON.parse(Buffer.from(f.content.replace(/\s/g,''),'base64').toString('utf8'));
}
async function main(){
  const current=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),current);
  assert.equal(process.env.GITHUB_REF_NAME,'staging');
  const {makeRunIndex,selfTest}=await import(pathToFileURL(
    path.join(root,'scripts/run-record-index-contract.mjs')).href);
  selfTest(); // Four supported mode shapes, and negative tamper/cross-attempt fixtures.
  const scenario=await pinnedRun(SOURCES.scenario);
  const sIndex=await getIndex('indexes/by-sha/'+scenario.item.target_sha+'/scenario/'+
    scenario.item.run_id+'-'+scenario.item.run_attempt+'-terminal-attach-resume-1.json');
  assert.equal(makeRunIndex(sIndex).mode,'scenario');
  assert.equal(sIndex.record,SOURCES.scenario.path);
  const mainBranch=await fetchJson('/branches/main');
  const mainSha=mainBranch.commit.sha;
  assert.match(mainSha,/^[a-f0-9]{40}$/);
  const caseEntries=await fetchJson('/contents/indexes/by-sha/'+mainSha+
    '/acceptance?ref=acceptance-results');
  assert.ok(Array.isArray(caseEntries)&&caseEntries.length>0,
    'no real authenticated main Case index (SC-05 projection not yet persisted)');
  const candidate=caseEntries.find(x=>/-1499-SC-05\.json$/.test(x.name));
  assert.ok(candidate,'main source-SHA 1499/SC-05 Case index absent');
  const cIndex=await getIndex(candidate.path);
  assert.equal(makeRunIndex(cIndex).mode,'acceptance');
  assert.equal(cIndex.target_sha,mainSha);
  assert.equal(cIndex.issue,1499);
  assert.equal(cIndex.criterion,'SC-05');
  const source=await fetchJson('/actions/runs/'+cIndex.source.run_id);
  assert.equal(source.head_sha,mainSha);
  assert.equal(source.conclusion,'success');
  assert.equal(source.workflow_id,cIndex.source.workflow_id);
  assert.equal(cIndex.source.head_branch,'main');
  report('One immutable v1 orphan SHA-index envelope validates actual Scenario and main Case records; Test and Benchmark mode schemas also pass strict positive/negative fixtures.',[
    {type:'scenario',value:'run='+scenario.run.id+' immutable scenario index bound to source Git tree'},
    {type:'acceptance',value:'main_case_run='+source.id+' source_main_sha='+mainSha+' orphan_index='+candidate.name},
    {type:'schema',value:'v1 common source/run/attempt/SHA/record/execution contract for Test, Acceptance, Scenario, Benchmark (last two only where producers run)'},
    {type:'negative',value:'cross-run index paths, forged SHA, wrong stage and unsafe mode/suite rejected'},
  ]);
}
main().catch(fail);
