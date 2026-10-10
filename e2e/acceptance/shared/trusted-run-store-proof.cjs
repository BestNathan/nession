'use strict';
// Read-only verification of previously ingested records. The GitHub API, not
// JSON authored in the PR, is the source of workflow/run/tree authenticity.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const API='https://api.github.com/repos/BestNathan/nession';
async function fetchJson(route){
  const r=await fetch(API+route,{headers:{Accept:'application/vnd.github+json',
    'User-Agent':'nession-run-store-case'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('authenticated source lookup unavailable: '+r.status+' '+route);
  return r.json();
}
const HEX40=/^[a-f0-9]{40}$/;
const HEX64=/^[a-f0-9]{64}$/;
const gitBlob=(data)=>crypto.createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
async function pinnedRun({path,blob,runId,mode}){
  assert.match(blob,HEX40);
  assert.match(path,/^runs\/\d{4}-\d\d-\d\d\/\d+-\d+\//);
  const [file,run]=await Promise.all([
    fetchJson('/contents/'+path+'?ref=acceptance-results'),
    fetchJson('/actions/runs/'+runId),
  ]);
  assert.equal(file.encoding,'base64');
  const bytes=Buffer.from(file.content.replace(/\s/g,''),'base64');
  assert.ok(bytes.length>0 && bytes.length<1024*1024,'bounded immutable Run Record');
  assert.equal(file.sha,blob,'pinned durable Git blob changed');
  assert.equal(gitBlob(bytes),blob,'Git blob content hash mismatch');
  const item=JSON.parse(bytes.toString('utf8'));
  const source=mode==='acceptance'?item.provenance?.verified_source:item.source;
  assert.equal(item.schema_version,1);
  assert.equal(item.run_id,runId);
  assert.equal(item.run_attempt,source.run_attempt);
  assert.equal(source.repository,'BestNathan/nession');
  assert.equal(source.run_id,runId);
  assert.equal(source.workflow_id,run.workflow_id);
  assert.equal(run.id,runId);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  assert.equal(source.conclusion??'success',run.conclusion);
  assert.equal(run.head_sha,item.target_sha);
  assert.equal(source.target_sha??source.head_sha,item.target_sha);
  assert.match(item.target_sha,HEX40);
  assert.match(item.execution_id,HEX64);
  if(mode==='scenario'){
    assert.equal(item.kind,'e2e_scenario_observation');
    assert.equal(item.mode,'scenario');
    assert.equal(item.evaluation,null);
    assert.equal(source.scenario_tree_sha.length,40);
  }else{
    assert.equal(item.kind,'acceptance_case_result');
    assert.equal(item.stage,source.head_branch==='staging'?'staging':'post-merge');
    assert.equal(item.case_revision,item.target_sha);
    assert.match(item.case_tree_sha,HEX40);
    assert.match(item.contract_sha256,HEX64);
    assert.equal(item.provenance.record_path,path);
  }
  const git=await fetchJson('/git/commits/'+item.target_sha);
  const tree=await fetchJson('/git/trees/'+git.tree.sha+'?recursive=1');
  assert.equal(tree.truncated,false,'source commit tree truncated');
  const casePath=mode==='scenario'?'e2e/scenarios/'+item.scenario:
    'e2e/acceptance/cases/'+item.issue+'/'+item.criterion;
  const entry=tree.tree.find(x=>x.type==='tree'&&x.path===casePath);
  assert.ok(entry,'authenticated source tree missing '+casePath);
  assert.equal(entry.sha,mode==='scenario'?source.scenario_tree_sha:item.case_tree_sha);
  return {item,source,run,blob,path};
}
function failIdentityFixtures(sample){
  assert.throws(()=>assert.equal(sample.run_id,sample.run_id+1),/Expected values/);
  assert.throws(()=>assert.match('not-a-git-sha',HEX40));
  assert.throws(()=>assert.match('tampered-contract',HEX64));
}
function report(summary,evidence){
  assert.ok(Array.isArray(evidence)&&evidence.length>0);
  console.log(JSON.stringify({status:'pass',summary,evidence}));
}
function fail(error){
  const summary=error instanceof Error?error.message:String(error);
  console.error(summary);
  console.log(JSON.stringify({status:'fail',summary,
    evidence:[{type:'store',value:'immutable Git blob or GitHub source attestation failed'}]}));
  process.exitCode=1;
}
const SOURCES={
  scenario:{path:'runs/2026-10-09/37961137780-1/scenario/terminal-attach-resume-1.json',
    blob:'d4663d074452f89e10bd4185322e08d9265978ca',runId:37961137780,mode:'scenario'},
  acceptance:{path:'runs/2026-10-09/37960891443-1/1498/SC-01.json',
    blob:'e109c2fb652eef5523393d0ad7f4dbd5e13ac32e',runId:37960891443,mode:'acceptance'},
};
module.exports={pinnedRun,failIdentityFixtures,report,fail,SOURCES,fetchJson,HEX40,HEX64};
