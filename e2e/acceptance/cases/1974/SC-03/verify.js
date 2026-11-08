'use strict';
// #1974 SC-03: a real Slice has its OWN identity, never the dispatch
// action_id or a fabricated sequence. A missing independently attested
// identity is an explicit Partial, so #1906 must remain Unlinked.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {REPO,issueRecords,HEX40}=require('../../../shared/agent-store-1997.cjs');
const {attestLatestQwenProducer}=require('../../../shared/qwen-live-source.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');

const root=path.resolve(__dirname,'../../../../..');
const HEX64=/^[a-f0-9]{64}$/;
const SLICE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fields=['schema_version','kind','repository','issue','slice_id','task_id',
  'action_id','agent_id','role','run_id','run_attempt','target_sha'];
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k));
function pending(source,description){
  console.log(JSON.stringify({status:'pending',
    summary:description+' Source is explicitly Partial; #1906 remains Unlinked.',
    evidence:[{type:'store',value:'agent-store='+(source?.storeSha||'unavailable')},
      {type:'blocked',value:'No action_id-to-Slice inference or unsigned Store-only Slice projection'}]}));
}
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(target,HEX40,'exact target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    target,'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'main');

  const source=await attestLatestQwenProducer();
  if(source.status!=='verified'){
    pending(source,'Original Qwen Developer Result v2 is not authenticated: '+source.reason);
    return;
  }
  const a=source.attested,{slices}=await issueRecords(source.fixture.issue);
  if(a.slice_id===null||!slices.length){
    pending(source,'No separately authenticated logical Slice exists for Qwen Run '+
      a.run_id+'/'+a.attempt);
    return;
  }
  assert.match(String(a.slice_id),SLICE);
  assert.notEqual(a.slice_id,a.action_id,'action_id cannot double as Slice');
  const bound=[];
  for(const item of slices){
    const doc=item.doc;
    assert.ok(only(doc,fields),'unsafe logical Slice record: '+item.path);
    assert.equal(doc.schema_version,1);
    assert.equal(doc.kind,'agent_slice_identity');
    assert.equal(doc.repository,REPO);
    assert.equal(doc.issue,source.fixture.issue);
    assert.match(String(doc.slice_id??''),SLICE);
    assert.match(String(doc.task_id??''),HEX64);
    assert.match(String(doc.action_id??''),HEX64);
    assert.match(String(doc.target_sha??''),HEX40);
    assert.ok(Number.isSafeInteger(doc.run_id)&&doc.run_id>0);
    assert.ok(Number.isSafeInteger(doc.run_attempt)&&doc.run_attempt>0);
    if(doc.slice_id===a.slice_id&&doc.action_id===a.action_id&&
       doc.task_id===a.action_id&&doc.run_id===a.run_id&&
       doc.run_attempt===a.attempt&&doc.target_sha===a.pr_head_sha&&
       doc.agent_id===a.agent_id&&doc.role===a.role)
      bound.push(item);
  }
  assert.equal(bound.length,1,'exactly one independently attested Slice join required');
  const run=await require('../../../shared/trusted-run-store-proof.cjs')
    .fetchJson('/actions/runs/'+a.run_id);
  assert.equal(run.id,a.run_id);
  assert.equal(run.run_attempt,a.attempt);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  report('Real independently authenticated Slice identity joined original Qwen Agent Run/Attempt without conflating the dispatch action.',[
    {type:'store',value:'agent-store='+source.storeSha+' slice='+bound[0].path},
    {type:'slice',value:'slice_id='+a.slice_id+' action='+a.action_id},
    {type:'source',value:'run='+a.run_id+'/'+a.attempt+' pr=#'+a.pr_number},
  ]);
}
main().catch(fail);
