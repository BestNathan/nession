#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTROLLED_1997_POLICY as P} from './controlled-proposal.mjs';
import {planControlledPublisherIntent,
  CONTROLLED_PUBLISHER_BRANCH as BRANCH} from './store-intent.mjs';
import {assertControlledPublisherAuthority,CONTROLLED_PUBLISH_COMMENT,
  publishControlledGitHubPR} from './github-publish.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const gitBlobSha=b=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b,
])).digest('hex');
const env={
  GITHUB_REPOSITORY:'BestNathan/nession',GITHUB_REF:'refs/heads/main',
  GITHUB_ACTOR:'BestNathan',GITHUB_EVENT_NAME:'issue_comment',
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'999',
  GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW:'Store / Controlled Publisher',
};
const event={action:'created',issue:{number:1997,state:'open'},
  comment:{user:{login:'BestNathan'},body:CONTROLLED_PUBLISH_COMMENT}};
assert.deepEqual(assertControlledPublisherAuthority(env,event),{
  issuer_run_id:999,target_main_sha:env.GITHUB_SHA,
});
for(const change of [
  {GITHUB_REPOSITORY:'attacker/repo'},{GITHUB_REF:'refs/pull/1/head'},
  {GITHUB_ACTOR:'attacker'},{GITHUB_EVENT_NAME:'pull_request_target'},
  {GITHUB_RUN_ATTEMPT:'2'},{GITHUB_SHA:'main'},
  {GITHUB_WORKFLOW:'Agent / Development'},
])assert.throws(()=>assertControlledPublisherAuthority({...env,...change},event),
  /unauthorized/);
for(const change of [
  {action:'edited'},{issue:{number:1664,state:'open'}},
  {issue:{number:1997,state:'closed'}},
  {comment:{...event.comment,user:{login:'attacker'}}},
  {comment:{...event.comment,body:'/nession publish issue=1997 checkpoint=2'}},
])assert.throws(()=>assertControlledPublisherAuthority(env,{...event,...change}),
  /unauthorized/);

const patch='trusted controlled file diff\n';
const patchSha=sha(patch),blobSha=gitBlobSha(Buffer.from(P.content));
const prepared={
  kind:'trusted_publisher_preflight_only',status:'preflight_only',
  issue:1997,action_id:P.action_id,worker_run_id:P.run_id,
  worker_run_attempt:P.attempt,source_sha:P.source_sha,
  checkpoint_version:P.checkpoint_version,
  checkpoint_commit_sha:P.checkpoint_commit_sha,
  source_result_sha256:sha(P.content),
  patch_sha256:patchSha,patch,
  preflight:{files:[{path:P.file,operation:'create',new_sha256:sha(P.content)}]},
};
const intent={
  status:'committed',may_publish:true,store_commit_sha:'e'.repeat(40),
  record:planControlledPublisherIntent({
    target_main_sha:env.GITHUB_SHA,patch_sha256:patchSha,issuer_run_id:999,
  }),
};
const baseTree='8'.repeat(40),newTree='9'.repeat(40),commitSha='7'.repeat(40);
function mockedApi({existingPr=false,existingBranch=false,corruptBlob=false,
  failPrPost=false,badPrFile=false,staleMain=false}={}){
  const calls=[],pr=43;
  const api=async(method,endpoint,payload)=>{
    calls.push({method,endpoint,payload});
    if(method==='GET'&&endpoint==='git/ref/heads/main')
      return {ref:'refs/heads/main',object:{sha:staleMain?'0'.repeat(40):env.GITHUB_SHA}};
    if(method==='GET'&&endpoint.startsWith('pulls?'))
      return existingPr?[{number:23}]:[];
    if(method==='GET'&&endpoint==='git/ref/heads/'+BRANCH){
      if(!existingBranch&&calls.some(x=>x.method==='POST'&&x.endpoint==='git/refs'))
        return {ref:'refs/heads/'+BRANCH,object:{sha:commitSha}};
      if(existingBranch)return {ref:'refs/heads/'+BRANCH,object:{sha:commitSha}};
      throw Object.assign(Error('Not Found'),{status:404});
    }
    if(method==='GET'&&endpoint==='git/commits/'+env.GITHUB_SHA)
      return {sha:env.GITHUB_SHA,tree:{sha:baseTree}};
    if(method==='POST'&&endpoint==='git/blobs')
      return {sha:corruptBlob?'1'.repeat(40):blobSha};
    if(method==='POST'&&endpoint==='git/trees')
      return {sha:newTree};
    if(method==='POST'&&endpoint==='git/commits')
      return {sha:commitSha,tree:{sha:newTree}};
    if(method==='POST'&&endpoint==='git/refs')
      return {ref:'refs/heads/'+BRANCH,object:{sha:commitSha}};
    if(method==='POST'&&endpoint==='pulls'){
      if(failPrPost)throw Error('timeout-after-GitHub-created-PR');
      return {number:pr};
    }
    if(method==='GET'&&endpoint==='pulls/'+pr)
      return {number:pr,state:'open',
        head:{sha:commitSha,ref:BRANCH,repo:{full_name:'BestNathan/nession'}},
        base:{ref:'main'}};
    if(method==='GET'&&endpoint==='pulls/'+pr+'/files?per_page=100')
      return [{filename:badPrFile?'.github/workflows/evil.yml':P.file,
        status:'added',sha:blobSha}];
    throw Error('Unexpected mocked API '+method+' '+endpoint);
  };
  return {api,calls};
}
const mock=mockedApi();
const receipt=await publishControlledGitHubPR({prepared,intent,api:mock.api});
assert.equal(receipt.status,'published_verified_by_github');
assert.equal(receipt.pull_request,43);
assert.equal(receipt.branch,BRANCH);
assert.equal(receipt.head_sha,commitSha);
assert.equal(receipt.publication_intent_store_sha,intent.store_commit_sha);
assert.equal(receipt.patch_sha256,patchSha);
assert.deepEqual(mock.calls.filter(c=>c.method==='POST').map(c=>c.endpoint),
  ['git/blobs','git/trees','git/commits','git/refs','pulls']);
