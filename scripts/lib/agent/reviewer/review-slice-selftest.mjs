#!/usr/bin/env node
// Executable contract for #2137/#1664 SC-04 Reviewer Slice: only an
// authenticated admission reaches the Provider, only read-only tools are
// offered, and only a bound verdict becomes the canonical result artifact.
import assert from 'node:assert/strict';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { parseAgentResult } from '../orchestration/result-artifact.mjs';
import { REVIEW_TOOLS, assertUnprivilegedReviewerEnvironment,
  runReviewSlice, reviewerResultArtifact } from './review-slice.mjs';

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
const TASK='c'.repeat(64), RUN=39770000001, ATTEMPT=1;
const verdictText=JSON.stringify({outcome:'changes_requested',summary:'one blocking defect',
  findings:[{path:'scripts/lib/agent/example.mjs',evidence:'accepts an unbounded retry count'}]});
function session(resultText=verdictText,overrides={}){
  return {result:{status:'finished',result:resultText},
    meta:{status:'finished',agent_id:'agent-review-01',tool_calls:['read','grep'],...overrides}};
}

assert.deepEqual([...REVIEW_TOOLS],['read','grep']);
assert.ok(Object.isFrozen(REVIEW_TOOLS));
const seen=[];
const runner=async(prompt,options)=>{seen.push({prompt,options});return session();};
const slice=await runReviewSlice({admission,runner,taskId:TASK,runId:RUN,runAttempt:ATTEMPT,env:{}});
assert.equal(slice.verdict.outcome,'changes_requested');
assert.equal(slice.verdict.target_sha,admission.target_sha);
assert.equal(slice.verdict.issue,1997);
assert.equal(slice.verdict.pr_number,2176);
assert.deepEqual(slice.artifact,{kind:'reviewer',issue:1997,run_id:RUN,run_attempt:ATTEMPT,
  target_sha:admission.target_sha,outcome:'changes_requested',task_id:TASK});
assert.deepEqual(parseAgentResult(Buffer.from(JSON.stringify(slice.artifact))),slice.artifact);
assert.ok(Object.isFrozen(slice.artifact));
assert.equal(seen.length,1);
assert.deepEqual(seen[0].options,{tools:['read','grep']},'Provider must be offered only read/grep');
assert.match(seen[0].prompt,/3d8e3807cc01f6082734b8d0ba458217c28f60a4/);
assert.match(seen[0].prompt,/"pull_request": 2176/);
assert.equal(slice.prompt.template_id,'review');

const approved=await runReviewSlice({admission,
  runner:async()=>session(JSON.stringify({outcome:'approved',summary:'no blocking defect',findings:[]})),
  taskId:TASK,runId:RUN,runAttempt:ATTEMPT,env:{}});
assert.equal(approved.artifact.outcome,'approved');

async function deny(options,pattern){
  await assert.rejects(()=>runReviewSlice({admission,taskId:TASK,runId:RUN,runAttempt:ATTEMPT,
    env:{},runner:async()=>session(),...options}),pattern);
}
await deny({taskId:'short'},/signed reviewer action ID/);
await deny({taskId:undefined},/signed reviewer action ID/);
await deny({runId:0},/source Run\/Attempt/);
await deny({runAttempt:2.5},/source Run\/Attempt/);
await deny({runner:null},/read-only Provider runner/);
await deny({runner:async()=>({result:{status:'error',result:verdictText},meta:{status:'error',agent_id:'agent-review-01',tool_calls:['read']}})},
  /did not finish/);
await deny({runner:async()=>({result:{status:'finished',result:verdictText},meta:{status:'finished',tool_calls:['read']}})},
  /native Agent identity/);
await deny({runner:async()=>session(verdictText,{tool_calls:['read','edit']})},
  /write\/shell tool/);
await deny({runner:async()=>session(verdictText,{tool_calls:['grep','shell']})},
  /write\/shell tool/);
await deny({runner:async()=>session(verdictText,{tool_calls:[]})},/no read-only inspection/);
await deny({runner:async()=>session(verdictText,{tool_calls:['list']})},/no read-only inspection/);
await deny({runner:async()=>session(JSON.stringify({outcome:'changes_requested',summary:'x',findings:[]}))},
  /at least one finding/);
await deny({runner:async()=>session(JSON.stringify({outcome:'approved',summary:'x',findings:[],next_role:'developer'}))},
  /unexpected result fields/);
await deny({runner:async()=>session(JSON.stringify({outcome:'approved',summary:'x',findings:[],target_sha:'e'.repeat(40)}))},
  /unexpected result fields/);
await deny({runner:async()=>session('not json')},/valid JSON/);
for(const key of ['GITHUB_TOKEN','GH_TOKEN','STORE_WRITER_PRIVATE_KEY','PUBLISHER_APP_PRIVATE_KEY',
  'ACTIONS_DISPATCH_TOKEN','CURSOR_RESUME_PRIVATE_KEY_B64'])
  assert.throws(()=>assertUnprivilegedReviewerEnvironment({[key]:'x'}),/privileged credential leaked/);
assert.doesNotThrow(()=>assertUnprivilegedReviewerEnvironment({CURSOR_API_KEY:'provider-only-key'}));
for(const patch of [
  {role:'developer'},{agent_id:'dev-cursor-01'},{target_sha:'e'.repeat(40)},
  {pr_number:2175},{expected_file_mode:'100755'},
])await assert.rejects(()=>runReviewSlice({admission:{...admission,...patch},
  runner:async()=>session(),taskId:TASK,runId:RUN,runAttempt:ATTEMPT,env:{}}),
  /authenticated reviewer admission/);

assert.throws(()=>reviewerResultArtifact({admission,verdict:{
  kind:'reviewer',issue:1664,pr_number:2176,target_sha:admission.target_sha,outcome:'approved'},
  taskId:TASK,runId:RUN,runAttempt:ATTEMPT}),/not bound to the admitted/);
assert.throws(()=>reviewerResultArtifact({admission,verdict:{kind:'developer',issue:1997,
  pr_number:2176,target_sha:admission.target_sha,outcome:'approved'},taskId:TASK,runId:RUN,runAttempt:ATTEMPT}),
  /not bound to the admitted/);
assert.throws(()=>reviewerResultArtifact({admission,verdict:{kind:'reviewer',issue:1997,
  pr_number:2176,target_sha:admission.target_sha,outcome:'merged'},taskId:TASK,runId:RUN,runAttempt:ATTEMPT}),
  /not bound to the admitted/);
assert.throws(()=>reviewerResultArtifact({admission,verdict:{
  kind:'reviewer',issue:1997,pr_number:2176,target_sha:admission.target_sha,outcome:'approved'},
  taskId:'x',runId:RUN,runAttempt:ATTEMPT}),/result identity/);

console.log('Reviewer Slice: admission-bound read-only session, write/shell denial and canonical result artifact negatives passed; no Reviewer was run');
