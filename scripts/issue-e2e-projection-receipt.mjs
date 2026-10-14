#!/usr/bin/env node
// Canonical trusted E2E projection receipt. Source artifacts and the intended
// Issue mutation have already passed the main-owned E2E source attestor.
// This module proves a persisted intent and a *separate post-PATCH read-back*.
// A recovered observation is deliberately not called a successful PATCH.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseIssueE2E} from './issue-e2e-contract.mjs';
import {decideIssueE2EProjection} from './issue-e2e-reconcile.mjs';
import {projectIssueE2E} from './issue-e2e-project.mjs';

const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha256=data=>createHash('sha256').update(data).digest('hex');
const fail=why=>{throw Error('Issue E2E projection receipt: '+why)};
function source(record){
  if(record?.schema_version!==1||record.kind!=='issue_e2e_run'||
     !positive(record.run_id)||!positive(record.run_attempt)||
     !SHA.test(record.target_sha)||!DIGEST.test(record.plan_digest)||
     !/^sha256:[a-f0-9]{64}$/.test(record.artifact_digest)||
     !Array.isArray(record.results)||!record.results.length)
    fail('untrusted source Run Record');
  return {run_id:record.run_id,run_attempt:record.run_attempt,
    target_sha:record.target_sha,plan_digest:record.plan_digest,
    artifact_digest:record.artifact_digest};
}
function reportRows(record,projected){
  const parsed=parseIssueE2E(projected.body,{requireDeclaration:true});
  if(parsed.errors.length||!parsed.selectedIds.length)fail('invalid projected Issue E2E report');
  const selected=new Map(record.results.map(r=>[r.id,r]));
  if(selected.size!==record.results.length)fail('duplicate source results');
  const rows=[];
  for(const id of parsed.selectedIds){
    const result=selected.get(id),row=parsed.rows.get(id);
    if(!result||!row||result.result!==row.result||
       !['Pass','Fail','Pending','Error'].includes(row.result)||
       !Number.isSafeInteger(result.discovered)||result.discovered<0||
       !Number.isSafeInteger(result.passed)||result.passed<0)
      fail('projected ID/result differs from authenticated source');
    const expected='run '+record.run_id+'/'+record.run_attempt+
      ', SHA '+record.target_sha+', contract '+parsed.digest+
      ', plan '+record.plan_digest+', tests '+
      result.passed+'/'+result.discovered+
      ' (https://github.com/BestNathan/nession/actions/runs/'+record.run_id+')';
    if(row.evidence!==expected)fail('projected evidence is not source-aligned');
    rows.push({id,type:row.type,result:row.result,evidence:row.evidence});
  }
  if(rows.length!==selected.size)fail('incomplete projected E2E rows');
  return {declaration_digest:parsed.digest,rows};
}
export function makeProjectionIntent(record,issue,projected){
  const src=source(record);
  if(!positive(issue?.number)||!['open','OPEN'].includes(issue.state)||
     typeof issue.body!=='string'||typeof projected?.body!=='string')
    fail('missing trusted original Issue/projection');
  if(issue.body.length>512*1024||projected.body.length>512*1024)
    fail('oversized Issue body');
  const decision=decideIssueE2EProjection(issue.body,projected.body,{
    runId:src.run_id,attempt:src.run_attempt,targetSha:src.target_sha});
  if(decision!=='apply')fail('intent may only authorize a new, current projection');
  const report=reportRows(record,projected);
  return {schema_version:1,kind:'issue_e2e_projection_intent',
    issue_number:issue.number,...src,
    source_record_sha256:sha256(JSON.stringify(record)),
    previous_body_sha256:sha256(issue.body),
    expected_body_sha256:sha256(projected.body),
    declaration_digest:report.declaration_digest,
    rows:report.rows};
}
export function confirmProjection(intent,record,projected,readback,patched=null){
  const src=source(record);
  if(intent?.schema_version!==1||intent.kind!=='issue_e2e_projection_intent'||
     !positive(intent.issue_number)||!DIGEST.test(intent.previous_body_sha256??'')||
     !DIGEST.test(intent.expected_body_sha256??'')||
     !DIGEST.test(intent.source_record_sha256??'')||
     intent.source_record_sha256!==sha256(JSON.stringify(record))||
     Object.entries(src).some(([key,value])=>intent[key]!==value))
    fail('missing or mismatched previously persisted intent');
  const report=reportRows(record,projected);
  if(intent.declaration_digest!==report.declaration_digest||
     JSON.stringify(intent.rows)!==JSON.stringify(report.rows)||
     sha256(projected.body)!==intent.expected_body_sha256)
    fail('intent/projected Issue report mismatch');
  if(readback?.number!==intent.issue_number||
     !['open','OPEN'].includes(readback.state)||
     typeof readback.body!=='string'||
     sha256(readback.body)!==intent.expected_body_sha256)
    fail('GitHub Issue read-back does not match projected body');
  if(patched!==null && (patched?.number!==intent.issue_number||
     patched.body!==readback.body||
     !['open','OPEN'].includes(patched.state)))
    fail('PATCH response and independent Issue GET disagree');
  const mode=patched===null?'recovered-exact-readback':'patched-and-read-back';
  return {schema_version:1,kind:'issue_e2e_projection_receipt',
    issue_number:intent.issue_number,run_id:src.run_id,
    run_attempt:src.run_attempt,target_sha:src.target_sha,
    plan_digest:src.plan_digest,declaration_digest:report.declaration_digest,
    intent_sha256:sha256(JSON.stringify(intent)),
    projected_body_sha256:intent.expected_body_sha256,
    mode,rows:report.rows.map(({id,type,result})=>({id,type,result}))};
}
// Read-only acceptance verifier for the immutable orphan Store pair. It does
// not read an Issue's mutable current E2E Report or trust a PR comment.
export function verifyStoredProjectionReceipt(record,intent,receipt,issueNumber){
  const src=source(record);
  if(!positive(issueNumber)||intent?.schema_version!==1||
     intent.kind!=='issue_e2e_projection_intent'||
     intent.issue_number!==issueNumber||
     !DIGEST.test(intent.source_record_sha256??'')||
     intent.source_record_sha256!==sha256(JSON.stringify(record))||
     !DIGEST.test(intent.previous_body_sha256??'')||
     !DIGEST.test(intent.expected_body_sha256??'')||
     !DIGEST.test(intent.declaration_digest??'')||
     Object.entries(src).some(([key,value])=>intent[key]!==value)||
     !Array.isArray(intent.rows)||!intent.rows.length)
    fail('untrusted source-aligned historical projection intent');
  const results=new Map(record.results.map(row=>[row.id,row]));
  const seen=new Set();
  for(const row of intent.rows){
    const sourceResult=results.get(row?.id);
    if(typeof row?.id!=='string'||seen.has(row.id)||!sourceResult||
       row.result!==sourceResult.result||
       !['New','Regression'].includes(row.type)||
       typeof row.evidence!=='string'||
       row.evidence!==('run '+src.run_id+'/'+src.run_attempt+
       ', SHA '+src.target_sha+', contract '+intent.declaration_digest+
       ', plan '+src.plan_digest+', tests '+
       sourceResult.passed+'/'+sourceResult.discovered+
       ' (https://github.com/BestNathan/nession/actions/runs/'+src.run_id+')'))
      fail('untrusted historical projection ID/result/evidence');
    seen.add(row.id);
  }
  if(results.size!==seen.size||!receipt||
     receipt.schema_version!==1||
     receipt.kind!=='issue_e2e_projection_receipt'||
     receipt.issue_number!==issueNumber||
     receipt.run_id!==src.run_id||receipt.run_attempt!==src.run_attempt||
     receipt.target_sha!==src.target_sha||
     receipt.plan_digest!==src.plan_digest||
     receipt.declaration_digest!==intent.declaration_digest||
     receipt.intent_sha256!==sha256(JSON.stringify(intent))||
     receipt.projected_body_sha256!==intent.expected_body_sha256||
     !['patched-and-read-back','recovered-exact-readback'].includes(receipt.mode)||
     JSON.stringify(receipt.rows)!==JSON.stringify(
       intent.rows.map(({id,type,result})=>({id,type,result}))))
    fail('source Run Record does not authenticate historical projection receipt');
  return {issue:issueNumber,source_run_id:src.run_id,
    source_run_attempt:src.run_attempt,head_sha:src.target_sha,
    plan_digest:src.plan_digest,receipt_mode:receipt.mode,
    projection_verified:receipt.mode==='patched-and-read-back',
    results:receipt.rows,provenance:'trusted acceptance-results projection intent + Issue API read-back receipt'};
}

