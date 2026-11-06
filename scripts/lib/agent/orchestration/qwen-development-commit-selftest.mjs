#!/usr/bin/env node
// #2274: real Git Store v1->v3 signed dispatch, Qwen-native ciphertext
// candidate, canonical checkpoint CAS -> Outbox Slice Yield -> exact replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {startDevelopment,recordDispatchIntent,recordDispatch,
  acceptTaskResult,bindVerifiedRepairCheckpoint} from './outbox.mjs';
import {attestQwenPublishedRepairCheckpoint,qwenRepairPublishedSource}
  from './qwen-repair-checkpoint.mjs';
import {bindQwenRepairCheckpoint} from './dispatch-store.mjs';
import {sourceAllowed} from './controller-dispatch.mjs';
import {planGitHubDispatch} from './github-dispatch.mjs';
import {writeIssueWorkflowState,readIssueWorkflowState}
  from './state-store.mjs';
import {publish} from '../../../run-store-cas-push.mjs';
import {prepareQwenDevelopmentSource,collectQwenDevelopmentPatch}
  from './qwen-development-source.mjs';
import {sealQwenDevelopmentProposal}
  from './qwen-development-evidence.mjs';
import {ingestQwenVerifiedCandidate,qwenCheckpointNextVersion}
  from './qwen-development-commit.mjs';
import {preflightTrustedQwenPublisher}
  from '../publisher/qwen-source-preflight.mjs';
import {commitQwenPublisherIntent}
  from '../publisher/store-intent.mjs';
import {materializeQwenTrustedBlobs,publishTrustedQwenGitHubPR,
  readBackQwenPublishedPR} from '../publisher/qwen-github-publish.mjs';
import {applyQwenPublicationToRemote}
  from '../publisher/publication-ingest.mjs';

const priorNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-real-store-'));
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000}).trim();
const sha256=x=>createHash('sha256').update(x).digest('hex');
const key=Buffer.alloc(32,33),aesKey=Buffer.alloc(32,59);
try {
  const writer=path.join(home,'writer'),source=path.join(home,'source');
  const remote=path.join(home,'agent-store.git');
  fs.mkdirSync(writer);fs.mkdirSync(source);
  git(home,'init','--bare','agent-store.git');
  git(writer,'init');git(writer,'config','user.name','Qwen Store Case');
  git(writer,'config','user.email','qwen@example.invalid');
  git(writer,'switch','--orphan','agent-store');
  git(writer,'commit','--allow-empty','-m','bootstrap Store');
  git(writer,'remote','add','origin',remote);
  git(writer,'push','origin','HEAD:refs/heads/agent-store');
  git(source,'init');git(source,'config','user.name','Qwen Edit Case');
  git(source,'config','user.email','edit@example.invalid');
  fs.writeFileSync(path.join(source,'calc.js'),
    'module.exports = (a, b) => a - b;\n');
  git(source,'add','calc.js');git(source,'commit','-m','trusted input');
  const inputSha=git(source,'rev-parse','HEAD');
  const issue=2274,workerId=550011,issuerId=902;
  const signer={key,key_id:'main-controller',issuer_run_id:issuerId,
    now:Date.parse('2026-11-05T12:00:00Z'),ttl_ms:600000};
  const ctx={repository:'BestNathan/nession',event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:issuerId};
  const request={issue,sha:inputSha,developer:'dev-qwen-01',
    reviewer:'review-qwen-01',acceptor:'accept-qwen-01'};
  const initial=startDevelopment(registry,request,ctx);
  const action=initial.outbox[0];
  const signed=planGitHubDispatch(initial,action.id,registry,signer);
  const prepared=recordDispatchIntent(initial,1,action.id,{
    status:'prepared',dispatch_id:action.id,issuer_run_id:issuerId,
    ticket_sha256:sha256(signed.inputs.dispatch_ticket)});
  const acknowledged=recordDispatch(prepared,2,action.id,{
    status:'verified',dispatch_id:action.id,source_run_id:workerId});
  const save=(state,old)=>{
    writeIssueWorkflowState(writer,state,old);
    git(writer,'add','-A');
    git(writer,'commit','-m','stored signed Dispatch v'+state.version);
    publish('agent-store',writer,4);
  };
  save(initial,0);save(prepared,1);save(acknowledged,2);
  assert.equal(qwenCheckpointNextVersion({
    authorized:true,role:'developer',agent_id:'dev-qwen-01',
    provider:'claude-code',task:'implement'}, {version:0}),1);
  assert.throws(()=>qwenCheckpointNextVersion({
    authorized:true,role:'developer',agent_id:'dev-qwen-01',
    provider:'claude-code',task:'implement'}, {version:1}),
    /head advanced/);
  const runHeadSha='a'.repeat(40),repo={full_name:'BestNathan/nession'};
  const run={id:workerId,run_attempt:1,name:'Agent / Development',
    path:'.github/workflows/agent-develop.yml',
    event:'workflow_dispatch',head_branch:'main',head_sha:runHeadSha,
    repository:repo,head_repository:repo,actor:{login:'github-actions[bot]'},
    status:'completed',conclusion:'success',
    created_at:'2026-11-05T12:01:00Z'};
  const issuer={id:issuerId,
    name:'Agent / Controller Dispatch',
    path:'.github/workflows/agent-controller-dispatch.yml',
    event:'workflow_dispatch',head_branch:'main',head_sha:runHeadSha,
    repository:repo,head_repository:repo,actor:{login:'BestNathan'},
    run_attempt:1};
  const reader={getRun:async id=>{
    if(id===issuerId)return issuer;
    if(id===workerId)return run;
    throw Error('unexpected source Run');
  }};
  const admission={authorized:true,role:'developer',task:'implement',
    issue,action_id:action.id,input_sha:inputSha,run_id:workerId,
    agent_id:'dev-qwen-01',provider:'claude-code',
    environment:'dev-claude-qwen'};
  const selected={ANTHROPIC_MODEL:'qwen3.7-plus',
    ANTHROPIC_BASE_URL:'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    ANTHROPIC_AUTH_TOKEN:'test-only-not-a-real-credential'};
  const snapshot=prepareQwenDevelopmentSource({admission,registry,
    environment:selected,cliVersion:'2.1.34',workspace:source,
    allowedFiles:['calc.js']});
  fs.writeFileSync(path.join(source,'calc.js'),
    'module.exports = (a, b) => a + b;\n');
  const events=['Read','Edit'].map((name,i)=>({type:'assistant',
    message:{content:[{type:'tool_use',id:'qwen-'+i,name}]}}));
  const patch=collectQwenDevelopmentPatch(snapshot,{events});
  const nativeDir=path.join(home,'native');
  const project=path.join(nativeDir,'projects','-workspace');
  fs.mkdirSync(project,{recursive:true});
  const sessionId='550e8400-e29b-41d4-a716-446655440000';
  fs.writeFileSync(path.join(project,sessionId+'.jsonl'),
    JSON.stringify({sessionId,type:'user',message:'PRIVATE_QWEN_MARKER'})+'\n');
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicKeyPem=rsa.publicKey.export({type:'spki',format:'pem'});
  const privateKeyPem=rsa.privateKey.export({type:'pkcs8',format:'pem'});
  const candidate=sealQwenDevelopmentProposal({
    admission,snapshot,patch,sessionId,configDir:nativeDir,publicKeyPem});
  const claim={inputs:signed.inputs};
  const args={remote,registry,run,claim,reader,rootKey:key,
    aesKey,privateKeyPem,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext};
  const accepted=await ingestQwenVerifiedCandidate(args);
  assert.equal(accepted.status,'committed');
  assert.equal(accepted.checkpoint.version,1);
  assert.match(accepted.checkpoint.commit_sha,/^[a-f0-9]{40}$/);
  assert.equal(accepted.action_id,action.id);
  assert.ok(!JSON.stringify(accepted).includes('PRIVATE_QWEN_MARKER'));
  const cloned=path.join(home,'readback');
  git(home,'clone','--branch','agent-store',remote,cloned);
  const record=readIssueWorkflowState(cloned,issue);
  assert.equal(record.version,3);
  const original=record.state.outbox.find(a=>a.id===action.id);
  assert.equal(original.status,'dispatched');
  assert.equal(original.receipt.source_run_id,workerId);
  assert.equal(record.state.outbox.filter(a=>a.task.role==='developer').length,1);
  const replay=await ingestQwenVerifiedCandidate(args);
  assert.equal(replay.status,'replayed');
  assert.equal(replay.checkpoint.commit_sha,accepted.checkpoint.commit_sha);
  assert.equal(replay.checkpoint.ciphertext_sha256,
    accepted.checkpoint.ciphertext_sha256);
  assert.equal(readIssueWorkflowState(cloned,issue).version,record.version);
  // A second RSA envelope is not an idempotent original Run, even if the
  // signed Action, native UUID and proposed source patch are unchanged.
  const forgedReplay=sealQwenDevelopmentProposal({
    admission,snapshot,patch,sessionId,configDir:nativeDir,publicKeyPem});
  assert.notEqual(forgedReplay.ciphertext.ciphertext_sha256,
    candidate.ciphertext.ciphertext_sha256);
  await assert.rejects(()=>ingestQwenVerifiedCandidate({...args,
    result:forgedReplay.result,proof:forgedReplay.proof,
    ciphertext:forgedReplay.ciphertext}),
    /Qwen replay differs from immutable native ciphertext or patch/);
  // The Publisher independently reads the exact signed source Run, immutable
  // native checkpoint, and applies the Worker patch to a CLEAN isolated Git
  // checkout, even though the model's disposable source is now modified.
  const pubCheckout=path.join(home,'publisher-source');
  git(home,'clone','--no-hardlinks',source,pubCheckout);
  const published=await preflightTrustedQwenPublisher({
    remote,registry,run,claim,reader,rootKey:key,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext,sourceCheckout:pubCheckout});
  assert.equal(published.evidence.issue,issue);
  assert.equal(published.evidence.action_id,action.id);
  assert.equal(published.evidence.worker_run_id,workerId);
  assert.equal(published.evidence.checkpoint_commit_sha,
    accepted.checkpoint.commit_sha);
  assert.equal(published.evidence.patch_sha256,patch.patch_sha256);
  assert.equal(published.evidence.file_manifest.length,1);
  assert.equal(published.evidence.file_manifest[0].path,'calc.js');
  assert.match(published.patch,/module.exports/);
  assert.ok(!JSON.stringify(published).includes('PRIVATE_QWEN_MARKER'));
  assert.equal(published.evidence.status,'preflight_only');
  for(const bad of [
    {run:{...run,id:workerId+1}},
    {run:{...run,actor:{login:'attacker'}}},
    {claim:{inputs:{...signed.inputs,agent_id:'dev-cursor-01'}}},
    {result:{...candidate.result,patch_sha256:'a'.repeat(64)}},
    {proof:{...candidate.proof,changed_paths:['scripts/lib/agent/evil.js']}},
  ]){
    await assert.rejects(()=>preflightTrustedQwenPublisher({
      remote,registry,run,claim,reader,rootKey:key,
      result:candidate.result,proof:candidate.proof,
      ciphertext:candidate.ciphertext,sourceCheckout:pubCheckout,
      ...bad}),/Qwen|claim|dispatch|candidate|Publisher|Developer/i);
  }
  const wrongSource=path.join(home,'publisher-wrong-sha');
  git(home,'clone','--no-hardlinks',source,wrongSource);
  fs.writeFileSync(path.join(wrongSource,'other.js'),'const bad=true;\n');
  git(wrongSource,'add','other.js');
  git(wrongSource,'config','user.name','Wrong Source');
  git(wrongSource,'config','user.email','wrong@example.invalid');
  git(wrongSource,'commit','-m','different source');
  await assert.rejects(()=>preflightTrustedQwenPublisher({
    remote,registry,run,claim,reader,rootKey:key,
    result:candidate.result,proof:candidate.proof,
    ciphertext:candidate.ciphertext,sourceCheckout:wrongSource,
  }),/Agent patch preflight/);


  // One independent Publisher job must fence its GitHub POST with an
  // immutable Store results/ Intent, then read back exact PR HEAD and files,
  // and only then enqueue exactly one Reviewer through canonical State CAS.
  const publisherRun=992233;
  const intent=commitQwenPublisherIntent({remote,preflight:published,
    target_main_sha:inputSha,publisher_run_id:publisherRun});
  assert.equal(intent.status,'committed');
  assert.equal(intent.may_publish,true);
  const replayIntent=commitQwenPublisherIntent({remote,preflight:published,
    target_main_sha:inputSha,publisher_run_id:publisherRun});
  assert.equal(replayIntent.status,'reconcile');
  assert.equal(replayIntent.may_publish,false);
  assert.throws(()=>commitQwenPublisherIntent({remote,preflight:published,
    target_main_sha:inputSha,publisher_run_id:publisherRun+1}),
    /conflicting immutable/);
  const blobs=materializeQwenTrustedBlobs({
    sourceCheckout:pubCheckout,preflight:published,intent});
  assert.equal(blobs.length,1);
  assert.equal(blobs[0].path,'calc.js');
  const blobSha=blobs[0].git_blob_sha;
  const treeSha='d'.repeat(40);
  // Match the mocked Publisher PR HEAD to an actual Git commit so the
  // repair Worker uses a real checked-out SHA B, never an invented source.
  const repairSource=path.join(home,'qwen-real-published-branch');
  git(home,'clone','--no-hardlinks',source,repairSource);
  git(repairSource,'config','user.name','Qwen Repair Case');
  git(repairSource,'config','user.email','repair@example.invalid');
  fs.writeFileSync(path.join(repairSource,'calc.js'),
    'module.exports = (a, b) => a + b;\n');
  git(repairSource,'add','--','calc.js');
  git(repairSource,'commit','-m','actual Qwen published source');
  const commitSha=git(repairSource,'rev-parse','HEAD');
  const branch=intent.record.branch;
  const prNumber=4817;
  let posts=0,wasRefCreated=false,wasPRCreated=false;
  const repoIdentity={full_name:'BestNathan/nession'};
  const expectedPR={number:prNumber,state:'open',
    head:{sha:commitSha,ref:branch,repo:repoIdentity},
    base:{ref:'main',repo:repoIdentity}};
  const api=async(method,endpoint,body)=>{
    if(method==='GET'){
      if(endpoint==='git/ref/heads/main')
        return {ref:'refs/heads/main',object:{sha:inputSha}};
      if(endpoint.startsWith('pulls?state=all&head=BestNathan:'))
        return wasPRCreated?[expectedPR]:[];
      if(endpoint==='git/ref/heads/'+branch){
        if(!wasRefCreated)throw Object.assign(Error('missing'),{status:404});
        return {ref:'refs/heads/'+branch,object:{sha:commitSha}};
      }
      if(endpoint==='git/commits/'+inputSha)
        return {tree:{sha:'f'.repeat(40)}};
      if(endpoint==='git/commits/'+commitSha)
        return {parents:[{sha:inputSha}],tree:{sha:treeSha}};
      if(endpoint==='pulls/'+prNumber)return expectedPR;
      if(endpoint==='pulls/'+prNumber+'/files?per_page=100')
        return [{filename:'calc.js',status:'modified',sha:blobSha}];
      throw Error('unexpected read-only GitHub API '+endpoint);
    }
    assert.equal(method,'POST');
    posts++;
    if(endpoint==='git/blobs'){
      assert.equal(body.encoding,'base64');
      assert.equal(body.content,blobs[0].content_base64);
      return {sha:blobSha};
    }
    if(endpoint==='git/trees'){
      assert.equal(body.base_tree,'f'.repeat(40));
      assert.deepEqual(body.tree,[{path:'calc.js',mode:'100644',
        type:'blob',sha:blobSha}]);
      return {sha:treeSha};
    }
    if(endpoint==='git/commits'){
      assert.equal(body.tree,treeSha);
      assert.deepEqual(body.parents,[inputSha]);
      return {sha:commitSha,tree:{sha:treeSha}};
    }
    if(endpoint==='git/refs'){
      assert.equal(body.sha,commitSha);
      wasRefCreated=true;
      return {ref:'refs/heads/'+branch,object:{sha:commitSha}};
    }
    if(endpoint==='pulls'){
      assert.equal(body.head,branch);
      assert.equal(body.base,'main');
      wasPRCreated=true;
      return expectedPR;
    }
    throw Error('unexpected mutating GitHub API '+endpoint);
  };
  const publishedPR=await publishTrustedQwenGitHubPR({
    preflight:published,intent,sourceCheckout:pubCheckout,api});
  assert.equal(publishedPR.head_sha,commitSha);
  assert.equal(publishedPR.pull_request,prNumber);
  assert.equal(posts,5);
  const readback=await readBackQwenPublishedPR({preflight:published,
    intent:replayIntent,sourceCheckout:pubCheckout,api});
  assert.equal(readback.head_sha,commitSha);
  assert.equal(posts,5,'GET-only recovery must never retry a PR POST');
  await assert.rejects(()=>publishTrustedQwenGitHubPR({
    preflight:published,intent:replayIntent,
    sourceCheckout:pubCheckout,api}),/first authenticated/);
  const handoff=applyQwenPublicationToRemote({remote,
    readback,intent,registry});
  assert.equal(handoff.changed,true);
  assert.equal(handoff.target_sha,commitSha);
  assert.equal(handoff.reviewer_agent_id,'review-qwen-01');
  const reHandoff=applyQwenPublicationToRemote({remote,
    readback,intent,registry});
  assert.equal(reHandoff.changed,false);
  const post=path.join(home,'after-publisher');
  git(home,'clone','--branch','agent-store',remote,post);
  const after=readIssueWorkflowState(post,issue);
  assert.equal(after.state.phase,'review');
  assert.equal(after.state.target_sha,commitSha);
  assert.equal(after.state.outbox.filter(x=>x.task.role==='reviewer').length,1);
  assert.equal(after.state.outbox.filter(x=>x.task.role==='developer').length,0);
  assert.equal(after.state.transitions.filter(x=>x.kind==='publisher').length,1);
  // Independently attested Reviewer changes_requested must select the exact
  // same Qwen Developer's immutable native checkpoint, not an Issue/model
  // selected origin. The original published Developer Action is retired.
  const reviewAction=after.state.outbox.find(x=>x.task.role==='reviewer');
  const reviewRun=991177;
  const reviewPrepared=recordDispatchIntent(after.state,after.version,
    reviewAction.id,{status:'prepared',dispatch_id:reviewAction.id,
      issuer_run_id:publisherRun+1,ticket_sha256:'b'.repeat(64)});
  const reviewDispatched=recordDispatch(reviewPrepared,
    reviewPrepared.version,reviewAction.id,{
      status:'verified',dispatch_id:reviewAction.id,source_run_id:reviewRun});
  const reviewAccepted=acceptTaskResult(reviewDispatched,
    reviewDispatched.version,{
      kind:'reviewer',issue,run_id:reviewRun,run_attempt:1,
      target_sha:commitSha,outcome:'changes_requested',
      task_id:reviewAction.id,
    },{
      repository:'BestNathan/nession',path:'.github/workflows/agent-review.yml',
      name:'Agent / Review',run_id:reviewRun,attempt:1,
      event:'workflow_dispatch',ref:'refs/heads/main',issue,
      task_id:reviewAction.id,agent_id:'review-qwen-01',
      input_sha:commitSha,output_sha:commitSha,verified:true,
    },registry);
  assert.equal(reviewAccepted.phase,'repair');
  const originalRepair=reviewAccepted.outbox.find(x=>
    x.task.role==='developer'&&x.task.task==='repair');
  assert.equal(originalRepair.status,'pending');
  for(const next of [reviewPrepared,reviewDispatched,reviewAccepted]){
    const old=readIssueWorkflowState(post,issue);
    writeIssueWorkflowState(post,next,old.version);
    git(post,'add','-A');
    git(post,'-c','user.name=Qwen Store Case',
      '-c','user.email=qwen@example.invalid','commit',
      '-m','verified Qwen Review and Repair v'+next.version);
    publish('agent-store',post,4);
  }
  const immutableOrigin=attestQwenPublishedRepairCheckpoint({
    storeRoot:post,state:reviewAccepted,actionId:originalRepair.id});
  assert.deepEqual(immutableOrigin,{verified:true,
    checkpoint_version:accepted.checkpoint.version,
    checkpoint_commit_sha:accepted.checkpoint.commit_sha,
    ciphertext_sha256:accepted.checkpoint.ciphertext_sha256,
    source_sha:inputSha,source_run_id:workerId});
  const boundRepair=bindVerifiedRepairCheckpoint(reviewAccepted,
    reviewAccepted.version,originalRepair.id,immutableOrigin);
  assert.equal(boundRepair.version,reviewAccepted.version+1);
  assert.deepEqual(boundRepair.outbox.find(x=>x.id===originalRepair.id)
    .task.repair_checkpoint,{
      checkpoint_version:accepted.checkpoint.version,
      checkpoint_commit_sha:accepted.checkpoint.commit_sha,
      ciphertext_sha256:accepted.checkpoint.ciphertext_sha256,
      source_sha:inputSha,source_run_id:workerId});
  assert.equal(bindVerifiedRepairCheckpoint(boundRepair,boundRepair.version,
    originalRepair.id,immutableOrigin),boundRepair,'exact replay is a no-op');
  for(const forgedState of [
    {...reviewAccepted,phase:'review'},
    {...reviewAccepted,target_sha:'f'.repeat(40)},
    {...reviewAccepted,assignments:{...reviewAccepted.assignments,
      developer:'dev-cursor-01'}},
    {...reviewAccepted,transitions:reviewAccepted.transitions.slice(0,-1)},
  ])assert.throws(()=>attestQwenPublishedRepairCheckpoint({
    storeRoot:post,state:forgedState,actionId:originalRepair.id}),
    /trusted Qwen Repair origin|agent outbox/);
  assert.throws(()=>attestQwenPublishedRepairCheckpoint({
    storeRoot:post,state:reviewAccepted,actionId:'f'.repeat(64)}),
    /trusted Qwen Repair origin/);
  const cpPath='roles/developer/dev-qwen-01/issues/'+issue+
    '/checkpoints/00000001.json';
  const originalCheckpointBytes=fs.readFileSync(path.join(post,cpPath));
  try{
    fs.writeFileSync(path.join(post,cpPath),
      originalCheckpointBytes.toString('utf8').replace(
        accepted.checkpoint.ciphertext_sha256,'f'.repeat(64)));
    assert.throws(()=>attestQwenPublishedRepairCheckpoint({
      storeRoot:post,state:reviewAccepted,actionId:originalRepair.id}),
      /trusted Qwen Repair origin/);
  }finally{fs.writeFileSync(path.join(post,cpPath),originalCheckpointBytes);}
  // Owner/main Controller binds exactly once through the canonical
  // versioned Store CAS, then fetches ONLY the signed original PR ref.
  const boundRemote=bindQwenRepairCheckpoint({
    remote,issue,actionId:originalRepair.id});
  assert.equal(boundRemote.status,'bound');
  assert.equal(boundRemote.state_version,boundRepair.version);
  assert.equal(bindQwenRepairCheckpoint({
    remote,issue,actionId:originalRepair.id}).status,'replayed');
  // The reviewed action was consumed and pruned by the canonical
  // transition; a stale Reviewer ID cannot be resurrected as a Repair.
  assert.throws(()=>bindQwenRepairCheckpoint({
    remote,issue,actionId:reviewAction.id}),/pending Action not found/);
  assert.throws(()=>bindQwenRepairCheckpoint({
    remote,issue,actionId:'f'.repeat(64)}),
    /pending Action not found/);
  git(post,'pull','--ff-only','origin','agent-store');
  const storedBound=readIssueWorkflowState(post,issue);
  assert.equal(storedBound.version,boundRepair.version);
  const boundAction=storedBound.state.outbox.find(x=>x.id===originalRepair.id);
  const repairPublishedSource=qwenRepairPublishedSource({
    storeRoot:post,issue,actionId:originalRepair.id,sha:commitSha});
  assert.equal(repairPublishedSource.review_sha,commitSha);
  assert.equal(repairPublishedSource.base_sha,inputSha);
  assert.equal(repairPublishedSource.branch,'refs/heads/'+branch);
  assert.throws(()=>qwenRepairPublishedSource({
    storeRoot:post,issue,actionId:originalRepair.id,sha:'f'.repeat(40)}),
    /trusted Qwen Repair origin/);
  const calls=[];
  const acceptedGit=(args)=>{
    calls.push(args);
    if(args[0]==='fetch')return '';
    if(args[0]==='rev-parse')return commitSha;
    if(args[0]==='cat-file')return '';
    if(args[0]==='merge-base')return '';
    throw Error('unexpected Controller Git operation');
  };
  assert.doesNotThrow(()=>sourceAllowed(commitSha,'developer',{
    task:boundAction.task,context:{storeRoot:post,issue,actionId:originalRepair.id},
    mainSha:inputSha,run:acceptedGit}));
  assert.deepEqual(calls,[
    ['fetch','--quiet','--no-tags','origin','refs/heads/'+branch],
    ['rev-parse','FETCH_HEAD'],
    ['cat-file','-e',commitSha+'^{commit}'],
    ['merge-base','--is-ancestor',inputSha,commitSha],
  ]);
  assert.throws(()=>sourceAllowed(commitSha,'developer',{
    task:boundAction.task,context:{storeRoot:post,issue,actionId:originalRepair.id},
    mainSha:inputSha,run:args=>args[0]==='rev-parse'?'f'.repeat(40):''}),
    /published Qwen PR source ref unavailable or changed/);
  assert.equal(posts,5,
    'Owner Repair binding and ref readback never call GitHub PR POST');
  for(const wrong of [
    {...readback,head_sha:'0'.repeat(40)},
    {...readback,source_run_id:workerId+1},
    {...readback,publisher_run_id:publisherRun+1},
    {...readback,checkpoint_commit_sha:'0'.repeat(40)},
  ])assert.throws(()=>applyQwenPublicationToRemote({
    remote,readback:wrong,intent,registry}),/Publisher|Qwen/i);
  assert.equal(posts,5,'Store handoff must not send new model or GitHub POST');

  // The same Qwen Developer must restore the original encrypted native
  // Session at the ACTUAL published PR commit in a separately authenticated
  // Worker Run and store the next immutable ciphertext checkpoint.
  // No real network/model call or Reviewer approval is simulated as Pass.
  // The Owner Controller already CAS-bound this exact source above.
  // Read the committed State rather than inventing a second identical
  // Store commit; only an unbound original Action can be bound once.
  const repairBound=readIssueWorkflowState(post,issue).state;
  assert.deepEqual(repairBound.outbox.find(x=>
    x.id===originalRepair.id).task.repair_checkpoint,
    boundRepair.outbox.find(x=>x.id===originalRepair.id).task.repair_checkpoint);
  const repairSigner={...signer,issuer_run_id:issuerId};
  const repairSigned=planGitHubDispatch(repairBound,originalRepair.id,
    registry,repairSigner);
  const repairIntent=recordDispatchIntent(repairBound,repairBound.version,
    originalRepair.id,{status:'prepared',dispatch_id:originalRepair.id,
      issuer_run_id:issuerId,
      ticket_sha256:sha256(repairSigned.inputs.dispatch_ticket)});
  const repairWorkerId=workerId+1;
  const repairDispatched=recordDispatch(repairIntent,repairIntent.version,
    originalRepair.id,{status:'verified',dispatch_id:originalRepair.id,
      source_run_id:repairWorkerId});
  for(const state of [repairIntent,repairDispatched]){
    const current=readIssueWorkflowState(post,issue);
    writeIssueWorkflowState(post,state,current.version);
    git(post,'add','-A');
    git(post,'-c','user.name=Qwen Store Case',
      '-c','user.email=qwen@example.invalid','commit',
      '-m','Qwen repair dispatch v'+state.version);
    publish('agent-store',post,4);
  }
  const repairedOrigin=repairBound.outbox.find(x=>
    x.id===originalRepair.id).task.repair_checkpoint;
  const repairAdmission={...admission,task:'repair',
    action_id:originalRepair.id,input_sha:commitSha,
    run_id:repairWorkerId,resume_from:repairedOrigin};
  const repairRun={...run,id:repairWorkerId};
  const repairReader={getRun:async id=>{
    if(id===issuerId)return issuer;
    if(id===repairWorkerId)return repairRun;
    throw Error('unexpected repair source Run');
  }};
  assert.equal(qwenCheckpointNextVersion(repairAdmission,{version:1}),2);
  for(const change of [
    {resume_from:{...repairedOrigin,source_sha:commitSha}},
    {resume_from:{...repairedOrigin,checkpoint_version:2}},
    {resume_from:{...repairedOrigin,ciphertext_sha256:'invalid'}},
    {resume_from:{...repairedOrigin,source_run_id:0}},
    {resume_from:null},
  ])assert.throws(()=>qwenCheckpointNextVersion({
    ...repairAdmission,...change},{version:1}),
    /repair requires|Store head advanced/);
  const repairSnapshot=prepareQwenDevelopmentSource({
    admission:repairAdmission,registry,environment:selected,
    cliVersion:'2.1.34',workspace:repairSource,allowedFiles:['calc.js']});
  fs.writeFileSync(path.join(repairSource,'calc.js'),
    'module.exports = (a, b) => a + b + 0;\n');
  const repairPatch=collectQwenDevelopmentPatch(repairSnapshot,{events});
  const repairCandidate=sealQwenDevelopmentProposal({
    admission:repairAdmission,snapshot:repairSnapshot,patch:repairPatch,
    sessionId,configDir:nativeDir,publicKeyPem});
  assert.equal(repairCandidate.result.native_resumed,true);
  const repairArgs={...args,run:repairRun,
    claim:{inputs:repairSigned.inputs},reader:repairReader,
    result:repairCandidate.result,proof:repairCandidate.proof,
    ciphertext:repairCandidate.ciphertext};
  // A new native UUID is NOT a compatible repaired Session even with a
  // byte-correct source patch and a genuinely signed repair ticket.
  const foreignSession='650e8400-e29b-41d4-a716-446655440001';
  fs.writeFileSync(path.join(project,foreignSession+'.jsonl'),
    JSON.stringify({sessionId:foreignSession,type:'user',
      message:'DO_NOT_LOG_OTHER_SESSION'})+'\n');
  const foreign=sealQwenDevelopmentProposal({
    admission:repairAdmission,snapshot:repairSnapshot,patch:repairPatch,
    sessionId:foreignSession,configDir:nativeDir,publicKeyPem});
  await assert.rejects(()=>ingestQwenVerifiedCandidate({
    ...repairArgs,result:foreign.result,proof:foreign.proof,
    ciphertext:foreign.ciphertext}),
    /repair native Session UUID or source differs/);
  const repairAccepted=await ingestQwenVerifiedCandidate(repairArgs);
  assert.equal(repairAccepted.status,'committed');
  assert.equal(repairAccepted.checkpoint.version,2);
  assert.equal(repairAccepted.action_id,originalRepair.id);
  assert.equal((await ingestQwenVerifiedCandidate(repairArgs)).status,'replayed');
  assert.equal(readIssueWorkflowState(post,issue).state.phase,'repair');
  assert.equal(posts,5,'Qwen repair ciphertext ingest cannot issue GitHub POST');
  assert.ok(!JSON.stringify(repairAccepted).includes('PRIVATE_QWEN_MARKER'));
  assert.ok(!JSON.stringify(repairAccepted).includes('DO_NOT_LOG_OTHER_SESSION'));
  const badCandidates=[
    {result:{...candidate.result,patch_sha256:'f'.repeat(64)}},
    {proof:{...candidate.proof,patch_sha256:'f'.repeat(64)}},
    {ciphertext:{...candidate.ciphertext,ciphertext_sha256:'f'.repeat(64)}},
    {claim:{inputs:{...signed.inputs,agent_id:'dev-cursor-01'}}},
    {run:{...run,actor:{login:'attacker'}}},
    {run:{...run,run_attempt:2}},
  ];
  for(const bad of badCandidates){
    await assert.rejects(()=>ingestQwenVerifiedCandidate({...args,...bad}),
      /Qwen|claim|dispatch|trusted|candidate|Store/i);
  }
  console.log('Qwen signed Worker -> Store CAS -> Publisher write-ahead -> exact GitHub PR readback -> one Reviewer CAS and replay verified');
}finally{
  key.fill(0);aesKey.fill(0);
  fs.rmSync(home,{recursive:true,force:true});
  if(priorNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=priorNodeEnv;
}
