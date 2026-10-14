#!/usr/bin/env node
// Trusted main-owned Issue E2E projection receipts. The source PR has no
// access to this writer, Issue write credentials, or acceptance-results.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const ARTIFACT=/^sha256:[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));

export function verifyProjectionReceipt(receipt,record,plan,projected) {
  assert.equal(receipt?.schema_version,1);
  assert.equal(receipt.kind,'issue_e2e_projection_receipt');
  assert.ok(['applied','recovered'].includes(receipt.outcome));
  assert.equal(record?.schema_version,1);
  assert.equal(record.kind,'issue_e2e_run');
  assert.ok(positive(record.run_id)&&positive(record.run_attempt));
  assert.match(record.target_sha,SHA);
  assert.match(record.plan_digest,DIGEST);
  assert.match(record.artifact_digest,ARTIFACT);
  assert.equal(plan?.mode,'selected');
  assert.equal(plan.target_sha,record.target_sha);
  assert.equal(plan.plan_digest,record.plan_digest);
  assert.ok(positive(plan.pr_number));
  assert.equal(receipt.run_id,record.run_id);
  assert.equal(receipt.run_attempt,record.run_attempt);
  assert.equal(receipt.target_sha,record.target_sha);
  assert.equal(receipt.plan_digest,record.plan_digest);
  assert.equal(receipt.artifact_digest,record.artifact_digest);
  assert.ok(positive(receipt.ingest_run_id)&&positive(receipt.ingest_attempt));
  assert.ok(positive(receipt.issue));
  const issue=plan.issues.find(x=>x.issue===receipt.issue);
  assert.ok(issue && DIGEST.test(issue.declaration_digest),'missing authenticated Issue owner');
  assert.equal(receipt.declaration_digest,issue.declaration_digest);
  const current=parseIssueE2E(projected.body,{requireDeclaration:true});
  assert.deepEqual(current.errors,[]);
  assert.equal(current.digest,receipt.declaration_digest);
  assert.deepEqual(current.selectedIds,receipt.rows.map(row=>row.id));
  assert.equal(receipt.body_sha256,hash(projected.body));
  assert.match(receipt.body_sha256,DIGEST);
  assert.match(receipt.before_body_sha256,DIGEST);
  const selected=new Map(plan.selected.map(x=>[x.id,x]));
  const results=new Map(record.results.map(x=>[x.id,x]));
  assert.equal(results.size,record.results.length,'duplicate source ID');
  for(const row of receipt.rows){
    const selection=selected.get(row.id),result=results.get(row.id);
    assert.ok(selection?.owners?.some(x=>x.issue===receipt.issue),
      'receipt row lacks authenticated Issue ownership');
    assert.ok(result && result.result===row.result,'receipt result mismatches source');
    const actual=current.rows.get(row.id);
    assert.ok(actual && actual.result===row.result &&
      actual.evidence===row.evidence,'receipt differs from projected Issue report');
    const sourceUrl='https://github.com/BestNathan/nession/actions/runs/'+record.run_id;
    assert.ok(row.evidence.includes(sourceUrl) &&
      row.evidence.includes('run '+record.run_id+'/'+record.run_attempt) &&
      row.evidence.includes('SHA '+record.target_sha) &&
      row.evidence.includes('plan '+record.plan_digest),
      'receipt lacks exact source identity');
  }
  assert.ok(typeof receipt.readback_updated_at==='string' &&
    !Number.isNaN(Date.parse(receipt.readback_updated_at)));
  if(receipt.outcome==='applied'){
    assert.ok(typeof receipt.patch_updated_at==='string' &&
      !Number.isNaN(Date.parse(receipt.patch_updated_at)));
    assert.ok(Date.parse(receipt.readback_updated_at)>=Date.parse(receipt.patch_updated_at));
  } else assert.equal(receipt.patch_updated_at,null);
  return true;
}

export function createProjectionReceipt({record,plan,issue,projected,before,readback,
  patch=null,outcome,ingestRunId,ingestAttempt}) {
  assert.ok(['applied','recovered'].includes(outcome));
  assert.ok(positive(issue)&&positive(ingestRunId)&&positive(ingestAttempt));
  assert.equal(readback?.number,issue);
  assert.equal(readback.body,projected?.body,
    'Issue GET read-back differs from authenticated projected body');
  if(outcome==='applied'){
    assert.equal(patch?.number,issue,'PATCH returned wrong Issue');
    assert.equal(patch.body,projected.body,'PATCH response differs from projected body');
  }else assert.equal(patch,null,'recovery must not claim an executed PATCH');
  assert.ok(typeof before?.body==='string');
  const parsed=parseIssueE2E(projected.body,{requireDeclaration:true});
  assert.deepEqual(parsed.errors,[]);
  const receipt={
    schema_version:1,kind:'issue_e2e_projection_receipt',
    outcome,issue,run_id:record.run_id,run_attempt:record.run_attempt,
    target_sha:record.target_sha,plan_digest:record.plan_digest,
    artifact_digest:record.artifact_digest,
    ingest_run_id:ingestRunId,ingest_attempt:ingestAttempt,
    declaration_digest:parsed.digest,
    before_body_sha256:hash(before.body),
    body_sha256:hash(projected.body),
    patch_updated_at:outcome==='applied'?patch.updated_at:null,
    readback_updated_at:readback.updated_at,
    rows:parsed.selectedIds.map(id=>{
      const row=parsed.rows.get(id);
      return {id,result:row.result,evidence:row.evidence};
    }),
  };
  verifyProjectionReceipt(receipt,record,plan,projected);
  return receipt;
}

