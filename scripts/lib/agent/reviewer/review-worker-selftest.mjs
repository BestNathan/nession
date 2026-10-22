#!/usr/bin/env node
// Executable contract for #2137/#1664 SC-04 Reviewer worker adapter: only a
// bounded verified admission reaches the real SDK, the Provider receives
// exactly read/grep, and the Slice result is emitted from the mock native
// session without any network, GitHub or Store effect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { reviewModelResult } from '../tasks/review.mjs';
import { runReviewSlice } from './review-slice.mjs';
import { assertIsolatedReviewerProcess, createCursorReviewRunner,
  readReviewAdmission } from './review-worker.mjs';

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
const TASK='c'.repeat(64), RUN=39780000001, ATTEMPT=1;
const verdictText=JSON.stringify({outcome:'changes_requested',summary:'one blocking defect',
  findings:[{path:'scripts/lib/agent/example.mjs',evidence:'accepts an unbounded retry count'}]});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-review-worker-'));
try{
  const file=path.join(temp,'admission.json');
  fs.writeFileSync(file,JSON.stringify(admission));
  assert.equal(readReviewAdmission(file).target_sha,admission.target_sha);
  const symlink=path.join(temp,'admission-link.json');
  fs.symlinkSync(file,symlink);
  assert.throws(()=>readReviewAdmission(symlink),/unsafe verified admission/);
  const big=path.join(temp,'big.json');
  fs.writeFileSync(big,'x'.repeat(16385));
  assert.throws(()=>readReviewAdmission(big),/unsafe verified admission/);
  const forged=path.join(temp,'forged.json');
  fs.writeFileSync(forged,JSON.stringify({...admission,role:'developer'}));
  assert.throws(()=>readReviewAdmission(forged),/authenticated reviewer admission/);
  assert.throws(()=>readReviewAdmission(path.join(temp,'missing.json')),/ENOENT|no such file/i);
}finally{fs.rmSync(temp,{recursive:true,force:true});}

const goodEnv={NESSION_REVIEWER_ISOLATED:'docker-v1',GITHUB_WORKSPACE:'/workspace',
  CURSOR_SDK_ROOT:'/sdk',RUNNER_TEMP:'/tmp',CURSOR_API_KEY:'provider-only-key'};
assert.doesNotThrow(()=>assertIsolatedReviewerProcess(goodEnv,{dockerenv:true}));
assert.throws(()=>assertIsolatedReviewerProcess(goodEnv,{dockerenv:false}),/OS-isolated Docker worker/);
for(const [key,value] of [
  ['NESSION_REVIEWER_ISOLATED','local'],['GITHUB_WORKSPACE','/tmp'],
  ['CURSOR_SDK_ROOT','/tmp'],['RUNNER_TEMP','/var/tmp'],
]) assert.throws(()=>assertIsolatedReviewerProcess({...goodEnv,[key]:value},{dockerenv:true}),
  /OS-isolated Docker worker/);
for(const key of ['GITHUB_TOKEN','GH_TOKEN','STORE_WRITER_PRIVATE_KEY','PUBLISHER_APP_PRIVATE_KEY'])
  assert.throws(()=>assertIsolatedReviewerProcess({...goodEnv,[key]:'leak'},{dockerenv:true}),
    /privileged credential leaked/);

const catalog=[{id:'composer-2.5',parameters:[{id:'fast',values:[{value:'true'}]}]}];
let captured=null;
const mockSdk={
  Cursor:{models:{async list(){return catalog;}}},
  JsonlLocalAgentStore:class{constructor(file){this.file=file;}},
  Agent:{async create(options){captured=options;return{
    agentId:'agent-mock-review-01',
    async send(){return{id:'mock-run-1',async *stream(){
      yield{type:'usage'};
      yield{type:'tool_call',status:'running',name:'read'};
      yield{type:'tool_call',status:'running',name:'grep'};
    },async wait(){return{id:'mock-run-1',status:'finished',result:verdictText,
      usage:{inputTokens:7}};}};},
    async getUsage(){return{cost:{chargedCents:0}};},
    async [Symbol.asyncDispose](){},
  };}},
};
const runner=createCursorReviewRunner({sdkLoader:async()=>mockSdk,apiKey:'fixture',
  model:{id:'composer-2.5',fast:true},workspace:'/tmp',storePath:'/tmp/fixture-store'});
await assert.rejects(()=>runner('prompt',{tools:['read']}),/exactly read\/grep/);
await assert.rejects(()=>runner('prompt',{tools:['read','edit']}),/exactly read\/grep/);
await assert.rejects(()=>runner('prompt',{tools:null}),/exactly read\/grep/);
const slice=await runReviewSlice({admission,runner,taskId:TASK,runId:RUN,runAttempt:ATTEMPT,env:{}});
assert.deepEqual(captured.tools,['read','grep']);
assert.equal(captured.local.store.constructor.name,'JsonlLocalAgentStore');
assert.equal(slice.meta.agent_id,'agent-mock-review-01');
assert.equal(slice.artifact.outcome,'changes_requested');
assert.equal(slice.artifact.target_sha,admission.target_sha);
assert.equal(slice.artifact.task_id,TASK);
assert.deepEqual(slice.verdict.findings,[{path:'scripts/lib/agent/example.mjs',
  evidence:'accepts an unbounded retry count'}]);
assert.equal(reviewModelResult(admission,verdictText).outcome,'changes_requested');
// The CLI path must fail closed on a non-container host before reading input.
const cli=spawnSync(process.execPath,['scripts/lib/agent/reviewer/review-worker.mjs',
  'missing.json','/tmp/nession-review-out'],{encoding:'utf8',env:{PATH:process.env.PATH}});
assert.equal(cli.status,1);
assert.match(cli.stderr,/OS-isolated Docker worker is mandatory/);
console.log('Reviewer Worker: bounded admission read, isolated-process preconditions and exactly-read/grep mock SDK slice passed; no network, GitHub or Store effect');
