#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyWebhook,attestSource,DurableInbox} from './acceptance-event-relay-core.mjs';
import {pendingMergedAgentContext,ingestWorkflowEvent,selectEligibleMergedIssues} from './acceptance-event-relay.mjs';

const repo='BestNathan/nession',sha='a'.repeat(40),secret='x'.repeat(64);
const run={id:101,run_attempt:2,name:'E2E / Tests',
  path:'.github/workflows/e2e-tests.yml',event:'push',
  head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:repo},head_repository:{full_name:repo}};
const payload={action:'completed',repository:{full_name:repo},
  installation:{id:999},workflow_run:{...run}};
const raw=Buffer.from(JSON.stringify(payload));
const signature=x=>'sha256='+createHmac('sha256',secret).update(x).digest('hex');
assert.equal(verifyWebhook(raw,signature(raw),secret),true);
assert.equal(verifyWebhook(Buffer.concat([raw,Buffer.from(' ')]),signature(raw),secret),false);
assert.equal(verifyWebhook(raw,'sha1=untrusted',secret),false);
assert.equal(verifyWebhook(raw,'sha256='+('0'.repeat(64)),secret),false);
assert.equal(verifyWebhook(Buffer.alloc(1048577),signature(raw),secret),false);
assert.equal(verifyWebhook(raw,signature(raw),'short'),false);
const source=attestSource(payload,run);
assert.equal(source.target_sha,sha);
for(const bad of [
  {id:102},{run_attempt:3},{event:'pull_request'},
  {head_branch:'staging'},{head_sha:'b'.repeat(40)},
  {status:'in_progress'},{conclusion:'failure'},
  {name:'Wrong / Source'},{path:'.github/workflows/forged.yml'},
  {repository:{full_name:'evil/repo'}},
  {head_repository:{full_name:'evil/repo'}}
])assert.equal(attestSource(payload,{...run,...bad}),null);
assert.equal(attestSource({...payload,action:'queued'},run),null);
assert.equal(attestSource({...payload,workflow_run:{...run,conclusion:'failure'}},run),null);

