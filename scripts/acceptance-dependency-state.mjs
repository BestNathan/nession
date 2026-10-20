#!/usr/bin/env node
// One deterministic, fail-closed source of truth for the PR Acceptance
// dependency barrier. A waiting dependency MUST NOT pass a required gate.
// Successful source completions wake only the failed Acceptance run at the
// exact PR HEAD. Neither the model nor mutable Issue comments decide this.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const SHA=/^[a-f0-9]{40}$/;
const FINISHED=new Set(['success','failure','cancelled','timed_out','action_required','skipped','neutral']);
const ACTIVE=new Set(['queued','pending','in_progress','requested','waiting']);
export function classifyDependency(runs,sha) {
  if(!SHA.test(sha)||!Array.isArray(runs)||runs.length>20)throw Error('invalid source run window');
  if(!runs.length)return {state:'waiting',reason:'no_source_run'};
  const run=runs[0]; // gh run list is newest-first; never fall back to an older green run
  if(!Number.isSafeInteger(run?.databaseId)||run.databaseId<=0||
     typeof run.headSha!=='string'||!SHA.test(run.headSha)||
     run.event!=='pull_request'||typeof run.status!=='string')
    throw Error('untrusted source run identity');
  if(run.headSha!==sha)return {state:'superseded',reason:'foreign_sha',run_id:run.databaseId};
  if(ACTIVE.has(run.status)){
    if(run.conclusion!=null&&run.conclusion!=='')throw Error('in-progress run claims terminal verdict');
    return {state:'waiting',reason:'source_in_progress',run_id:run.databaseId};
  }
  if(run.status!=='completed'||!FINISHED.has(run.conclusion))
    throw Error('unknown source run state or conclusion');
  return {state:run.conclusion==='success'?'ready':'blocked',
    reason:run.conclusion,run_id:run.databaseId};
}
export function classifyPrDependencies(quality,e2e,sha) {
  const q=classifyDependency(quality,sha),e=classifyDependency(e2e,sha);
  const states=[q.state,e.state];
  const state=states.includes('superseded')?'superseded':
    states.includes('blocked')?'blocked':states.includes('waiting')?'waiting':'ready';
  return {state,quality:q,e2e:e};
}
function selfTest() {
  const sha='a'.repeat(40),other='b'.repeat(40);
  const good={databaseId:100,headSha:sha,event:'pull_request',status:'completed',conclusion:'success'};
  const failed={...good,databaseId:101,conclusion:'failure'};
  assert.equal(classifyPrDependencies([good],[good],sha).state,'ready');
  assert.equal(classifyPrDependencies([], [good],sha).state,'waiting');
  assert.equal(classifyPrDependencies([{...good,status:'in_progress',conclusion:null}], [good],sha).state,'waiting');
  assert.equal(classifyPrDependencies([failed],[good],sha).state,'blocked');
  assert.equal(classifyPrDependencies([good],[{...good,headSha:other}],sha).state,'superseded');
  assert.equal(classifyPrDependencies([failed,good],[good],sha).state,'blocked','old green must not override newest failure');
  assert.throws(()=>classifyPrDependencies([good,{...good}],[],other.repeat(2)),/invalid source/);
  for(const bogus of [
    {...good,event:'push'}, {...good,databaseId:0},{...good,status:'completed',conclusion:null},
    {...good,status:'in_progress',conclusion:'success'},{...good,status:'mystery'},
    {...good,headSha:'head'}
  ])assert.throws(()=>classifyDependency([bogus],sha));
  console.log('Acceptance dependency barrier: ready/waiting/blocked/superseded, newest-first, foreign identity and malformed-state negatives passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='classify') {
    const [qualityPath,e2ePath,sha]=process.argv.slice(3);
    if(!qualityPath||!e2ePath)throw Error('classify QUALITY_JSON E2E_JSON SHA');
    const result=classifyPrDependencies(JSON.parse(fs.readFileSync(qualityPath,'utf8')),
      JSON.parse(fs.readFileSync(e2ePath,'utf8')),sha);
    process.stdout.write(JSON.stringify(result)+'\n');
  }else throw Error('self-test | classify QUALITY_JSON E2E_JSON SHA');
}