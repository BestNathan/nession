#!/usr/bin/env node
// #2031: trusted main-owned recipient for an explicitly selected event task.
// Workflow inputs are claims, never authoritative proof or SC verdicts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {SOURCE_WORKFLOWS,sha256} from './acceptance-event-relay-core.mjs';
import {selectEligibleMergedIssues,githubGet} from './acceptance-event-relay.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const fail=m=>{throw Error('acceptance-event-consumer: '+m)};

function strictPositive(raw,label){
  if(!/^[1-9][0-9]*$/.test(String(raw??'')))fail('invalid '+label);
  const n=Number(raw);
  if(!positive(n))fail('invalid '+label);
  return n;
}
export function attestDispatchSource(live,{runId,attempt,sha}){
  if(!live||live.id!==runId||live.run_attempt!==attempt||
    live.repository?.full_name!==REPO||live.head_repository?.full_name!==REPO||
    !SOURCE_WORKFLOWS.has(live.path)||SOURCE_WORKFLOWS.get(live.path)!==live.name||
    live.event!=='push'||live.head_branch!=='main'||live.head_sha!==sha||
    !SHA.test(sha)||live.status!=='completed'||live.conclusion!=='success')
    return null;
  return {repo:REPO,source_run_id:runId,source_attempt:attempt,
    source_path:live.path,target_sha:sha,stage:'post-merge'};
}
export function canonicalTaskId(source,issue,contractDigest){
  return sha256(JSON.stringify([source.repo,source.source_run_id,
    source.source_attempt,source.target_sha,issue,source.stage,contractDigest]));
}
export async function authorizeEventConsumer(inputs,get){
  const runId=strictPositive(inputs.source_run_id,'source run');
  const attempt=strictPositive(inputs.source_attempt,'source attempt');
  const issue=strictPositive(inputs.issue_number,'Issue number');
  const sha=String(inputs.target_sha??'');
  const contract=String(inputs.contract_digest??'');
  const task=String(inputs.task_id??'');
  if(!SHA.test(sha)||!/^[a-f0-9]{64}$/.test(contract)||
    !/^[a-f0-9]{64}$/.test(task))fail('invalid target or contract');
  const sourceRun=await get('/repos/'+REPO+'/actions/runs/'+runId);
  const source=attestDispatchSource(sourceRun,{runId,attempt,sha});
  if(!source)return {authorized:false,reason:'invalid-source'};
  if(source.source_path==='.github/workflows/e2e-full-regression.yml'){
    const jobs=await get('/repos/'+REPO+'/actions/runs/'+runId+
      '/attempts/'+attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100||
      jobs.jobs.filter(j=>j.name==='full'&&j.run_id===runId&&
        j.run_attempt===attempt&&j.status==='completed'&&
        j.conclusion==='success').length!==1)
      return {authorized:false,reason:'full-job-not-executed'};
  }
  const selected=await selectEligibleMergedIssues(source,get);
  const exact=selected.find(i=>i.issue===issue&&i.contract_digest===contract);
  if(!exact)return {authorized:false,reason:'Issue-not-eligible'};
  if(canonicalTaskId(source,issue,contract)!==task)
    return {authorized:false,reason:'invalid-task-identity'};
  return {authorized:true,issue_number:issue,target_sha:sha,task_id:task};
}
async function main(){
  const input={
    source_run_id:process.env.SOURCE_RUN_ID,source_attempt:process.env.SOURCE_ATTEMPT,
    issue_number:process.env.ISSUE_NUMBER,target_sha:process.env.TARGET_SHA,
    contract_digest:process.env.CONTRACT_DIGEST,task_id:process.env.TASK_ID,
  };
  if(process.env.GITHUB_REPOSITORY!==REPO||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    process.env.GITHUB_REF!=='refs/heads/main'||!process.env.GITHUB_OUTPUT||
    !process.env.GITHUB_TOKEN)fail('trusted main workflow_dispatch context required');
  const decision=await authorizeEventConsumer(input,
    path=>githubGet(path,process.env.GITHUB_TOKEN));
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'authorized='+String(decision.authorized)+'\n'+
    (decision.authorized?'issue_number='+decision.issue_number+
      '\ntarget_sha='+decision.target_sha+'\n':''));
  console.log('acceptance-event-consumer: '+(decision.authorized?
    'source and current SC verified':'no eligible matching SC'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(err=>{console.error('acceptance-event-consumer: fail closed');
    process.exitCode=1});
