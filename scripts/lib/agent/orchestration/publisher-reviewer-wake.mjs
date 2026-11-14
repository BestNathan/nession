#!/usr/bin/env node
// #3550. Main-owned, read-only Publisher -> Reviewer wake attestation.
// This grants no authority: the existing Controller still signs and CAS-
// dispatches the exact Store Outbox Action. No model or Publisher creds here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readIssueWorkflowState} from './state-store.mjs';
import {qwenReviewerPublishedSource} from './qwen-reviewer-source.mjs';

const REPO='BestNathan/nession';
const PUB_WORKFLOW='.github/workflows/store-qwen-publisher.yml';
const HEX40=/^[a-f0-9]{40}$/, HEX64=/^[a-f0-9]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
function fail(s){throw Error('trusted Publisher Reviewer wake: '+s);}
function inputsForBot(env,event) {
  const inputs=event?.inputs??{};
  const keys=Object.keys(inputs).sort().join(',');
  if(env?.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_WORKFLOW!=='Agent / Controller Dispatch'||
     env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
     env.GITHUB_REF!=='refs/heads/main'||
     env.GITHUB_ACTOR!=='github-actions[bot]'||
     Number(env.GITHUB_RUN_ATTEMPT)!==1||
     !HEX40.test(env.GITHUB_SHA??'')||
     event?.ref!=='refs/heads/main'||
     event?.repository?.full_name!==REPO||
     !['action_id,issue_number,source_publisher_run_id',
       'action_id,issue_number,recovery_run_id,source_publisher_run_id'].includes(keys)||
     ![undefined,'0',0].includes(inputs.recovery_run_id))
    fail('untrusted bot/main reviewer wake identity or input contract');
  const issue=Number(inputs.issue_number), actionId=inputs.action_id;
  const publisherRunId=Number(inputs.source_publisher_run_id);
  if(!positive(issue)||!HEX64.test(actionId??'')||
     !positive(publisherRunId)||String(publisherRunId)!==String(inputs.source_publisher_run_id))
    fail('invalid immutable Publisher/Issue/Reviewer Action locator');
  return {issue,action_id:actionId,source_publisher_run_id:publisherRunId};
}

// Pure proof barrier; the authoritative Store source parameter is constructed
// ONLY from the current immutable State + signed Publisher Intent in live code.
export function assertPublisherReviewerWake({environment,event,sourceRun,jobs,storeSource}) {
  const locator=inputsForBot(environment,event);
  const source=sourceRun;
  if(source?.id!==locator.source_publisher_run_id||
     source.run_attempt!==1||
     source.path!==PUB_WORKFLOW||
     source.name!=='Store / Qwen Publisher'||
     !['workflow_dispatch','workflow_run'].includes(source.event)||
     source.actor?.login!=='github-actions[bot]'||
     source.head_branch!=='main'||
     !HEX40.test(source.head_sha??'')||
     source.repository?.full_name!==REPO||
     source.head_repository?.full_name!==REPO||
     !['in_progress','completed'].includes(source.status)||
     (source.status==='completed'&&source.conclusion!=='success'&&source.conclusion!=='failure')||
     !Array.isArray(jobs?.jobs)||!positive(jobs.total_count)||
     jobs.total_count!==jobs.jobs.length||jobs.jobs.length>100||
     storeSource?.issue!==locator.issue||
     storeSource?.reviewer_action_id!==locator.action_id||
     storeSource?.publisher_run_id!==source.id||
     !HEX40.test(storeSource?.review_sha??'')||
     !HEX40.test(storeSource?.base_sha??'')||
     !/^refs\/heads\/agent\/[1-9][0-9]*\/qwen-[a-f0-9]{16}$/.test(storeSource?.branch??''))
    fail('Publisher Run does not match authenticated immutable Reviewer source');
  const matched=jobs.jobs.filter(x=>x.name==='publish');
  const job=matched.length===1?matched[0]:null;
  if(job?.run_id!==source.id||job.status!=='completed'||
     job.conclusion!=='success'||
     (job.run_attempt!=null&&job.run_attempt!==1)||
     !Array.isArray(job.steps)||
     job.steps.filter(x=>x.name==='Authenticate original Qwen and publish/reconcile one real PR'&&
       x.status==='completed'&&x.conclusion==='success').length!==1)
    fail('Publisher publish Job/step has not succeeded');
  return Object.freeze({...locator,pr_head_sha:storeSource.review_sha,
    issuer_run_id:source.id});
}
async function api(token,url){
  if(typeof token!=='string'||token.length<8)fail('missing read-only GitHub token');
  const response=await fetch('https://api.github.com/repos/'+REPO+url,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!response.ok)fail('GitHub source read failed ('+response.status+')');
  return response.json();
}
export async function authenticatePublisherReviewerWake({environment,event,token}) {
  const locator=inputsForBot(environment,event);
  const sourceRun=await api(token,'/actions/runs/'+locator.source_publisher_run_id);
  const jobs=await api(token,'/actions/runs/'+locator.source_publisher_run_id+
    '/jobs?per_page=100');
  // The input source SHA is not an authority: require the authenticated
  // Publisher script revision to be on trusted current main history.
  if(!HEX40.test(sourceRun?.head_sha??''))fail('missing Publisher source SHA');
  try {
    execFileSync('git',['merge-base','--is-ancestor',
      sourceRun.head_sha,environment.GITHUB_SHA],{
      stdio:['ignore','pipe','ignore'],timeout:15000});
  }catch{fail('Publisher source commit is not an ancestor of Controller main');}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-reviewer-wake-'));
  const checkout=path.join(dir,'agent-store');
  try {
    execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--',
      'https://github.com/'+REPO+'.git',checkout],{
      stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});
    const {state}=readIssueWorkflowState(checkout,locator.issue);
    if(state?.phase!=='review'||!HEX40.test(state?.target_sha??''))
      fail('Review Issue lacks current immutable Store state');
    const storeSource=qwenReviewerPublishedSource({storeRoot:checkout,
      issue:locator.issue,actionId:locator.action_id,
      sha:state.target_sha});
    return assertPublisherReviewerWake({environment,event,sourceRun,jobs,storeSource});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='preflight')
    fail('usage: preflight');
  const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const proof=await authenticatePublisherReviewerWake({
    environment:process.env,event,
    token:process.env.ACTIONS_DISPATCH_TOKEN,
  });
  console.log(JSON.stringify(proof));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
