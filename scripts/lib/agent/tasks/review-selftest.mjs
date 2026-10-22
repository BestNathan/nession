#!/usr/bin/env node
// Executable contract for #2137/#1664 SC-04 Reviewer task: one host-bound
// target, a strict model-result schema, and no model-authored role/approval.
import assert from 'node:assert/strict';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { assertAuthenticatedReviewerAdmission } from '../reviewer/pr-admission.mjs';
import { reviewModelView, renderReviewPrompt, reviewModelResult } from './review.mjs';
import { parseModelJson } from './model-json.mjs';

// Exact output shape of admitOriginalControlledReviewerTarget for the real
// #2176 Publisher fixture. The shared admission validator below owns whether
// a task is authentic; this literal must stay in step or that validator fails.
const admission=Object.freeze({
  schema_version:1,kind:'authenticated_reviewer_admission_only',
  status:'await_native_reviewer',repository:'BestNathan/nession',issue:1997,
  role:'reviewer',agent_id:'review-cursor-01',task:'review',pr_number:2176,
  target_sha:'3d8e3807cc01f6082734b8d0ba458217c28f60a4',
  base_sha_at_publication:'c6894b59b8be9448cae3c68fd87593516f66b47a',
  publisher_run_id:39609600546,publisher_attempt:1,
  publisher_intent_sha256:'a'.repeat(64),
  original_worker_run_id:39448549052,
  native_checkpoint_commit_sha:'eb891ee2154d02ddb758d50f0f694e70a343ffdf',
  expected_file:POLICY.file,expected_file_sha256:'b'.repeat(64),
  expected_file_mode:'100644',
});
assert.equal(assertAuthenticatedReviewerAdmission(admission),admission);
const view=reviewModelView(admission);
assert.equal(view.target_sha,admission.target_sha);
assert.equal(view.pull_request,2176);
assert.equal(view.expected_file_mode,'100644');
assert.ok(!Object.hasOwn(view,'agent_id'),'model view carries no role/agent selection');

const prompt=renderReviewPrompt(admission);
assert.equal(prompt.template_id,'review');
assert.equal(prompt.template_version,'v2');
assert.match(prompt.template_sha256,/^[a-f0-9]{64}$/);
assert.match(prompt.text,/3d8e3807cc01f6082734b8d0ba458217c28f60a4/);
assert.match(prompt.text,/"pull_request": 2176/);
assert.match(prompt.text,/changes_requested/);
assert.deepEqual(renderReviewPrompt(admission).template_sha256,prompt.template_sha256);

const finding={path:'scripts/lib/agent/example.mjs',evidence:'accepts an unbounded retry count'};
const requested=reviewModelResult(admission,JSON.stringify({
  outcome:'changes_requested',summary:'one blocking defect',findings:[finding],
}));
assert.equal(requested.kind,'reviewer');
assert.equal(requested.issue,1997);
assert.equal(requested.pr_number,2176);
assert.equal(requested.target_sha,admission.target_sha);
assert.equal(requested.outcome,'changes_requested');
assert.deepEqual(requested.findings,[finding]);
assert.ok(Object.isFrozen(requested.findings));
const approved=reviewModelResult(admission,
  '```json\n{"outcome":"approved","summary":"no blocking defect","findings":[]}\n```');
assert.equal(approved.outcome,'approved');
assert.deepEqual(approved.findings,[]);
// Embedded JSON is extracted by the same bounded rule the Acceptance Agent uses.
assert.deepEqual(parseModelJson('prefix {"outcome":"approved"} suffix'),{outcome:'approved'});
assert.deepEqual(parseModelJson('```json\n{"outcome":"approved"}\n```'),{outcome:'approved'});
assert.throws(()=>parseModelJson('  '),/returned empty output/);
assert.throws(()=>parseModelJson('no json'),/did not contain valid JSON/);

function deny(raw,pattern=/Review task:/){
  assert.throws(()=>reviewModelResult(admission,typeof raw==='string'?raw:JSON.stringify(raw)),pattern);
}
deny('not json',/valid JSON/);
deny({outcome:'changes_requested',summary:'x',findings:[finding],next_role:'developer'},/unexpected result fields/);
deny({outcome:'changes_requested',summary:'x',findings:[finding],approval:'approved'},/unexpected result fields/);
deny({outcome:'changes_requested',summary:'x',findings:[finding],merge:true},/unexpected result fields/);
deny({outcome:'changes_requested',summary:'x',findings:[finding],target_sha:'e'.repeat(40)},/unexpected result fields/);
deny({outcome:'approved',summary:'x'},/unexpected result fields/);
deny({outcome:'pending',summary:'x',findings:[]},/invalid review outcome/);
deny({outcome:'APPROVED',summary:'x',findings:[]},/invalid review outcome/);
deny({outcome:'approved',summary:'',findings:[]},/invalid summary/);
deny({outcome:'approved',summary:'two\nlines',findings:[]},/invalid summary/);
deny({outcome:'approved',summary:'x'.repeat(2001),findings:[]},/invalid summary/);
deny({outcome:'approved',summary:'x',findings:'none'},/invalid findings/);
deny({outcome:'approved',summary:'x',findings:Array.from({length:51},()=>finding)},/invalid findings/);
deny({outcome:'changes_requested',summary:'x',findings:[]},/at least one finding/);
deny({outcome:'changes_requested',summary:'x',findings:[{path:'a',evidence:'b',line:4}]},/unexpected finding fields/);
for(const path of ['/etc/passwd','../escape','a\\b','','x'.repeat(401),'a\nb'])
  deny({outcome:'changes_requested',summary:'x',findings:[{path,evidence:'b'}]},/invalid finding path/);
for(const evidence of ['','two\nlines','x'.repeat(2001)])
  deny({outcome:'changes_requested',summary:'x',findings:[{path:'a',evidence}]},/invalid finding evidence/);

// A lookalike task must never reach the Prompt: identity and target are host-owned.
for(const patch of [
  {role:'developer'},{agent_id:'dev-cursor-01'},{task:'implement'},{status:'ready'},
  {kind:'authenticated_developer_slice'},{repository:'evil/nession'},{issue:1664},
  {pr_number:2175},{target_sha:'e'.repeat(40)},
  {base_sha_at_publication:'e'.repeat(40)},
  {publisher_intent_sha256:'not-hex'},{expected_file:'other.txt'},
  {expected_file_mode:'100755'},{original_worker_run_id:0},
])assert.throws(()=>reviewModelResult({...admission,...patch},'{}'),/authenticated reviewer admission/);
assert.throws(()=>reviewModelResult({...admission,extra:true},'{}'),/authenticated reviewer admission/);
const {publisher_run_id,...missing}=admission;
assert.throws(()=>reviewModelResult(missing,'{}'),/authenticated reviewer admission/);

console.log('Reviewer task: host-bound target and strict changes_requested/approved schema; role/approval/target/model-extra negatives passed; no Reviewer was run');
