'use strict';
// #1974 SC-01: a real authenticated Agent Result v2 and an authorized Publisher
// Store commit are observable at the exact Run/Attempt/PR SHA. This verifier is
// read-only and fail-closed: a missing real result is Pending, a malformed or
// forged one is Fail, never a Pass by absence.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {
  REPO,issueRecords,isResultV2,isIntent,fetchJson,HEX40,
}=require('../../../shared/agent-store-1997.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');

const root=path.resolve(__dirname,'../../../../..');
function pending(summary,evidence){
  console.log(JSON.stringify({status:'pending',summary,evidence}));
}

async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(target,HEX40,'exact target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target,
    'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'main','post-merge Case must run on main');

  const {storeSha,results}=await issueRecords();
  const v2=results.filter(item=>isResultV2(item.doc));
  if(!v2.length){
    const intents=results.filter(item=>isIntent(item.doc));
    assert.ok(intents.length>0,'no Result v2 and no Publisher intent in the pinned store');
    pending(
      'No authenticated Agent Result v2 exists yet; the pinned store holds only a Publisher write-ahead intent, so the producer receipt cannot be accepted.',
      [
        {type:'store',value:'agent-store='+storeSha+' result_records='+results.length},
        {type:'blocked',value:'present kinds='+[...new Set(results.map(x=>x.doc.kind))].join(',')+' publication=not_yet_attested'},
      ]);
    return;
  }

  const {validateAuthenticatedAgentReceipt}=await import(pathToFileURL(
    path.join(root,'scripts/lib/agent/orchestration/result-artifact.mjs')).href);

  const accepted=[];
  for(const item of v2){
    try{ validateAuthenticatedAgentReceipt(item.doc); }
    catch(error){ throw new Error('malformed Result v2 at '+item.path+': '+error.message); }
    if(item.doc.issue!==1997) throw new Error('Result v2 belongs to another Issue: '+item.path);
    accepted.push(item);
  }
  assert.equal(accepted.length,1,'expected exactly one authenticated #1997 Result v2');
  const receipt=accepted[0].doc;

  // Independent GitHub source identity for the exact Worker Run/Attempt.
  const run=await fetchJson('/actions/runs/'+receipt.result.run_id);
  assert.equal(run.run_attempt,receipt.result.run_attempt,'Worker attempt mismatch');
  assert.equal(run.name,'Agent / Development','unexpected Worker workflow name');
  assert.equal(run.path,'.github/workflows/agent-develop.yml','unexpected Worker workflow path');
  assert.equal(run.event,'workflow_dispatch','Worker run was not an authenticated dispatch');
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  assert.equal(run.repository?.full_name,REPO,'Worker run repository mismatch');
  assert.equal(run.head_repository?.full_name,REPO,'Worker head repository mismatch');

  // The v2 receipt carries the implementing PR head at attestation. The PR must
  // still be a same-repository main-targeted PR; a moved head is not a failure
  // of this historical binding, but the attested SHA must be the receipt target.
  const binding=receipt.implementing_pr;
  assert.ok(binding&&Number.isSafeInteger(binding.number)&&binding.number>0,'missing implementing PR');
  assert.equal(binding.repository,REPO);
  assert.equal(binding.head_sha_at_attestation,receipt.result.target_sha,
    'attested PR head differs from the result target SHA');
  assert.equal(binding.relation,'trusted_pr_head_at_result_attestation');
  const pull=await fetchJson('/pulls/'+binding.number);
  assert.equal(pull.base?.repo?.full_name,REPO,'PR base is not this repository');
  assert.equal(pull.head?.repo?.full_name,REPO,'PR head is not this repository');
  assert.equal(pull.base?.ref,'main','implementing PR does not target main');

  // The same pinned store must hold the write-ahead intent for this exact
  // action/Run; its Publisher Run is independently re-read from GitHub.
  const intent=results.find(item=>isIntent(item.doc)&&
    item.doc.action_id===receipt.action_id&&
    item.doc.worker_run_id===receipt.result.run_id&&
    item.doc.worker_run_attempt===receipt.result.run_attempt);
  assert.ok(intent,'missing Publisher intent bound to the Result v2');
  const publisher=await fetchJson('/actions/runs/'+intent.doc.publisher_issuer_run_id);
  assert.equal(publisher.name,'Store / Controlled Publisher');
  assert.equal(publisher.path,'.github/workflows/store-controlled-publisher.yml');
  assert.equal(publisher.event,'issue_comment');
  assert.equal(publisher.status,'completed');
  assert.equal(publisher.conclusion,'success');
  assert.equal(publisher.repository?.full_name,REPO);

  report(
    'A real authenticated Result v2 and its Publisher Store intent are bound to the exact Worker Run/Attempt and implementing PR.',
    [
      {type:'store',value:'agent-store='+storeSha+' result='+accepted[0].path+' intent='+intent.path},
      {type:'result',value:'action='+receipt.action_id+' issue='+receipt.issue+' target_sha='+receipt.result.target_sha},
      {type:'worker',value:'run='+run.id+'/'+run.run_attempt+' Agent / Development success'},
      {type:'publisher',value:'run='+publisher.id+' Store / Controlled Publisher success'},
      {type:'pr',value:'#'+binding.number+' attested_head='+binding.head_sha_at_attestation},
    ]);
}
main().catch(fail);
