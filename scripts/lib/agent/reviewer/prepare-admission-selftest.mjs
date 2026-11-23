#!/usr/bin/env node
// Executable contract for #2245: the trusted admission preparation consumes
// independently fetched #2176 facts plus the committed Store intent and builds
// an admission for a registered reviewer identity. No network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { planControlledPublisherIntent,
  CONTROLLED_PUBLISHER_INTENT_PATH } from '../publisher/store-intent.mjs';
import { renderReviewPrompt } from '../tasks/review.mjs';
import {prepareReviewAdmission,boundedQwenReviewBaseFiles} from './prepare-admission.mjs';

const REPO='BestNathan/nession';
const HEAD='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const MAIN='c6894b59b8be9448cae3c68fd87593516f66b47a';
const TREE='34ba295f4b6d0becffd6bc1d3e178a54325c0410';
const {createHash}=await import('node:crypto');
const blobSha=(b)=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b])).digest('hex');
const publisherRun={id:39609600546,run_attempt:1,name:'Store / Controlled Publisher',
  path:'.github/workflows/store-controlled-publisher.yml',
  repository:{full_name:REPO},head_repository:{full_name:REPO},
  event:'issue_comment',actor:{login:'BestNathan'},head_branch:'main',head_sha:MAIN,
  status:'completed',conclusion:'success',created_at:'2026-10-21T13:37:20Z'};
const ownerComment={id:6317468284,user:{login:'BestNathan'},
  issue_url:'https://api.github.com/repos/'+REPO+'/issues/1997',
  body:'/nession publish issue=1997 worker_run=39448549052 checkpoint=3',
  created_at:'2026-10-21T13:37:18Z'};
const pullRequest={number:2176,state:'open',draft:false,merged_at:null,
  user:{login:'nession-publisher[bot]'},
  head:{sha:HEAD,ref:'agent/1997/developer-checkpoint-v3',repo:{full_name:REPO}},
  base:{ref:'main',repo:{full_name:REPO}},created_at:'2026-10-21T13:37:57Z'};
const commit={sha:HEAD,commit:{tree:{sha:TREE}},parents:[{sha:MAIN}]};
const files=[{filename:POLICY.file,status:'added',sha:blobSha(Buffer.from(POLICY.content)),
  additions:2,deletions:0,changes:2,
  patch:'@@ -0,0 +1,2 @@\n+Durable Worker fixture: complete\n+Previous value: pending'}];
const treeEntry={path:POLICY.file,mode:'100644',type:'blob',
  sha:blobSha(Buffer.from(POLICY.content)),size:Buffer.byteLength(POLICY.content)};
const replies={
  ['actions/runs/39609600546']:publisherRun,
  ['issues/comments/6317468284']:ownerComment,
  ['pulls/2176']:pullRequest,
  ['commits/'+HEAD]:commit,
  ['pulls/2176/files?per_page=100']:files,
  ['git/trees/'+TREE+'?recursive=1']:{tree:[treeEntry]},
};
const fetcher=async(endpoint)=>{
  if(!Object.hasOwn(replies,endpoint))throw Error('unexpected endpoint '+endpoint);
  return replies[endpoint];
};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-prep-'));
const intentPath=path.join(temp,CONTROLLED_PUBLISHER_INTENT_PATH);
try{
  fs.mkdirSync(path.dirname(intentPath),{recursive:true});
  fs.writeFileSync(intentPath,JSON.stringify(planControlledPublisherIntent({
    target_main_sha:MAIN,
    patch_sha256:'1f45a088966d41c1fcade13540498693d7d083ca238ca2b06c0525c654e314ee',
    issuer_run_id:39609600546,
  })));
  const cursor=await prepareReviewAdmission({storeRoot:temp,fetcher});
  assert.equal(cursor.agent_id,'review-cursor-01');
  assert.equal(cursor.target_sha,HEAD);
  assert.equal(cursor.pr_number,2176);
  assert.equal(cursor.expected_file_mode,'100644');
  const qwen=await prepareReviewAdmission({reviewerAgentId:'review-qwen-01',storeRoot:temp,fetcher});
  assert.equal(qwen.agent_id,'review-qwen-01');
  assert.equal(qwen.kind,'authenticated_reviewer_admission_only');
  assert.equal(qwen.target_sha,HEAD);
  const prompt=renderReviewPrompt(qwen,{agent_id:'review-qwen-01'});
  assert.equal(prompt.template_id,'review');

  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp}),/trusted fetcher/);
  await assert.rejects(()=>prepareReviewAdmission({fetcher}),/Store checkout/);
  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp,fetcher,reviewerAgentId:'dev-cursor-01'}),
    /unregistered reviewer identity/);
  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp,
    fetcher:async(endpoint)=>endpoint.startsWith('git/trees/')?{tree:[]}:fetcher(endpoint)}),
    /admitted file missing/);
  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp,
    fetcher:async(endpoint)=>endpoint.startsWith('commits/')?{sha:HEAD,parents:[{sha:MAIN}]}:fetcher(endpoint)}),
    /missing exact head tree/);
  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp,
    fetcher:async(endpoint)=>endpoint==='actions/runs/39609600546'?{...publisherRun,id:1}:fetcher(endpoint)}),
    /unauthenticated trusted Publisher Run/);
  fs.writeFileSync(intentPath,'{}');
  await assert.rejects(()=>prepareReviewAdmission({storeRoot:temp,fetcher}),
    /untrusted or conflicting immutable Publisher intent/);
  console.log('Reviewer admission prep: fetched facts + committed intent build cursor and Qwen admissions; missing fact, store and identity negatives passed without network');
}finally{
  fs.rmSync(temp,{recursive:true,force:true});
}

