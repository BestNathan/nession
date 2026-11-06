#!/usr/bin/env node
// #2274/#2137: synthetic facts prove source-bound Qwen Reviewer admission
// and fail-closed rejections. This is NOT a real production PR/Run Case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeIssueWorkflowState} from '../orchestration/state-store.mjs';
import {prepareQwenReviewAdmission} from './prepare-admission.mjs';
import {startDevelopment,validateDevelopmentState,
  acceptAttestedQwenPublication} from '../orchestration/outbox.mjs';
import {validateQwenPublisherIntent} from '../publisher/store-intent.mjs';
import {assertReviewerAdmission} from './pr-admission.mjs';
import {admitQwenPublishedReview} from './qwen-pr-admission.mjs';
import {renderReviewPrompt,reviewModelResult} from '../tasks/review.mjs';

const REPO='BestNathan/nession',ISSUE=3001,MAIN='a'.repeat(40);
const HEAD='b'.repeat(40),TREE='c'.repeat(40),BLOB='d'.repeat(40);
const CP='e'.repeat(40),HASH='f'.repeat(64);
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const initial=startDevelopment(registry,{
  issue:ISSUE,sha:MAIN,developer:'dev-qwen-01',
  reviewer:'review-qwen-01',acceptor:'accept-qwen-01',
},{repository:REPO,event:'workflow_dispatch',permission:'write',
  ref:'refs/heads/main',run_id:101});
const action=initial.outbox[0].id;
const dispatched=validateDevelopmentState({...initial,version:2,
  outbox:[{...initial.outbox[0],status:'dispatched',attempts:1,
    receipt:{status:'verified',dispatch_id:action,source_run_id:301}}]});
const published=acceptAttestedQwenPublication(dispatched,2,{
  kind:'publisher',outcome:'published',issue:ISSUE,run_id:401,
  run_attempt:1,target_sha:HEAD,
},{role:'publisher',workflow_run_id:401,attempt:1,issue:ISSUE,
  source_sha:HEAD,developer_action_id:action,developer_run_id:301,
  developer_attempt:1,developer_source_sha:MAIN,
  checkpoint_commit_sha:CP,pr_number:541},registry);
assert.equal(published.phase,'review');
const next=published.outbox.filter(x=>x.task.role==='reviewer');
assert.equal(next.length,1);
const reviewerAction=next[0].id;
const intent=validateQwenPublisherIntent({
  schema_version:1,kind:'trusted_qwen_publisher_write_ahead_intent',
  repository:REPO,issue:ISSUE,action_id:action,worker_run_id:301,
  worker_run_attempt:1,worker_sha:'9'.repeat(40),source_sha:MAIN,
  checkpoint_version:1,checkpoint_commit_sha:CP,
  checkpoint_ciphertext_sha256:HASH,patch_sha256:HASH,
  file_manifest_sha256:HASH,file_count:2,target_main_sha:MAIN,
  branch:'agent/'+ISSUE+'/qwen-'+action.slice(0,16),
  publisher_run_id:401,publication:'not_yet_attested',
});
const publisherRun={id:401,run_attempt:1,name:'Store / Qwen Publisher',
  path:'.github/workflows/store-qwen-publisher.yml',event:'workflow_run',
  head_branch:'main',head_sha:MAIN,status:'completed',conclusion:'success',
  repository:{full_name:REPO},head_repository:{full_name:REPO}};
const pr={number:541,state:'open',draft:false,merged_at:null,
  head:{sha:HEAD,ref:intent.branch,repo:{full_name:REPO}},
  base:{ref:'main',repo:{full_name:REPO}}};
const ref={ref:'refs/heads/'+intent.branch,object:{sha:HEAD}};
const commit={sha:HEAD,parents:[{sha:MAIN}],tree:{sha:TREE}};
const files=[{filename:'src/a.ts',sha:BLOB,status:'modified'},
  {filename:'docs/b.md',sha:'8'.repeat(40),status:'modified'}];
const tree={sha:TREE,truncated:false,tree:files.map(f=>({
  path:f.filename,mode:'100644',type:'blob',sha:f.sha,
}))};
const good={state:published,intent,publisherRun,pullRequests:[pr],pr,
  ref,commit,files,tree,actionId:reviewerAction};
const make=delta=>admitQwenPublishedReview({...good,...delta});
const accepted=make({});
assert.equal(accepted.issue,ISSUE);
assert.equal(accepted.review_action_id,reviewerAction);
assert.deepEqual(accepted.expected_files.map(x=>x.path),
  ['docs/b.md','src/a.ts']);
assertReviewerAdmission(accepted);
assertReviewerAdmission(accepted,{agent_id:'review-qwen-01'});
assert.throws(()=>assertReviewerAdmission(accepted,
  {agent_id:'review-cursor-01'}),/Qwen Reviewer admission/);