function fixture(){
  const pending=['## E2E Verification','### New','- none: no new spec',
    '### Regression','- login','- session-lifecycle','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
    '| login | Regression | Pending | - |',
    '| session-lifecycle | Regression | Pending | - |',
    '## Acceptance Report','keep this section'].join('\n');
  const sha='a'.repeat(40),plan='b'.repeat(64);
  const issue={number:1702,state:'open',body:pending};
  const digest=parseIssueE2E(pending).digest;
  const attestation={target_sha:sha,run_id:77,run_attempt:2,workflow_verified:true};
  const selected=[{id:'login'},{id:'session-lifecycle'}];
  const planObj={target_sha:sha,plan_digest:plan,issues:[{issue:1702,declaration_digest:digest}],selected};
  const results=[
    {id:'login',result:'Fail',discovered:1,passed:0,failed:1,skipped:0,flaky:0,assertions:2},
    {id:'session-lifecycle',result:'Pass',discovered:1,passed:1,failed:0,skipped:0,flaky:0,assertions:2},
  ];
  const execution={target_sha:sha,plan_digest:plan,run_id:77,run_attempt:2,results};
  const projection=projectIssueE2E(issue,planObj,execution,attestation);
  const source={schema_version:1,kind:'issue_e2e_run',run_id:77,run_attempt:2,
    target_sha:sha,plan_digest:plan,artifact_digest:'sha256:'+'c'.repeat(64),results};
  return {issue,projected:{body:projection.body},source};
}
function selfTest(){
  const {issue,projected,source:record}=fixture();
  const intent=makeProjectionIntent(record,issue,projected);
  assert.equal(intent.rows.length,2);
  const after={...issue,body:projected.body};
  const receipt=confirmProjection(intent,record,projected,after,after);
  assert.equal(receipt.mode,'patched-and-read-back');
  assert.deepEqual(receipt.rows.map(x=>x.result),['Fail','Pass']);
  const verified=verifyStoredProjectionReceipt(record,intent,receipt,1702);
  assert.equal(verified.projection_verified,true);
  assert.deepEqual(verified.results.map(x=>x.result),['Fail','Pass']);
  const recoveredReceipt=confirmProjection(intent,record,projected,after);
  assert.equal(verifyStoredProjectionReceipt(record,intent,recoveredReceipt,1702).projection_verified,false);
  assert.throws(()=>verifyStoredProjectionReceipt(record,intent,receipt,1703),/historical projection intent/);
  assert.throws(()=>verifyStoredProjectionReceipt(record,intent,
    {...receipt,projected_body_sha256:'d'.repeat(64)},1702),/historical projection receipt/);
  assert.throws(()=>verifyStoredProjectionReceipt(record,intent,
    {...receipt,rows:[{...receipt.rows[0],result:'Pass'},receipt.rows[1]]},1702),
    /historical projection receipt/);
  assert.throws(()=>verifyStoredProjectionReceipt(record,
    {...intent,rows:[{...intent.rows[0],result:'Pass'},intent.rows[1]]},receipt,1702),
    /historical projection ID/);
  assert.equal(confirmProjection(intent,record,projected,after).mode,
    'recovered-exact-readback');
  assert.throws(()=>makeProjectionIntent(record,{...issue,body:projected.body},projected),
    /new, current projection/);
  assert.throws(()=>makeProjectionIntent({...record,run_attempt:3},issue,projected),
    /current run|source-aligned|evidence/);
  assert.throws(()=>confirmProjection(intent,record,projected,
    {...after,body:after.body+'tampered'},after),/read-back/);
  assert.throws(()=>confirmProjection(intent,record,projected,after,
    {...after,body:'stale'}),/PATCH response/);
  assert.throws(()=>confirmProjection(intent,{...record,run_attempt:1},projected,after,after),
    /mismatched previously persisted intent/);
  assert.throws(()=>confirmProjection({...intent,previous_body_sha256:'fake'},
    record,projected,after,after),/intent/);
  assert.throws(()=>confirmProjection(intent,record,
    {...projected,body:projected.body.replace('Fail','Pass')},after,after),/intent\/projected|source-aligned|projected ID\/result/);
  console.log('Issue E2E receipt: trusted intent, PATCH+GET, replay observation and adverse source/Issue fixtures passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [cmd,a,b,c,d,e]=process.argv.slice(2);
  if(cmd==='self-test')selfTest();
  else if(cmd==='intent'){
    if(!d)fail('intent SOURCE_RECORD ISSUE_JSON PROJECTED_JSON OUT_JSON');
    const intent=makeProjectionIntent(JSON.parse(fs.readFileSync(a,'utf8')),
      JSON.parse(fs.readFileSync(b,'utf8')),JSON.parse(fs.readFileSync(c,'utf8')));
    fs.writeFileSync(d,JSON.stringify(intent,null,2)+'\n',{flag:'wx'});
  }else if(cmd==='confirm'){
    const [intentFile,recordFile,projectedFile,readbackFile,patchedFile,output]=process.argv.slice(3);
    if(!output)fail('confirm INTENT SOURCE_RECORD PROJECTED READBACK PATCHED_JSON_OR_DASH OUT');
    const parse=f=>JSON.parse(fs.readFileSync(f,'utf8'));
    const receipt=confirmProjection(parse(intentFile),parse(recordFile),
      parse(projectedFile),parse(readbackFile),patchedFile==='-'?null:parse(patchedFile));
    fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  }else fail('self-test | intent ... | confirm ...');
}