// Real #3784 original Rust base is >32KiB; the signed Reviewer admission
// cannot contain full source bytes (16KiB cap). The GitHub base must still be
// fetched and checked, without silently claiming an incomplete base file.
const baseSha='c'.repeat(40),changed=[{filename:'src/large.rs'}];
let reads=0;
const fetchBase=content=>async endpoint=>{
  assert.equal(endpoint,'contents/src/large.rs?ref='+baseSha);
  reads++;
  return {encoding:'base64',content:Buffer.from(content).toString('base64'),
    size:Buffer.byteLength(content)};
};
const large='x'.repeat(34891);
assert.deepEqual(await boundedQwenReviewBaseFiles({
  files:changed,baseSha,fetcher:fetchBase(large)}),[]);
assert.equal(reads,1,'large original base still independently fetched');
// #4192 authentic #4065/#4191 base websocket.rs is ~161KiB; the source is
// valid but cannot fit the optional base embedding bound. Reviewer must run.
const realSize=161379;
assert.deepEqual(await boundedQwenReviewBaseFiles({
  files:changed,baseSha,fetcher:fetchBase('x'.repeat(realSize))}),[],
  'valid >128KiB base is omitted, not rejected');
const small='pub fn small() {}\\n';
assert.deepEqual(await boundedQwenReviewBaseFiles({
  files:changed,baseSha,fetcher:fetchBase(small)}),
  [{path:'src/large.rs',content:small}]);
const two=[{filename:'src/large.rs'},{filename:'src/second.rs'}];
assert.deepEqual(await boundedQwenReviewBaseFiles({
  files:two,baseSha,fetcher:async p=>({
    encoding:'base64',
    content:Buffer.from(p.includes('second.rs')?
      'y'.repeat(realSize):small).toString('base64'),
    size:p.includes('second.rs')?realSize:Buffer.byteLength(small),
  })}),[],
  'mixed small + valid oversized source returns no partial base context');
assert.deepEqual(await boundedQwenReviewBaseFiles({
  files:two,baseSha,fetcher:async p=>({
    encoding:'base64',content:Buffer.from(p.includes('second.rs')?
      'y'.repeat(5000):small).toString('base64')})}),[],
  'no partial originals may masquerade as complete base context');
for(const fake of [
  {encoding:'utf8',content:'hello'},
  {encoding:'base64',content:'***'},
  {encoding:'base64',content:Buffer.from('x').toString('base64'),size:2},
  {encoding:'base64',content:Buffer.from('y'.repeat(129*1024)).toString('base64'),size:2},
]){
  await assert.rejects(()=>boundedQwenReviewBaseFiles({
    files:changed,baseSha,fetcher:async()=>fake}),
    /authenticated PR base file|unsafe PR base file/);
}
await assert.rejects(()=>boundedQwenReviewBaseFiles({
  files:changed,baseSha:'untrusted',fetcher:fetchBase('x')}),
  /invalid Qwen Review base-file/);

// Keep the canonical reviewer Gate authoritative for the Qwen source tests.
await import('./qwen-pr-admission-selftest.mjs');
