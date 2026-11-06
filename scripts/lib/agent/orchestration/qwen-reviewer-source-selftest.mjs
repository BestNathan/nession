#!/usr/bin/env node
// #2274: real local Store CAS fixture + fake inert Git read. Never POST.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDevelopment,validateDevelopmentState,
  acceptAttestedQwenPublication} from './outbox.mjs';
import {writeIssueWorkflowState} from './state-store.mjs';
import {validateQwenPublisherIntent} from '../publisher/store-intent.mjs';
import {qwenReviewerPublishedSource} from './qwen-reviewer-source.mjs';
import {sourceAllowed} from './controller-dispatch.mjs';

const REPO='BestNathan/nession',ISSUE=3001;
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),HASH='d'.repeat(64);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const initial=startDevelopment(registry,{
  issue:ISSUE,sha:A,developer:'dev-qwen-01',
  reviewer:'review-qwen-01',acceptor:'accept-qwen-01',
},{repository:REPO,event:'workflow_dispatch',permission:'write',
  ref:'refs/heads/main',run_id:101});
const developerAction=initial.outbox[0];
const dispatched=validateDevelopmentState({...initial,version:2,
  outbox:[{...developerAction,status:'dispatched',attempts:1,
    receipt:{status:'verified',dispatch_id:developerAction.id,
      source_run_id:301}}]});
const reviewed=acceptAttestedQwenPublication(dispatched,2,{
  kind:'publisher',outcome:'published',issue:ISSUE,
  run_id:401,run_attempt:1,target_sha:B,
},{role:'publisher',workflow_run_id:401,attempt:1,issue:ISSUE,
  source_sha:B,developer_action_id:developerAction.id,developer_run_id:301,
  developer_attempt:1,developer_source_sha:A,
  checkpoint_commit_sha:C,pr_number:541},registry);
const action=reviewed.outbox.find(x=>x.task.role==='reviewer');
assert.ok(action&&action.status==='pending');
const intent=validateQwenPublisherIntent({
  schema_version:1,kind:'trusted_qwen_publisher_write_ahead_intent',
  repository:REPO,issue:ISSUE,action_id:developerAction.id,
  worker_run_id:301,worker_run_attempt:1,worker_sha:'e'.repeat(40),
  source_sha:A,checkpoint_version:1,checkpoint_commit_sha:C,
  checkpoint_ciphertext_sha256:HASH,patch_sha256:HASH,
  file_manifest_sha256:HASH,file_count:1,target_main_sha:A,
  branch:'agent/'+ISSUE+'/qwen-'+developerAction.id.slice(0,16),
  publisher_run_id:401,publication:'not_yet_attested',
});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-review-source-'));
try{
  writeIssueWorkflowState(root,initial,0);
  writeIssueWorkflowState(root,dispatched,1);
  writeIssueWorkflowState(root,reviewed,2);
  const folder=path.join(root,'workflows/issues',String(ISSUE),'results');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'301-1-'+developerAction.id+'.json');
  fs.writeFileSync(file,JSON.stringify(intent)+'\n');
  const source={storeRoot:root,issue:ISSUE,actionId:action.id,sha:B};
  const verified=qwenReviewerPublishedSource(source);
  assert.equal(verified.branch,'refs/heads/'+intent.branch);
  assert.equal(verified.base_sha,A);
  assert.equal(verified.review_sha,B);
  const args=[];
  const run=parts=>{
    args.push(parts);
    if(parts[0]==='rev-parse')return B+'\n';
    return '';
  };
  const context={issue:ISSUE,actionId:action.id,storeRoot:root};
  sourceAllowed(B,'reviewer',{task:action.task,context,run});
  assert.deepEqual(args[0],['fetch','--quiet','--no-tags','origin',
    'refs/heads/'+intent.branch]);
  assert.deepEqual(args[1],['rev-parse','FETCH_HEAD']);
  assert.ok(args.some(x=>x[0]==='cat-file'&&x[2]===B+'^{commit}'));
  assert.deepEqual(args.filter(x=>x[0]==='merge-base'),[
    ['merge-base','--is-ancestor',A,B]]);
  assert.throws(()=>qwenReviewerPublishedSource({...source,sha:A}),
    /authentic|Outbox/);
  assert.throws(()=>qwenReviewerPublishedSource({...source,
    actionId:developerAction.id}),/Outbox/);
  assert.throws(()=>qwenReviewerPublishedSource({...source,issue:3002}),
    /Store|Outbox|head/);
  assert.throws(()=>sourceAllowed(B,'reviewer',{task:action.task,run}),
    /signed source-ref context/);
  assert.throws(()=>sourceAllowed(B,'reviewer',{task:action.task,context,
    run:parts=>parts[0]==='rev-parse'?'0'.repeat(40):''}),
    /published Qwen Reviewer source ref unavailable/);
  assert.throws(()=>sourceAllowed(B,'reviewer',{task:action.task,context,
    run:parts=>{if(parts[0]==='fetch')throw Error('missing');return B;}}),
    /published Qwen Reviewer source ref unavailable/);
  fs.writeFileSync(file,JSON.stringify({...intent,publisher_run_id:402}));
  assert.throws(()=>qwenReviewerPublishedSource(source),/unique Qwen publication Intent/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Qwen signed Reviewer dispatch: one immutable Store branch, actual SHA fetch, two ancestry checks, untrusted source and replay negatives pass');