const directory=mkdtempSync(join(tmpdir(),'nession-acceptance-relay-'));
try{
  const dbPath=join(directory,'inbox.sqlite');
  let db=new DurableInbox(dbPath);
  const item={issue:77,contract_digest:'d'.repeat(64)};
  const delivery='00000000-0000-4000-8000-000000000001';
  assert.deepEqual(db.record(delivery,raw,source,[item],1000),{duplicate:false,added:1});
  assert.deepEqual(db.record(delivery,raw,source,[item],1001),{duplicate:true,added:0});
  assert.throws(()=>db.record(delivery,Buffer.from('{}'),source,[item],1002),/conflicting/);
  assert.equal(db.record('00000000-0000-4000-8000-000000000002',
    raw,source,[item],1003).added,0,'same source converges across deliveries');
  assert.equal(db.count(),1);
  let claim=db.claim(1100,10000);
  assert.equal(claim.issue,77);
  assert.equal(claim.attempts,1);
  assert.equal(db.claim(1100,10000),null,'no concurrent double claim');
  db.close();
  db=new DurableInbox(dbPath);
  assert.equal(db.count(),1,'SQLite state survives process restart');
  assert.equal(db.claim(11100,10000),null,'expired dispatch is uncertain, not retried');
  assert.equal(db.get(claim.id).status,'uncertain');
  assert.equal(db.confirm(claim.id,11101),true);
  assert.equal(db.confirm(claim.id,11102),false,'acknowledgement idempotent');
  assert.equal(db.requeueKnownUnsent(claim.id,11103),false);
  const later={...source,source_attempt:3};
  assert.equal(db.record('00000000-0000-4000-8000-000000000003',
    raw,later,[item],12000).added,1);
  claim=db.claim(12001,10000);
  assert.equal(db.uncertain(claim.id,'HTTP 5xx ambiguous'),true);
  assert.equal(db.claim(13000,10000),null,'no blind redispatch after API 5xx');
  assert.equal(db.requeueKnownUnsent(claim.id,14000),true);
  assert.equal(db.claim(13999,10000),null,'recovery cannot ignore due time');
  assert.equal(db.claim(14000,10000).attempts,2);
  assert.equal(db.uncertain(claim.id,'timeout'),true);
  assert.equal(db.requeueKnownUnsent(claim.id,15000),true);
  assert.equal(db.claim(15000,10000).attempts,3);
  assert.equal(db.uncertain(claim.id,'timeout'),true);
  assert.equal(db.requeueKnownUnsent(claim.id,16000),false,'bounded retry');
  assert.throws(()=>db.record('bad-id',raw,source,[item]),/invalid delivery/);
  assert.throws(()=>db.record('00000000-0000-4000-8000-000000000004',
    raw,source,[{issue:77,contract_digest:'bad'}],13000),/identity/);
  db.close();

  const fence=String.fromCharCode(96).repeat(3);
  const body=['## Success Criteria','- [ ] SC-01 merged Agent proof',
    '## Acceptance Plan',fence+'yaml','acceptance:',
    '  SC-01:','    when: merged','    branch: main','    method: agent',fence,
    '## Acceptance Report','| Criterion | Result | Evidence |',
    '|---|---|---|','| SC-01 | Pending | awaiting exact evidence |'].join('\n');
  const issue={number:77,title:'Requirement: scoped test',body,
    labels:[{name:'requirement'}],state:'open'};
  assert.match(pendingMergedAgentContext(issue,source).contract_digest,/^[a-f0-9]{64}$/);
  assert.equal(pendingMergedAgentContext({...issue,state:'closed'},source),null);
  assert.equal(pendingMergedAgentContext({...issue,body:body.replace('Pending','Pass')},source),null);
  assert.equal(pendingMergedAgentContext({...issue,
    body:body.replace('when: merged\n    branch: main','when: pr')},source),null);

  const pr={number:123,body:'Implements #77',title:'feat: proof',
    merged_at:'2026-10-29T02:00:00Z',merge_commit_sha:sha,
    base:{ref:'main'},head:{repo:{full_name:repo}}};
  const fetched=[];
  const get=async(path)=>{
    fetched.push(path);
    if(path.endsWith('/actions/runs/101'))return run;
    if(path.endsWith('/commits/'+sha+'/pulls?per_page=30'))return [pr];
    if(path.endsWith('/issues/77'))return issue;
    throw Error('unexpected GitHub API read '+path);
  };
  assert.equal((await selectEligibleMergedIssues(source,get)).length,1);
  db=new DurableInbox(dbPath);
  const headers={'x-github-event':'workflow_run',
    'x-github-delivery':'00000000-0000-4000-8000-000000000011',
    'x-hub-signature-256':signature(raw)};
  const result=await ingestWorkflowEvent({headers,raw,secret,
    installationId:999,get,inbox:db,now:17000});
  assert.equal(result.added,1);
  assert.equal(result.mode,'shadow');
  assert.equal((await ingestWorkflowEvent({headers,raw,secret,
    installationId:999,get,inbox:db,now:18000})).duplicate,true);
  await assert.rejects(()=>ingestWorkflowEvent({
    headers:{...headers,'x-hub-signature-256':'sha256='+('0'.repeat(64))},
    raw,secret,installationId:999,get,inbox:db}),/HMAC/);
  await assert.rejects(()=>ingestWorkflowEvent({headers,raw,secret,
    installationId:998,get,inbox:db}),/installation/);
  const forkRaw=Buffer.from(JSON.stringify({...payload,
    workflow_run:{...run,head_repository:{full_name:'evil/repo'}}}));
  const fork=await ingestWorkflowEvent({
    headers:{...headers,'x-hub-signature-256':signature(forkRaw),
      'x-github-delivery':'00000000-0000-4000-8000-000000000012'},
    raw:forkRaw,secret,installationId:999,get,inbox:db});
  assert.equal(fork.ignored,'inapplicable-source');

  const full={...run,id:102,name:'E2E / Full Regression',
    path:'.github/workflows/e2e-full-regression.yml'};
  const fullRaw=Buffer.from(JSON.stringify({...payload,workflow_run:full}));
  const fullResult=await ingestWorkflowEvent({
    headers:{...headers,'x-hub-signature-256':signature(fullRaw),
      'x-github-delivery':'00000000-0000-4000-8000-000000000013'},
    raw:fullRaw,secret,installationId:999,inbox:db,
    get:async(path)=>{
      if(path.endsWith('/actions/runs/102'))return full;
      if(path.includes('/attempts/2/jobs?'))
        return {jobs:[{name:'full',run_id:102,run_attempt:2,
          status:'completed',conclusion:'skipped'}]};
      throw Error('skipped Full source should not query PR/Issue');
    }});
  assert.equal(fullResult.ignored,'full-job-not-executed');
  db.close();
}finally{rmSync(directory,{recursive:true,force:true})}
console.log('Acceptance relay: HMAC, source forgery, canonical SC eligibility, SQLite CAS, dedupe, persistence, timeout uncertainty, bounded recovery, skipped Full and fork fixtures passed');