const prompt=renderReviewPrompt(accepted);
assert.ok(prompt.text.includes('docs/b.md'));
assert.ok(prompt.text.includes('src/a.ts'));
const verdict=reviewModelResult(accepted,JSON.stringify({
  outcome:'changes_requested',summary:'One source defect',
  findings:[{path:'src/a.ts',evidence:'Incorrect bound'}],
}));
assert.equal(verdict.issue,ISSUE);
assert.equal(verdict.pr_number,541);
assert.equal(verdict.target_sha,HEAD);
const rejects=[
  [{state:{...published,phase:'ready'}},/outbox|Outbox/],
  [{actionId:action},/Outbox/],
  [{state:{...published,assignments:{...published.assignments,
      reviewer:'review-cursor-01'}}},/Outbox/],
  [{intent:{...intent,publisher_run_id:402}},/Outbox/],
  [{publisherRun:{...publisherRun,head_sha:'0'.repeat(40)}},/Publisher Run/],
  [{publisherRun:{...publisherRun,run_attempt:2}},/Publisher Run/],
  [{pullRequests:[pr,pr]},/Qwen PR/],
  [{pr:{...pr,head:{...pr.head,sha:MAIN}}},/Outbox/],
  [{pr:{...pr,base:{...pr.base,ref:'staging'}}},/Qwen PR/],
  [{ref:{...ref,object:{sha:MAIN}}},/Qwen PR/],
  [{commit:{...commit,parents:[{sha:HEAD}]}},/Qwen PR/],
  [{tree:{...tree,truncated:true}},/Qwen PR/],
  [{files:[...files,{...files[0],filename:'src/c.ts'}]},/changed-file/],
  [{files:[{...files[0],filename:'.github/workflows/ci.yml'},files[1]]},
    /PR modification/],
  [{tree:{...tree,tree:tree.tree.map((x,i)=>i?x:{...x,mode:'100755'})}},
    /PR modification/],
  [{files:[{...files[0],sha:'7'.repeat(40)},files[1]]},/PR modification/],
];
for(const [delta,error] of rejects)
  assert.throws(()=>make(delta),error);
assert.throws(()=>assertReviewerAdmission({...accepted,
  expected_files:[{path:'../secrets',blob_sha:BLOB,mode:'100644'}]}),
  /Qwen Reviewer admission/);
assert.throws(()=>assertReviewerAdmission({...accepted,
  publisher_branch:'agent/3001/qwen-forged'}),/Qwen Reviewer admission/);
console.log('Qwen Reviewer: authenticated published multi-file PR/Outbox model view and 18 negative source/role/branch/files cases pass');


const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-review-store-'));
try{
  writeIssueWorkflowState(root,initial,0);
  writeIssueWorkflowState(root,dispatched,1);
  writeIssueWorkflowState(root,published,2);
  const directory=path.join(root,'workflows/issues',String(ISSUE),'results');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'301-1-'+action+'.json'),
    JSON.stringify(intent)+'\n');
  const endpoints={
    ['actions/runs/401']:publisherRun,
    ['pulls?state=all&head=BestNathan:'+encodeURIComponent(intent.branch)+
      '&per_page=100']:[pr],
    ['pulls/541']:pr,
    ['git/ref/heads/'+intent.branch]:ref,
    ['git/commits/'+HEAD]:commit,
    ['pulls/541/files?per_page=100']:files,
    ['git/trees/'+TREE+'?recursive=1']:tree,
  };
  const fetcher=async name=>{
    if(!Object.hasOwn(endpoints,name))
      throw Error('unexpected independent GitHub source '+name);
    return endpoints[name];
  };
  const prepared=await prepareQwenReviewAdmission({
    storeRoot:root,issue:ISSUE,actionId:reviewerAction,fetcher});
  assert.deepEqual(prepared,accepted);
  await assert.rejects(()=>prepareQwenReviewAdmission({
    storeRoot:root,issue:ISSUE,actionId:action,fetcher}),/Outbox/);
  await assert.rejects(()=>prepareQwenReviewAdmission({
    storeRoot:root,issue:ISSUE,actionId:reviewerAction,
    fetcher:async name=>name.startsWith('pulls?')?[pr,pr]:fetcher(name),
  }),/unique published/);
  fs.writeFileSync(path.join(directory,'302-1-'+'0'.repeat(64)+'.json'),
    JSON.stringify({...intent,action_id:'0'.repeat(64),
      branch:'agent/'+ISSUE+'/qwen-'+'0'.repeat(16)})+'\n');
  await assert.rejects(()=>prepareQwenReviewAdmission({
    storeRoot:root,issue:ISSUE,actionId:reviewerAction,fetcher}),
  /unique committed Qwen Publisher Intent/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Qwen Reviewer: trusted Store readback, live GitHub source routing, duplicate intent and PR rejection verified');