assert.equal(mock.calls.find(c=>c.endpoint==='git/trees').payload.tree[0].path,P.file);
assert.equal(mock.calls.find(c=>c.endpoint==='pulls').payload.draft,false);
assert.equal(mock.calls.find(c=>c.endpoint==='pulls').payload.base,'main');
assert.equal(mock.calls.find(c=>c.endpoint==='pulls').payload.head,BRANCH);
for(const corrupt of [
  {status:'reconcile',may_publish:false},
  {store_commit_sha:'bad'},
  {record:{...intent.record,patch_sha256:'0'.repeat(64)}},
  {record:{...intent.record,target_main_sha:'0'.repeat(40)}},
])await assert.rejects(()=>publishControlledGitHubPR({
  prepared,intent:{...intent,...corrupt},api:async()=>{throw Error('unexpected API');},
}),/no first immutable|untrusted|mismatched/);
for(const change of [
  {source_sha:'0'.repeat(40)},{status:'published'},
  {action_id:'0'.repeat(64)},
  {source_result_sha256:'0'.repeat(64)},
  {patch_sha256:'0'.repeat(64)},
  {preflight:{files:[{path:'.github/workflows/ci.yml',operation:'create',
    new_sha256:sha(P.content)}]}},
])await assert.rejects(()=>publishControlledGitHubPR({
  prepared:{...prepared,...change},intent,api:async()=>{throw Error('unexpected API');},
}),/unverified/);
for(const [scenario,pattern,expectedPostCount] of [
  [{existingPr:true},/existing exact branch PR/,0],
  [{existingBranch:true},/preexisting GitHub branch/,0],
  [{staleMain:true},/stale target main SHA/,0],
  [{corruptBlob:true},/GitHub original file blob SHA/,1],
  [{failPrPost:true},/timeout-after-GitHub-created-PR/,5],
  [{badPrFile:true},/PR patch modifies unauthorized/,5],
]){
  const {api,calls}=mockedApi(scenario);
  await assert.rejects(()=>publishControlledGitHubPR({prepared,intent,api}),pattern);
  assert.equal(calls.filter(c=>c.method==='POST').length,expectedPostCount);
}
console.log('Trusted GitHub Publisher: exact owner command, fresh Store CAS, deterministic branch/one PR, source blob/HEAD/readback, wrong Actor/path/SHA, preexisting PR, stale main and ambiguous timeout negatives passed; no live API writes');
