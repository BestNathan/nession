#!/usr/bin/env node
// Attested Issue Audit approval for the narrow, deterministically tooling-only
// case. Risk-bearing or unknown integration batches always need owner review.
// Never execute files from the integration head or let a model issue a Gate Pass.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {planBatch,verifyBatchIssue,AUDIT_APPROVAL} from './staging-convergence-batch.mjs';

const SHA='[a-f0-9]{40}';
const MARKER=new RegExp('<!-- nession-convergence-batch:v1 branch=([^ ]+) main=('+SHA+') lane=('+SHA+') head=('+SHA+') -->');
const REPO='BestNathan/nession';
const gh=(...args)=>JSON.parse(execFileSync('gh',['api',...args],{
  encoding:'utf8',env:process.env,maxBuffer:8_000_000}));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
export function sourceFromIssue(issue){
  const m=MARKER.exec(issue?.body??'');
  if(!m)return null;
  if(issue.state!=='open'||issue.user?.login!=='github-actions[bot]'||
    issue.repository_url!=='https://api.github.com/repos/'+REPO)
    throw Error('untrusted generated batch Issue identity');
  const [,branch,main_sha,lane_sha,integration_head]=m;
  return {branch,main_sha,lane_sha,integration_head};
}
// A green Issue Audit job is not necessarily a completed audit: known safe
// proposal rejections are recorded as needs-review. Only a trusted successful
// local result may unlock the separately source-validated approval receipt.
export function auditOutcomeAllowsAttestation(record,number){
  return record?.schema_version===1 &&
    record.issue?.number===number &&
    record.trigger==='workflow_dispatch' &&
    (record.result==='repaired'||record.result==='contract-pass') &&
    Array.isArray(record.errors) && record.errors.length===0 &&
    !record.review;
}
export function attest(number,runId){
  if(!Number.isInteger(number)||number<=0||!Number.isInteger(runId)||runId<=0)
    throw Error('invalid Issue Audit identity');
  const issue=gh('repos/'+REPO+'/issues/'+number);
  const ref=sourceFromIssue(issue);
  if(!ref)return {status:'NOT_A_CONVERGENCE_BATCH'};
  if(!process.env.RUNNER_TEMP)throw Error('Issue Audit attestation requires runner-local audit result');
  let outcome;
  try {
    outcome=JSON.parse(readFileSync(join(process.env.RUNNER_TEMP,
      'issue-audit','issue-'+number+'-usage.json'),'utf8'));
  } catch {
    throw Error('Missing or malformed runner-local Issue Audit result; no approval may be issued');
  }
  if(!auditOutcomeAllowsAttestation(outcome,number))
    return {status:'AUDIT_NOT_COMPLETE',issue:number,audit_result:String(outcome?.result??'unknown')};
  if(git('rev-parse','--is-shallow-repository')!=='false')
    throw Error('Issue Audit needs complete, source-bound git history');
  git('fetch','--no-tags','origin',ref.main_sha,ref.lane_sha,ref.integration_head);
  const plan=planBatch(ref),verified=verifyBatchIssue(issue,plan);
  if(plan.impact.category!=='tooling-only'||plan.removed.length||
    plan.newIds.length||plan.regressionIds.length||verified.selected_ids.length)
    return {status:'OWNER_APPROVAL_REQUIRED',category:plan.impact.category,
      issue:number,approval_command:verified.approval_command};
  const receipt=AUDIT_APPROVAL+' '+plan.integration_head+' '+
    verified.declaration_digest+' run='+runId;
  const comments=gh('repos/'+REPO+'/issues/'+number+'/comments?per_page=100');
  if(!Array.isArray(comments)||comments.length>=100)
    throw Error('Issue audit approval inventory unbounded');
  if(comments.some(c=>c.body?.trim()===receipt))
    return {status:'EXISTING_APPROVAL',issue:number};
  gh('--method','POST','repos/'+REPO+'/issues/'+number+'/comments',
    '-f','body='+receipt);
  return {status:'AUDITED_TOOLING_ONLY',issue:number};
}
function selfTest(){
  const issue={state:'open',user:{login:'github-actions[bot]'},
    repository_url:'https://api.github.com/repos/'+REPO,
    body:'<!-- nession-convergence-batch:v1 branch=staging main='+
      'a'.repeat(40)+' lane='+'b'.repeat(40)+' head='+'c'.repeat(40)+' -->'};
  assert.equal(sourceFromIssue(issue).branch,'staging');
  assert.equal(sourceFromIssue({...issue,body:'manual'}),null);
  assert.throws(()=>sourceFromIssue({...issue,user:{login:'external'}}),/untrusted/);
  assert.throws(()=>sourceFromIssue({...issue,state:'closed'}),/untrusted/);
  const clean={schema_version:1,issue:{number:3139},
    trigger:'workflow_dispatch',result:'repaired',errors:[]};
  assert.equal(auditOutcomeAllowsAttestation(clean,3139),true);
  assert.equal(auditOutcomeAllowsAttestation({...clean,result:'contract-pass'},3139),true);
  for(const result of ['needs-review','agent-error','contract-fail','agent-not-authorized','skipped-closed']){
    assert.equal(auditOutcomeAllowsAttestation({...clean,result},3139),false,result);
  }
  assert.equal(auditOutcomeAllowsAttestation({...clean,review:{code:'ISSUE_AUDIT_E2E_PROTECTED'}},3139),false);
  assert.equal(auditOutcomeAllowsAttestation({...clean,errors:['still invalid']},3139),false);
  assert.equal(auditOutcomeAllowsAttestation({...clean,trigger:'issues'},3139),false);
  assert.equal(auditOutcomeAllowsAttestation(clean,3140),false);
  console.log('Source-bound Staging Issue Audit attestor: identity fixtures PASS');
}
// Safe to import the pure approval predicate in the existing Issue Audit
// Gate; CLI commands execute only when this file is the entrypoint.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='attest')
    console.log(JSON.stringify(attest(Number(process.argv[3]),Number(process.argv[4]))));
}
