'use strict';
// #1974 SC-03: a genuine logical Slice identity joins the real Agent -> Run.
// A dispatch action_id is NOT a Slice ID. Until the producer emits a real slice
// record the source is explicitly Partial and #1906 remains Unlinked.
//
// Executable contract proposed here (owner: #1664/#1974): a pinned store record
// workflows/issues/<issue>/slices/<slice_id>.json with
//   {schema_version:1, kind:'agent_slice_identity', repository, issue, slice_id,
//    task_id, action_id, agent_id, role, run_id, run_attempt, target_sha}
// binding the same Agent/Run/Attempt as the authenticated Result v2.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {
  REPO,issueRecords,isResultV2,isSlice,fetchJson,HEX40,
}=require('../../../shared/agent-store-1997.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');

const root=path.resolve(__dirname,'../../../../..');
const HEX64=/^[a-f0-9]{64}$/;
const SLICE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function pending(summary,evidence){
  console.log(JSON.stringify({status:'pending',summary,evidence}));
}
const only=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&Object.keys(value).every(k=>fields.includes(k));

async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(target,HEX40,'exact target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target,
    'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'main','post-merge Case must run on main');

  const {storeSha,results,slices}=await issueRecords();
  const v2=results.filter(item=>isResultV2(item.doc));
  if(!v2.length){
    pending(
      'No authenticated Result v2 exists, so a logical Slice cannot be joined. The source remains explicitly Partial and #1906 stays Unlinked.',
      [{type:'store',value:'agent-store='+storeSha+' result_records='+results.length+' slice_records='+slices.length}]);
    return;
  }
  assert.equal(v2.length,1,'expected exactly one authenticated #1997 Result v2');
  const receipt=v2[0].doc;

  if(!slices.length){
    pending(
      'The authenticated Result v2 has no genuine logical Slice identity; action_id is not a Slice ID. The source remains explicitly Partial and #1906 stays Unlinked.',
      [
        {type:'store',value:'agent-store='+storeSha+' result='+v2[0].path},
        {type:'blocked',value:'missing workflows/issues/1997/slices/<slice_id>.json'},
      ]);
    return;
  }

  const fields=['schema_version','kind','repository','issue','slice_id','task_id',
    'action_id','agent_id','role','run_id','run_attempt','target_sha'];
  let joined=null;
  for(const item of slices){
    const doc=item.doc;
    if(!only(doc,fields)) throw new Error('malformed slice record: '+item.path);
    assert.equal(doc.schema_version,1);
    assert.equal(doc.kind,'agent_slice_identity');
    assert.equal(doc.repository,REPO);
    assert.equal(doc.issue,1997);
    assert.match(String(doc.slice_id??''),SLICE,'invalid slice_id');
    assert.notEqual(doc.slice_id,receipt.action_id,'action_id is not a Slice ID');
    assert.match(String(doc.action_id??''),HEX64,'invalid slice action_id');
    assert.match(String(doc.task_id??''),HEX64,'invalid slice task_id');
    assert.match(String(doc.target_sha??''),HEX40,'invalid slice target SHA');
    assert.ok(Number.isSafeInteger(doc.run_id)&&doc.run_id>0,'invalid slice run id');
    assert.ok(Number.isSafeInteger(doc.run_attempt)&&doc.run_attempt>0,'invalid slice attempt');
    if(doc.action_id!==receipt.action_id||doc.run_id!==receipt.result.run_id||
       doc.run_attempt!==receipt.result.run_attempt||doc.target_sha!==receipt.result.target_sha||
       doc.task_id!==receipt.action_id||doc.role!==receipt.result.kind||
       doc.agent_id!==receipt.source.agent_id)continue;
    joined={item,doc};
  }
  assert.ok(joined,'no slice record binds the authenticated Result v2 Agent/Run/Attempt');
  const run=await fetchJson('/actions/runs/'+joined.doc.run_id);
  assert.equal(run.run_attempt,joined.doc.run_attempt);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');

  report(
    'A genuine logical Slice identity is recorded in the pinned store and joins the authenticated Agent -> Run/Attempt without reusing action_id.',
    [
      {type:'store',value:'agent-store='+storeSha+' slice='+joined.item.path},
      {type:'slice',value:'slice_id='+joined.doc.slice_id+' task_id='+joined.doc.task_id},
      {type:'join',value:'agent='+joined.doc.agent_id+' role='+joined.doc.role+' run='+joined.doc.run_id+'/'+joined.doc.run_attempt},
      {type:'source',value:'action='+joined.doc.action_id+' target_sha='+joined.doc.target_sha},
    ]);
}
main().catch(fail);