function selfTest(){
  const issue=1702,sha='a'.repeat(40),artifact='sha256:'+'b'.repeat(64);
  const body=[
    '## E2E Verification','### New','- none: no new test',
    '### Regression','- login','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
    '| login | Regression | Fail | run 123/1, SHA '+sha+
      ', contract PLACEHOLDER, plan '+'c'.repeat(64)+
      ', tests 0/1 (https://github.com/BestNathan/nession/actions/runs/123) |',
    '## Acceptance Report','untouched',
  ].join('\n');
  const contract=parseIssueE2E(body);
  const projected={body:body.replace('PLACEHOLDER',contract.digest)};
  const record={schema_version:1,kind:'issue_e2e_run',
    run_id:123,run_attempt:1,target_sha:sha,
    plan_digest:'c'.repeat(64),artifact_digest:artifact,
    results:[{id:'login',result:'Fail',discovered:1,passed:0,failed:1,
      skipped:0,flaky:0,assertions:1}]};
  const plan={mode:'selected',pr_number:10,target_sha:sha,
    plan_digest:record.plan_digest,issues:[{issue,declaration_digest:contract.digest}],
    selected:[{id:'login',owners:[{issue}]}]};
  const before={number:issue,body:projected.body.replace('Fail','Pending')};
  const after={number:issue,body:projected.body,updated_at:'2026-10-14T00:00:02Z'};
  const patched={...after,updated_at:'2026-10-14T00:00:01Z'};
  const args={record,plan,issue,projected,before,readback:after,
    ingestRunId:456,ingestAttempt:2};
  const applied=createProjectionReceipt({...args,patch:patched,outcome:'applied'});
  assert.equal(applied.outcome,'applied');
  const recovered=createProjectionReceipt({...args,outcome:'recovered'});
  assert.equal(recovered.outcome,'recovered');
  assert.throws(()=>createProjectionReceipt({...args,readback:{...after,body:'forged'},
    outcome:'recovered'}),/read-back/);
  assert.throws(()=>createProjectionReceipt({...args,patch:{...patched,number:9},
    outcome:'applied'}),/wrong Issue/);
  assert.throws(()=>verifyProjectionReceipt({...applied,body_sha256:'0'.repeat(64)},
    record,plan,projected));
  assert.throws(()=>verifyProjectionReceipt({...applied,rows:[{...applied.rows[0],
    result:'Pass'}]},record,plan,projected));
  assert.throws(()=>verifyProjectionReceipt(applied,{...record,run_id:124},plan,projected));
  assert.throws(()=>verifyProjectionReceipt(applied,record,{...plan,
    issues:[{issue:999,declaration_digest:contract.digest}]},projected));
  assert.throws(()=>createProjectionReceipt({...args,patch:patched,
    outcome:'recovered'}),/must not claim/);
  console.log('Issue E2E post-PATCH and recovered receipt integrity fixtures passed');
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [op,recordFile,planFile,issueArg,projectionFile,beforeFile,
    readbackFile,patchFile,outcome,ingestRunId,ingestAttempt,outFile]=process.argv.slice(2);
  if(op==='self-test')selfTest();
  else if(op==='create'){
    const receipt=createProjectionReceipt({record:read(recordFile),plan:read(planFile),
      issue:Number(issueArg),projected:read(projectionFile),before:read(beforeFile),
      readback:read(readbackFile),
      patch:patchFile==='-'?null:read(patchFile),outcome,
      ingestRunId:Number(ingestRunId),ingestAttempt:Number(ingestAttempt)});
    fs.writeFileSync(outFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  }else if(op==='verify'){
    assert.equal(verifyProjectionReceipt(read(issueArg),read(recordFile),
      read(planFile),read(projectionFile)),true);
    console.log('authenticated immutable Issue E2E projection receipt');
  }else throw Error('usage: issue-e2e-projection-receipt.mjs self-test | create RECORD PLAN ISSUE PROJECTED BEFORE READBACK PATCH|- MODE INGEST_RUN INGEST_ATTEMPT OUTPUT | verify RECORD PLAN RECEIPT PROJECTED');
}
