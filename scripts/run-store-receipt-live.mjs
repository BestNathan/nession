#!/usr/bin/env node
// #1690: separately running, read-only authenticated GitHub receipt consumer.
// GitHub API source/run/artifact provenance + exact Git tree byte binding.
// GitHub-controlled Actions artifacts are NOT an independent signed/WORM anchor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRunStoreReceipt} from './run-store-receipt-verify.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/, NUMBER=/^[1-9][0-9]*$/;
const WRITERS=Object.freeze({
  '.github/workflows/acceptance-case-ingest.yml':{name:'Acceptance / Case Ingest',artifact:'case',store:'acceptance-results'},
  '.github/workflows/e2e-scenario-ingest.yml':{name:'E2E / Scenario Ingest',artifact:'scenario',store:'acceptance-results'},
  '.github/workflows/e2e-test-ingest.yml':{name:'E2E / Test Ingest',artifact:'test',store:'acceptance-results',second:'pr'},
  '.github/workflows/task-result-ingest.yml':{name:'Task / Result Ingest',artifact:'task',store:'task-results'},
  '.github/workflows/metrics-agent-telemetry.yml':{name:'Metrics / Agent Telemetry Ingest',artifact:'agent',store:'metrics'},
  '.github/workflows/metrics-repository.yml':{name:'Metrics / Repository Health',artifact:'repository',store:'metrics'},
});
const fail=reason=>{throw new Error('run-store-receipt-live: '+reason);};
const obj=(x,label)=>{if(!x||typeof x!=='object'||Array.isArray(x))fail('invalid '+label);return x;};
const numeric=(x,label)=>{if(!NUMBER.test(String(x??'')))fail('invalid '+label);return String(x);};
const commit=(x,label)=>{if(!SHA.test(String(x??'')))fail('invalid '+label);return x;};
function sourcePath(run){
  const pathName=run.path;
  if(typeof pathName!=='string')fail('ingester workflow path unavailable');
  // GitHub REST may report an optional @refs/heads/main path suffix.
  return pathName.replace(/@refs\/heads\/main$/,'');
}
function writerFor(run){
  obj(run,'ingester');
  if(run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
    run.head_branch!=='main'||run.status!=='completed'||run.conclusion!=='success')
    fail('ingester not successful trusted-main repository run');
  commit(run.head_sha,'ingester head SHA');
  numeric(run.id,'ingester run ID');
  numeric(run.run_attempt,'ingester attempt');
  const key=sourcePath(run),definition=WRITERS[key];
  if(!definition||definition.name!==run.name)
    fail('unclassified ingester workflow identity/path');
  if(!['workflow_run','schedule'].includes(run.event))
    fail('unsupported privileged ingester event');
  return {workflow:key,...definition};
}
export function planReceiptEvidence(ingester,artifacts,requestedId,requestedAttempt){
  const config=writerFor(ingester);
  if(numeric(requestedId,'bound run')!==String(ingester.id)||
     numeric(requestedAttempt,'bound attempt')!==String(ingester.run_attempt))
    fail('event/input run identity disagrees with GitHub live API');
  if(!Array.isArray(artifacts?.artifacts))fail('unavailable Actions artifacts listing');
  const names=new Set(),selected=[];
  const prefix='run-store-receipt-'+ingester.id+'-'+ingester.run_attempt+'-';
  const allowed=new Set([config.artifact,config.second].filter(Boolean));
  for(const item of artifacts.artifacts){
    if(typeof item.name!=='string'||!item.name.startsWith(prefix))continue;
    const suffix=item.name.slice(prefix.length);
    if(!allowed.has(suffix)||names.has(suffix)||item.expired!==false||
      !NUMBER.test(String(item.id))||item.workflow_run?.id!==ingester.id||
      item.workflow_run?.head_sha!==ingester.head_sha)
      fail('forged/duplicate/expired or unexpected source receipt artifact');
    names.add(suffix);
    selected.push({id:item.id,name:item.name,suffix,store:config.store,sha256_zip:item.digest??null});
  }
  return {schema_version:1,kind:'run_store_receipt_live_plan',
    repository:REPO,run_id:String(ingester.id),
    attempt:String(ingester.run_attempt),head_sha:ingester.head_sha,
    workflow:config.workflow,store:config.store,
    status:selected.length?'receipts-discovered':'no-publication-receipt-pending',
    artifacts:selected};
}
function git(root,args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}catch{fail('unverifiable trusted-main SHA ancestry');}
}
export function verifyAuthenticatedReceipt(ingester,plan,artifactName,receipt,upstream,storeCheckout,trustedCheckout){
  const config=writerFor(ingester);
  obj(plan,'receipt plan');
  const expected=planReceiptEvidence(ingester,{
    artifacts:plan.artifacts.map(a=>({name:a.name,id:a.id,expired:false,
      workflow_run:{id:ingester.id,head_sha:ingester.head_sha},digest:a.sha256_zip})),
  },plan.run_id,plan.attempt);
  if(plan.workflow!==expected.workflow||plan.store!==expected.store||
     plan.head_sha!==expected.head_sha||plan.status!==expected.status||
     plan.artifacts.length!==expected.artifacts.length)
    fail('receipt plan changed after authenticated GitHub API selection');
  const art=plan.artifacts.find(a=>a.name===artifactName);
  if(!art||art.store!==config.store||!NUMBER.test(String(art.id)))
    fail('unexpected or missing authenticated artifact');
  obj(receipt,'receipt');
  if(receipt.ingester?.repository!==REPO||
     receipt.ingester.run_id!==String(ingester.id)||
     receipt.ingester.attempt!==String(ingester.run_attempt)||
     receipt.ingester.workflow_ref!==REPO+'/'+config.workflow+'@refs/heads/main')
    fail('receipt ingester identity does not match authenticated Workflow');
  const toolSha=commit(receipt.ingester.tool_sha,'trusted tool SHA');
  // The ingester checks out trusted main at runtime; that SHA can be later than
  // the triggering event SHA but must be in independently fetched main history.
  if(git(trustedCheckout,['merge-base','--is-ancestor',toolSha,'HEAD'])!=='' )
    fail('trusted tooling ancestry mismatch');
  obj(upstream,'source run');
  const claimed=receipt.source;
  if(!claimed||numeric(upstream.id,'source run')!==claimed.run_id||
     numeric(upstream.run_attempt,'source attempt')!==claimed.attempt||
     commit(upstream.head_sha,'source SHA')!==claimed.target_sha||
     upstream.event!==claimed.event||
     String(upstream.workflow_id)!==(claimed.workflow_id||String(upstream.workflow_id))||
     (claimed.workflow_path&&sourcePath(upstream)!==claimed.workflow_path)||
     upstream.head_repository?.full_name!==claimed.repository||
     upstream.repository?.full_name!==REPO)
    fail('source run GitHub REST identity/digest/pointer disagreement');
  // For non-workflow_run cron publishers, provenance source points to self.
  if(ingester.event==='schedule'&&upstream.id!==ingester.id)
    fail('scheduled ingester must cite its own run');
  const verified=verifyRunStoreReceipt(receipt,storeCheckout,{expectedStore:config.store});
  return {schema_version:1,kind:'run_store_receipt_authenticated_readback',
    trust_level:'github_actions_authenticated_not_independent_anchor',
    ingester_run_id:String(ingester.id),ingester_attempt:String(ingester.run_attempt),
    upstream_run_id:claimed.run_id,artifact_id:art.id,
    ...verified,
    source_workflow:config.workflow};
}
const [mode,...args]=process.argv.slice(2);
try{
  if(mode==='plan'){
    const [runPath,artifactsPath,runId,attempt,out]=args;
    if(!out||!path.isAbsolute(out))fail('usage: plan RUN ARTIFACTS ID ATTEMPT ABS_OUTPUT');
    const x=planReceiptEvidence(JSON.parse(fs.readFileSync(runPath)),
      JSON.parse(fs.readFileSync(artifactsPath)),runId,attempt);
    fs.writeFileSync(out,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({status:x.status,receipts:x.artifacts.length}));
  }else if(mode==='verify'){
    const [ingPath,planPath,name,receiptPath,upstreamPath,storeDir,trustedDir]=args;
    if(![ingPath,planPath,receiptPath,upstreamPath,storeDir,trustedDir].every(x=>x&&path.isAbsolute(x)))
      fail('usage: verify ABS_INGESTER ABS_PLAN ARTIFACT_NAME ABS_RECEIPT ABS_SOURCE ABS_STORE ABS_TRUSTED');
    console.log(JSON.stringify(verifyAuthenticatedReceipt(
      JSON.parse(fs.readFileSync(ingPath)),JSON.parse(fs.readFileSync(planPath)),name,
      JSON.parse(fs.readFileSync(receiptPath)),JSON.parse(fs.readFileSync(upstreamPath)),
      storeDir,trustedDir)));
  }else if(process.argv[1]===fileURLToPath(import.meta.url))
    fail('usage: plan | verify');
}catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
